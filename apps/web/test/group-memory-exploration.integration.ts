import { expect, test } from "bun:test";
import { PrismaPg } from "@prisma/adapter-pg";
import { PrismaClient } from "../generated/client";
import { isAppError, type AppError } from "../src/lib/app-error";
import { admitMemoryEpisode } from "../src/server/group-memory/memory-episodes.server";
import {
  createMemoryInsight,
  linkMemoryEpisodesToInsight,
} from "../src/server/group-memory/memory-insights.server";
import { extractInteractionLinks } from "../src/server/group-memory/memory-interactions.server";
import { enableGroupMemory } from "../src/server/group-memory/memory-agent.server";
import { submitAndAdmitSkillProposal } from "../src/server/group-memory/skill-proposals.server";
import { RETIRED_FROM_MEMORY_DISCOVERY } from "../src/server/group-memory/memory-discovery-eligibility";
import {
  closeMemoryExploration,
  exploreMemoryStep,
  redirectMemoryStep,
  startMemoryExploration,
} from "../src/server/group-memory/memory-exploration.server";

/**
 * Bounded Memory Exploration (ADR 0052-E/I, Q160-B): the designation fence,
 * start replay-vs-drift, skill lineage hops, refusal of episode/insight
 * anchors and of the related/collaborators relations, step budgets,
 * close-time citation grounding, and the per-operation idempotency ledger.
 */

let client: PrismaClient | undefined;

function getDb(): PrismaClient {
  if (client) return client;
  const connectionString = Bun.env.MEMORY_TEST_DATABASE_URL;
  if (!connectionString) throw new Error("MEMORY_TEST_DATABASE_URL must point at local PostgreSQL");
  client = new PrismaClient({ adapter: new PrismaPg({ connectionString }) });
  return client;
}

async function expectAppError(run: () => Promise<unknown>, errorId: string): Promise<void> {
  try {
    await run();
    throw new Error(`expected AppError ${errorId}`);
  } catch (error) {
    expect(isAppError(error)).toBe(true);
    expect((error as AppError).errorId).toBe(errorId);
  }
}

type Setup = {
  db: PrismaClient;
  workspaceId: string;
  memoryAgentId: string;
  channelId: string;
  otherChannelId: string;
  collaboratorMemberId: (conversationId: string) => Promise<string>;
  addEpisode: (conversationId: string, body: string) => Promise<string>;
};

async function setup(): Promise<Setup> {
  const db = getDb();
  const suffix = crypto.randomUUID().slice(0, 8);
  const user = await db.user.create({ data: { username: `ex-owner-${suffix}` } });
  const workspace = await db.workspace.create({
    data: {
      slug: `ex-${suffix}`,
      name: "Exploration Test",
      members: { create: [{ userId: user.id, role: "owner" }] },
    },
  });
  const enabled = await enableGroupMemory(db, { workspaceId: workspace.id, ownerId: user.id });
  const channel = await db.conversation.create({
    data: { workspaceId: workspace.id, channelName: `alpha-${suffix}` },
  });
  const otherChannel = await db.conversation.create({
    data: { workspaceId: workspace.id, channelName: `beta-${suffix}` },
  });
  const collaboratorUser = await db.user.create({ data: { username: `ex-collab-${suffix}` } });
  const collaboratorMemberId = async (conversationId: string) => {
    const existing = await db.conversationMember.findFirst({
      where: { conversationId, workspaceId: workspace.id, userId: collaboratorUser.id },
      select: { id: true },
    });
    if (existing) return existing.id;
    const member = await db.conversationMember.create({
      data: { conversationId, workspaceId: workspace.id, userId: collaboratorUser.id },
    });
    return member.id;
  };
  let sequences = new Map<string, number>();
  const addEpisode = async (conversationId: string, body: string) => {
    const start = (sequences.get(conversationId) ?? 0) + 1;
    sequences.set(conversationId, start + 2);
    const admitted = await admitMemoryEpisode(db, {
      workspaceId: workspace.id,
      conversationId,
      kind: "quiet_window",
      startSequence: start,
      endSequence: start + 2,
      title: body.slice(0, 40),
      body,
    });
    return admitted.episodeId;
  };
  return {
    db,
    workspaceId: workspace.id,
    memoryAgentId: enabled.agentId,
    channelId: channel.id,
    otherChannelId: otherChannel.id,
    collaboratorMemberId,
    addEpisode,
  };
}
void ({} as Setup | undefined);

test("exploration fence: ordinary Agents cannot query Group Memory", async () => {
  const s = await setup();
  const ordinary = await s.db.agent.create({
    data: {
      workspaceId: s.workspaceId,
      ownerId: (
        await s.db.user.findFirstOrThrow({ where: { username: { startsWith: "ex-owner-" } } })
      ).id,
      name: `ordinary-${crypto.randomUUID().slice(0, 6)}`,
      displayName: "Ordinary",
      runtimeConfig: {},
    },
  });
  await expectAppError(
    () =>
      startMemoryExploration(s.db, {
        workspaceId: s.workspaceId,
        agentId: ordinary.id,
        startKey: "fence-1",
        query: "anything",
      }),
    "gm-memory-explorer-only",
  );
});

test("start is idempotent by start key; drift under the same key is a conflict", async () => {
  const s = await setup();
  await s.addEpisode(
    s.channelId,
    "we always rerun the flaky database migration check before shipping releases",
  );
  const base = {
    workspaceId: s.workspaceId,
    agentId: s.memoryAgentId,
    startKey: "start-1",
    query: "flaky migration check before shipping",
  };
  const first = await startMemoryExploration(s.db, base);
  expect(first.items.some((item) => item.kind === "episode" || item.kind === "insight")).toBe(
    false,
  );
  const replay = await startMemoryExploration(s.db, base);
  expect(replay.sessionId).toBe(first.sessionId);
  expect(replay.items.length).toBe(first.items.length);
  await expectAppError(
    () => startMemoryExploration(s.db, { ...base, query: "a different query entirely" }),
    "gm-exploration-start-drift",
  );
});

test("public expansion refuses episode and insight anchors and still walks skill lineage", async () => {
  const s = await setup();
  const episodeId = await s.addEpisode(
    s.channelId,
    "the release broke because migrations were skipped before the deploy, we rolled back and ran them",
  );
  const { insightId } = await createMemoryInsight(s.db, {
    workspaceId: s.workspaceId,
    statement: "Run migrations before deploys, because skipped migrations break the release",
  });
  await linkMemoryEpisodesToInsight(s.db, {
    workspaceId: s.workspaceId,
    insightId,
    links: [{ episodeId, polarity: "positive" }],
  });
  const bound = await submitAndAdmitSkillProposal(s.db, {
    workspaceId: s.workspaceId,
    draft: {
      action: "create",
      key: "deploy-migrations",
      name: "Deploy with migrations",
      kind: "step_guidance",
      body: {
        causal_context: {
          facts: [{ fact_id: "f1", statement: "Skipped migrations break releases" }],
        },
        branches: [
          {
            branch_id: "b1",
            when: { explanation: "a deploy touches the schema" },
            action: {
              instructions: ["Run migrations first"],
              rationale: "state drift breaks releases",
            },
            future: { disposition: "success", critical_steps: ["migrate", "deploy"] },
          },
        ],
      },
      groundingEpisodes: [episodeId],
      groundingInsights: [insightId],
    },
  });
  expect(bound.outcome).toBe("bound");
  if (bound.outcome !== "bound") return;
  const revised = await submitAndAdmitSkillProposal(s.db, {
    workspaceId: s.workspaceId,
    draft: {
      action: "revise",
      targetSkillKey: "deploy-migrations",
      body: {
        causal_context: {
          facts: [{ fact_id: "f1", statement: "Skipped migrations break releases" }],
        },
        branches: [
          {
            branch_id: "b1",
            when: { explanation: "a deploy touches the schema" },
            action: {
              instructions: ["Run migrations first", "Verify the schema"],
              rationale: "state drift breaks releases",
            },
            future: { disposition: "success", critical_steps: ["migrate", "verify", "deploy"] },
          },
        ],
      },
      groundingEpisodes: [episodeId],
      groundingInsights: [insightId],
    },
  });
  expect(revised.outcome).toBe("bound");

  const headRevisionId = revised.outcome === "bound" ? revised.revisionId : bound.revisionId;
  const start = await startMemoryExploration(s.db, {
    workspaceId: s.workspaceId,
    agentId: s.memoryAgentId,
    startKey: "cross-1",
    query: "Deploy with migrations",
    maxResults: 5,
  });
  expect(start.items.length).toBeGreaterThan(0);
  expect(start.items.every((item) => item.kind === "skill")).toBe(true);
  expect(start.items.map((item) => item.id)).toContain(headRevisionId);

  await expectAppError(
    () =>
      exploreMemoryStep(s.db, {
        workspaceId: s.workspaceId,
        agentId: s.memoryAgentId,
        sessionId: start.sessionId,
        operationId: "op-related",
        anchor: `episode:${episodeId}`,
        relation: "related",
      }),
    RETIRED_FROM_MEMORY_DISCOVERY,
  );
  await expectAppError(
    () =>
      exploreMemoryStep(s.db, {
        workspaceId: s.workspaceId,
        agentId: s.memoryAgentId,
        sessionId: start.sessionId,
        operationId: "op-insight",
        anchor: `insight:${insightId}`,
        relation: "skills",
      }),
    RETIRED_FROM_MEMORY_DISCOVERY,
  );

  await exploreMemoryStep(s.db, {
    workspaceId: s.workspaceId,
    agentId: s.memoryAgentId,
    sessionId: start.sessionId,
    operationId: "op-lineage",
    anchor: `skill:${headRevisionId}`,
    relation: "skills",
  });
  const served = await s.db.memoryExplorationCitation.findMany({
    where: { sessionId: start.sessionId },
    select: { kind: true, targetId: true },
  });
  expect(served.some((row) => row.kind === "episode" || row.kind === "insight")).toBe(false);
  expect(served.filter((row) => row.kind === "skill").map((row) => row.targetId)).toContain(
    bound.revisionId,
  );
});

test("expansion crosses channels by participant identity (collaborators)", async () => {
  const s = await setup();
  // Channel A: owner + collaborator discuss backups (interacting).
  const seqA1 = crypto.randomUUID();
  const collabMemberA = await s.collaboratorMemberId(s.channelId);
  const ownerMember = await s.db.conversationMember.findFirstOrThrow({
    where: { conversationId: s.channelId, workspaceId: s.workspaceId, userId: undefined },
  });
  const a1 = await s.db.message.create({
    data: {
      id: seqA1,
      conversationId: s.channelId,
      workspaceId: s.workspaceId,
      body: "who owns the backup routine?",
      sequence: 100,
      senderMemberId: ownerMember.id,
    },
  });
  const a2 = await s.db.message.create({
    data: {
      conversationId: s.channelId,
      workspaceId: s.workspaceId,
      body: `@collab handles it`,
      sequence: 101,
      senderMemberId: ownerMember.id,
    },
  });
  await s.db.messageMention.create({
    data: {
      messageId: a2.id,
      memberId: collabMemberA,
      conversationId: s.channelId,
      workspaceId: s.workspaceId,
      kind: "user",
      actorId: collabMemberA,
      handle: "collab",
    },
  });
  await extractInteractionLinks(s.db, {
    workspaceId: s.workspaceId,
    conversationId: s.channelId,
    startSequence: 100,
    endSequence: 101,
  });
  const episodeA = await admitMemoryEpisode(s.db, {
    workspaceId: s.workspaceId,
    conversationId: s.channelId,
    kind: "quiet_window",
    startSequence: 100,
    endSequence: 101,
    title: "backup ownership talk",
    body: "who owns the backup routine? @collab handles it",
  });
  void a1;

  // Channel B: the collaborator ships a database backup run-through — same
  // human, different channel; per-channel member ids can never connect them.
  const collabMemberB = await s.collaboratorMemberId(s.otherChannelId);
  await s.db.message.create({
    data: {
      conversationId: s.otherChannelId,
      workspaceId: s.workspaceId,
      body: "the run-through finished and the cadence is set",
      sequence: 200,
      senderMemberId: collabMemberB,
    },
  });
  const episodeB = await admitMemoryEpisode(s.db, {
    workspaceId: s.workspaceId,
    conversationId: s.otherChannelId,
    kind: "quiet_window",
    startSequence: 200,
    endSequence: 200,
    title: "backup run-through",
    body: "the run-through finished and the cadence is set",
  });

  const start = await startMemoryExploration(s.db, {
    workspaceId: s.workspaceId,
    agentId: s.memoryAgentId,
    startKey: "collab-1",
    query: "who owns the backup routine question",
    maxResults: 5,
  });
  await expectAppError(
    () =>
      exploreMemoryStep(s.db, {
        workspaceId: s.workspaceId,
        agentId: s.memoryAgentId,
        sessionId: start.sessionId,
        operationId: "op-collab",
        anchor: `episode:${episodeA.episodeId}`,
        relation: "collaborators",
      }),
    RETIRED_FROM_MEMORY_DISCOVERY,
  );
  expect(await s.db.memoryEpisode.findUnique({ where: { id: episodeB.episodeId } })).toBeTruthy();
});

test("budgets bound the session and the close must cite only what was served", async () => {
  const s = await setup();
  const needle = "quarterly key rotation cadence";
  const skill = await s.db.learnedSkill.create({
    data: {
      workspaceId: s.workspaceId,
      key: "key-rotation",
      name: "Quarterly key rotation",
      kind: "procedure",
    },
  });
  const revision = await s.db.learnedSkillRevision.create({
    data: {
      workspaceId: s.workspaceId,
      skillId: skill.id,
      version: 1,
      body: { instructions: ["Rotate the quarterly keys"] },
      contentDigest: "sha256:" + "b".repeat(64),
      searchText: needle,
      state: "active",
    },
  });
  await s.db.learnedSkill.update({
    where: { id: skill.id },
    data: { currentRevisionId: revision.id },
  });
  const citationId = `skill:${revision.id}`;
  const start = await startMemoryExploration(s.db, {
    workspaceId: s.workspaceId,
    agentId: s.memoryAgentId,
    startKey: "budget-1",
    query: needle,
    maxSteps: 1,
  });
  expect(start.items.map((item) => item.citationId)).toContain(citationId);
  expect(start.items.some((item) => item.kind === "episode" || item.kind === "insight")).toBe(
    false,
  );
  await exploreMemoryStep(s.db, {
    workspaceId: s.workspaceId,
    agentId: s.memoryAgentId,
    sessionId: start.sessionId,
    operationId: "op-1",
    anchor: citationId,
  });
  await expectAppError(
    () =>
      exploreMemoryStep(s.db, {
        workspaceId: s.workspaceId,
        agentId: s.memoryAgentId,
        sessionId: start.sessionId,
        operationId: "op-2",
        anchor: citationId,
      }),
    "gm-exploration-steps-exhausted",
  );

  // Close grounding: an unserved citation is refused.
  await expectAppError(
    () =>
      closeMemoryExploration(s.db, {
        workspaceId: s.workspaceId,
        agentId: s.memoryAgentId,
        sessionId: start.sessionId,
        operationId: "close-1",
        found: true,
        summary: "found it",
        citationIds: [`skill:${crypto.randomUUID()}`],
      }),
    "gm-exploration-citation-unserved",
  );
  const closed = await closeMemoryExploration(s.db, {
    workspaceId: s.workspaceId,
    agentId: s.memoryAgentId,
    sessionId: start.sessionId,
    operationId: "close-1",
    found: true,
    summary: "found it",
    citationIds: [citationId],
  });
  expect(closed.state).toBe("closed");

  // Operation replay after close returns the recorded response.
  const replay = await closeMemoryExploration(s.db, {
    workspaceId: s.workspaceId,
    agentId: s.memoryAgentId,
    sessionId: start.sessionId,
    operationId: "close-1",
    found: true,
    summary: "found it",
    citationIds: [citationId],
  });
  expect(replay.duplicate).toBe(true);

  // Redirect exists as a mid-session re-seed.
  const fresh = await startMemoryExploration(s.db, {
    workspaceId: s.workspaceId,
    agentId: s.memoryAgentId,
    startKey: "budget-2",
    query: "key rotation cadence",
  });
  const redirected = await redirectMemoryStep(s.db, {
    workspaceId: s.workspaceId,
    agentId: s.memoryAgentId,
    sessionId: fresh.sessionId,
    operationId: "redir-1",
    query: "rotation cadence quarterly keys",
  });
  expect(redirected.state).toBe("active");
  expect(redirected.items.some((item) => item.kind === "episode" || item.kind === "insight")).toBe(
    false,
  );
});
