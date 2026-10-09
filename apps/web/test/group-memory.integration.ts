import { expect, test } from "bun:test";
import { PrismaPg } from "@prisma/adapter-pg";
import { PrismaClient } from "../generated/client";
import { isAppError, type AppError } from "../src/lib/app-error";
import {
  admitMemoryEpisode,
  recordMemoryEpisodeDistillation,
  type MemoryEpisodeAdmission,
} from "../src/server/group-memory/memory-episodes.server";
import {
  createMemoryInsight,
  listActiveMemoryInsights,
  liveMemoryScore,
  mergeMemoryInsights,
  recordMemoryScoreEvent,
  reviseMemoryInsight,
} from "../src/server/group-memory/memory-insights.server";
import {
  collectEpisodeParticipants,
  extractInteractionLinks,
} from "../src/server/group-memory/memory-interactions.server";
import { createTrgmSimilarityIndex } from "../src/server/group-memory/memory-similarity.server";

/**
 * Group Memory substrate value semantics against local PostgreSQL (ADR 0052,
 * slice 1): episode admission idempotency (byte-replay accepted, drift
 * rejected), append-only score events (operation-key replay, drift conflict,
 * chain-summed live score, retirement at <= 0), immutable insight revisions
 * and structurally idempotent merges, lossless Interaction Link extraction
 * (three kinds, window-anchored, idempotent), the trigram similarity seam's
 * skill-only seeds (episode and insight stay out; a retired skill leaves), and the head-pointer +
 * supersedes edge invariants of the LearnedSkill substrate.
 *
 * Runs via `mise run test:memory` with MEMORY_TEST_DATABASE_URL pointing at
 * a scratch database (migrations applied with `prisma migrate deploy`).
 */

let client: PrismaClient | undefined;

function getDb(): PrismaClient {
  if (client) return client;
  const connectionString = Bun.env.MEMORY_TEST_DATABASE_URL;
  if (!connectionString) throw new Error("MEMORY_TEST_DATABASE_URL must point at local PostgreSQL");
  client = new PrismaClient({ adapter: new PrismaPg({ connectionString }) });
  return client;
}

type Setup = {
  db: PrismaClient;
  workspaceId: string;
  conversationId: string;
  addMessages: (bodies: string[]) => Promise<number>;
};

async function setup(): Promise<Setup> {
  const db = getDb();
  const suffix = crypto.randomUUID().slice(0, 8);
  const user = await db.user.create({ data: { username: `gm-owner-${suffix}` } });
  const workspace = await db.workspace.create({
    data: {
      slug: `gm-${suffix}`,
      name: "LearnedSkill Test",
      members: { create: [{ userId: user.id, role: "owner" }] },
    },
  });
  const conversation = await db.conversation.create({
    data: {
      workspaceId: workspace.id,
      channelName: `memory-${suffix}`,
    },
  });
  let sequence = 0;
  const addMessages = async (bodies: string[]) => {
    for (const body of bodies) {
      sequence += 1;
      await db.message.create({
        data: {
          id: crypto.randomUUID(),
          conversationId: conversation.id,
          workspaceId: workspace.id,
          body,
          sequence,
        },
      });
    }
    return sequence;
  };
  return { db, workspaceId: workspace.id, conversationId: conversation.id, addMessages };
}

function episodeInput(
  base: { workspaceId: string; conversationId: string },
  over: Partial<MemoryEpisodeAdmission>,
): MemoryEpisodeAdmission {
  return {
    workspaceId: base.workspaceId,
    conversationId: base.conversationId,
    taskMessageId: null,
    kind: "quiet_window",
    startSequence: 1,
    endSequence: 3,
    body: "alice: let's ship the report\nbob: on it",
    ...over,
  };
}

async function expectRejects(run: () => Promise<unknown>): Promise<void> {
  try {
    await run();
    throw new Error("expected rejection");
  } catch (error) {
    if ((error as Error).message === "expected rejection") throw error;
  }
}

async function expectAppError(
  run: () => Promise<unknown>,
  code: AppError["code"],
  errorId: string,
): Promise<void> {
  try {
    await run();
    throw new Error(`expected AppError ${code}/${errorId}`);
  } catch (error) {
    expect(isAppError(error)).toBe(true);
    const appError = error as AppError;
    expect(appError.code).toBe(code);
    expect(appError.errorId).toBe(errorId);
  }
}

test("episode admission: byte-replay is idempotent, drift under the same window is a conflict", async () => {
  const s = await setup();
  const taskMessageId = crypto.randomUUID();
  const input = episodeInput(s, { kind: "task", taskMessageId });
  const first = await admitMemoryEpisode(s.db, input);
  expect(first.replayed).toBe(false);
  const replay = await admitMemoryEpisode(s.db, input);
  expect(replay.replayed).toBe(true);
  expect(replay.episodeId).toBe(first.episodeId);
  const count = await s.db.memoryEpisode.count({ where: { workspaceId: s.workspaceId } });
  expect(count).toBe(1);

  // Same window key, different content → drift conflict, no second row.
  await expectAppError(
    () =>
      admitMemoryEpisode(s.db, episodeInput(s, { kind: "task", taskMessageId, body: "changed" })),
    "CONFLICT",
    "gm-episode-drift",
  );
  expect(await s.db.memoryEpisode.count({ where: { workspaceId: s.workspaceId } })).toBe(1);

  // Task re-open = a wider window = a NEW episode (immutability, not mutation).
  const reopened = await admitMemoryEpisode(
    s.db,
    episodeInput(s, {
      kind: "task",
      taskMessageId,
      endSequence: 5,
      body: "alice: let's ship\nbob: on it\ncarol: reopened",
    }),
  );
  expect(reopened.replayed).toBe(false);
  expect(reopened.episodeId).not.toBe(first.episodeId);

  // Participant normalization participates in the hash: reordered input replays.
  const participants = [
    { kind: "human" as const, id: crypto.randomUUID(), handle: "alice" },
    { kind: "agent" as const, id: crypto.randomUUID(), handle: "bot" },
  ];
  const a = await admitMemoryEpisode(
    s.db,
    episodeInput(s, { kind: "quiet_window", endSequence: 9, body: "p", participants }),
  );
  const b = await admitMemoryEpisode(
    s.db,
    episodeInput(s, {
      kind: "quiet_window",
      endSequence: 9,
      body: "p",
      participants: [...participants].reverse(),
    }),
  );
  expect(b.replayed).toBe(true);
  expect(b.episodeId).toBe(a.episodeId);
});

test("distillation stamping is idempotent per outcome and refuses to overwrite a different one", async () => {
  const s = await setup();
  const episode = await admitMemoryEpisode(s.db, episodeInput(s, {}));
  await recordMemoryEpisodeDistillation(s.db, {
    episodeId: episode.episodeId,
    outcome: "success",
    outcomeReason: "shipped",
    keySteps: "1) draft 2) review 3) merge",
  });
  await recordMemoryEpisodeDistillation(s.db, {
    episodeId: episode.episodeId,
    outcome: "success",
  });
  await expectAppError(
    () =>
      recordMemoryEpisodeDistillation(s.db, { episodeId: episode.episodeId, outcome: "failure" }),
    "CONFLICT",
    "gm-episode-outcome",
  );
});

test("score events: operation-key replay, drift conflict, chain-summed live score, retirement", async () => {
  const s = await setup();
  const { insightId } = await createMemoryInsight(s.db, {
    workspaceId: s.workspaceId,
    statement:
      "Always rerun the formatter before review, because hand-formatted diffs waste a review round",
    initialScore: 2,
  });
  const event = await recordMemoryScoreEvent(s.db, {
    workspaceId: s.workspaceId,
    insightId,
    delta: 1,
    reason: "task_success",
    operationKey: "task-1-ok",
  });
  expect(event.replayed).toBe(false);
  const replay = await recordMemoryScoreEvent(s.db, {
    workspaceId: s.workspaceId,
    insightId,
    delta: 1,
    reason: "task_success",
    operationKey: "task-1-ok",
  });
  expect(replay.replayed).toBe(true);
  await expectAppError(
    () =>
      recordMemoryScoreEvent(s.db, {
        workspaceId: s.workspaceId,
        insightId,
        delta: -3,
        reason: "task_failure",
        operationKey: "task-1-ok",
      }),
    "CONFLICT",
    "gm-score-drift",
  );
  expect(await liveMemoryScore(s.db, { workspaceId: s.workspaceId, insightId })).toBe(3);

  // Retire: score <= 0 excludes the head from the active list.
  await recordMemoryScoreEvent(s.db, {
    workspaceId: s.workspaceId,
    insightId,
    delta: -3,
    reason: "critique_remove",
    operationKey: "retire-1",
  });
  expect(await liveMemoryScore(s.db, { workspaceId: s.workspaceId, insightId })).toBe(0);
  expect(await listActiveMemoryInsights(s.db, { workspaceId: s.workspaceId })).toEqual([]);
});

test("insight revisions and merges are immutable and structurally idempotent", async () => {
  const s = await setup();
  const episodeA = await admitMemoryEpisode(s.db, episodeInput(s, { endSequence: 4, body: "a" }));
  const { insightId: a } = await createMemoryInsight(s.db, {
    workspaceId: s.workspaceId,
    statement: "Rule A v1",
    episodeLinks: [{ episodeId: episodeA.episodeId, polarity: "positive" }],
  });
  const { insightId: b } = await createMemoryInsight(s.db, {
    workspaceId: s.workspaceId,
    statement: "Rule B",
  });

  const { revisionId } = await reviseMemoryInsight(s.db, {
    workspaceId: s.workspaceId,
    insightId: a,
    statement: "Rule A v2",
  });
  expect(revisionId).not.toBe(a);
  // Old head is superseded; links carried forward onto the new head.
  const oldRow = await s.db.memoryInsight.findUniqueOrThrow({ where: { id: a } });
  expect(oldRow.supersededById).toBe(revisionId);
  expect(await s.db.memoryInsightEpisodeLink.count({ where: { insightId: revisionId } })).toBe(1);
  // Revising a non-head row is a conflict.
  await expectAppError(
    () => reviseMemoryInsight(s.db, { workspaceId: s.workspaceId, insightId: a, statement: "x" }),
    "CONFLICT",
    "gm-insight-not-head",
  );

  const merged = await mergeMemoryInsights(s.db, {
    workspaceId: s.workspaceId,
    survivorId: revisionId,
    absorbedIds: [b],
    statement: "Rule A v3 (merged with B)",
  });
  expect(merged.revisionId).not.toBe(revisionId);
  // Pure replay: absorbing an already-merged chain is a no-op.
  const replay = await mergeMemoryInsights(s.db, {
    workspaceId: s.workspaceId,
    survivorId: merged.revisionId,
    absorbedIds: [b],
    statement: "Rule A v3 (merged with B)",
  });
  expect(replay.revisionId).toBe(merged.revisionId);
  // Replay with a different statement is drift.
  await expectAppError(
    () =>
      mergeMemoryInsights(s.db, {
        workspaceId: s.workspaceId,
        survivorId: merged.revisionId,
        absorbedIds: [b],
        statement: "different",
      }),
    "CONFLICT",
    "gm-merge-replay-drift",
  );
});

test("interaction link extraction: three kinds, window anchor, idempotent replay", async () => {
  const s = await setup();
  const db = s.db;
  const user = await db.user.create({
    data: { username: `gm-u2-${crypto.randomUUID().slice(0, 6)}` },
  });
  const agentOwner = await db.user.findFirstOrThrow({
    where: { username: { startsWith: "gm-owner-" } },
    orderBy: { createdAt: "asc" },
  });
  const ownerMember = await db.conversationMember.create({
    data: { conversationId: s.conversationId, workspaceId: s.workspaceId, userId: agentOwner.id },
  });
  const mentionedMember = await db.conversationMember.create({
    data: { conversationId: s.conversationId, workspaceId: s.workspaceId, userId: user.id },
  });

  // seq 1: plain root; seq 2: reply to seq1 (responds_to); seq 3: mentions member.
  const rootId = crypto.randomUUID();
  await db.message.create({
    data: {
      id: rootId,
      conversationId: s.conversationId,
      workspaceId: s.workspaceId,
      body: "root message",
      sequence: 1,
      senderMemberId: ownerMember.id,
    },
  });
  const replyId = crypto.randomUUID();
  await db.message.create({
    data: {
      id: replyId,
      conversationId: s.conversationId,
      workspaceId: s.workspaceId,
      body: "a reply",
      sequence: 2,
      threadRootId: null,
      senderMemberId: ownerMember.id,
    },
  });
  // point the reply at the root message
  const rootMsg = await db.message.findFirstOrThrow({
    where: { conversationId: s.conversationId, sequence: 1 },
  });
  await db.message.update({ where: { id: replyId }, data: { threadRootId: rootMsg.id } });
  const mentionMsgId = crypto.randomUUID();
  await db.message.create({
    data: {
      id: mentionMsgId,
      conversationId: s.conversationId,
      workspaceId: s.workspaceId,
      body: "ping <@human:x>",
      sequence: 3,
      senderMemberId: ownerMember.id,
    },
  });
  await db.messageMention.create({
    data: {
      messageId: mentionMsgId,
      memberId: mentionedMember.id,
      conversationId: s.conversationId,
      workspaceId: s.workspaceId,
      kind: "user",
      actorId: user.id,
      handle: user.username,
    },
  });
  // seq 4: task created by owner, assigned to mentioned member → delegates_to.
  const taskMsgId = crypto.randomUUID();
  await db.message.create({
    data: {
      id: taskMsgId,
      conversationId: s.conversationId,
      workspaceId: s.workspaceId,
      body: "task",
      sequence: 4,
      senderMemberId: ownerMember.id,
    },
  });
  await db.task.create({
    data: {
      messageId: taskMsgId,
      conversationId: s.conversationId,
      workspaceId: s.workspaceId,
      number: 1,
      title: "do it",
      creatorMemberId: ownerMember.id,
      ownerMemberId: mentionedMember.id,
    },
  });

  const first = await extractInteractionLinks(db, {
    workspaceId: s.workspaceId,
    conversationId: s.conversationId,
    startSequence: 2,
    endSequence: 4,
  });
  expect(first.inserted).toBe(3);
  const kinds = await db.memoryInteractionLink.findMany({
    where: { workspaceId: s.workspaceId },
    select: { kind: true, targetKey: true },
  });
  expect(kinds.map((k) => k.kind).sort()).toEqual(["delegates_to", "mentions", "responds_to"]);
  expect(kinds.find((k) => k.kind === "responds_to")?.targetKey).toBe(`message:${rootMsg.id}`);

  // Replay: idempotent.
  const replay = await extractInteractionLinks(db, {
    workspaceId: s.workspaceId,
    conversationId: s.conversationId,
    startSequence: 2,
    endSequence: 4,
  });
  expect(replay.inserted).toBe(0);

  const participants = await collectEpisodeParticipants(db, {
    conversationId: s.conversationId,
    startSequence: 1,
    endSequence: 4,
  });
  expect(participants.length).toBeGreaterThanOrEqual(1);
});

test("similarity seam: seeds active skill heads only; episode, insight, and retired skills stay out", async () => {
  const s = await setup();
  const db = s.db;
  const index = createTrgmSimilarityIndex(db);

  const needle = "flaky rerun quarantine spreadsheet ingestion";
  await admitMemoryEpisode(
    s.db,
    episodeInput(s, {
      endSequence: 20,
      body: `we should rerun flaky tests once then quarantine them ${needle}`,
    }),
  );
  const { insightId: retired } = await createMemoryInsight(s.db, {
    workspaceId: s.workspaceId,
    statement: `quarantine flaky ${needle} rule`,
    initialScore: 1,
  });
  await recordMemoryScoreEvent(db, {
    workspaceId: s.workspaceId,
    insightId: retired,
    delta: -1,
    reason: "critique_remove",
    operationKey: "retire-sim",
  });
  const { insightId: live } = await createMemoryInsight(s.db, {
    workspaceId: s.workspaceId,
    statement: `always rerun flaky suites once because ${needle} noise lies`,
  });

  const skill = await db.learnedSkill.create({
    data: {
      workspaceId: s.workspaceId,
      key: "rerun-flaky",
      name: "Rerun flaky suites once",
      kind: "step_guidance",
    },
  });
  const revision = await db.learnedSkillRevision.create({
    data: {
      workspaceId: s.workspaceId,
      skillId: skill.id,
      version: 1,
      body: { branches: [] },
      contentDigest: "sha256:" + "a".repeat(64),
      searchText: `when a ${needle} appears rerun once then quarantine`,
      state: "active",
    },
  });
  await db.learnedSkill.update({
    where: { id: skill.id },
    data: { currentRevisionId: revision.id },
  });

  const seeds = await index.findSeeds(s.workspaceId, needle, 20);
  const kinds = seeds.map((seed) => seed.kind);
  expect(kinds).toContain("skill");
  expect(kinds).not.toContain("episode");
  expect(kinds).not.toContain("insight");
  expect(seeds.map((seed) => seed.id)).toContain(revision.id);
  expect(seeds.map((seed) => seed.id)).not.toContain(live);
  expect(seeds.map((seed) => seed.id)).not.toContain(retired);

  // Retire the skill head: it leaves the seed set.
  await db.learnedSkillRevision.update({ where: { id: revision.id }, data: { state: "retired" } });
  await db.learnedSkill.update({ where: { id: skill.id }, data: { currentRevisionId: null } });
  const after = await index.findSeeds(s.workspaceId, needle, 20);
  expect(after.map((seed) => seed.id)).not.toContain(revision.id);
  expect(after.map((seed) => seed.kind)).not.toContain("skill");

  // Empty query seeds nothing; limit is validated.
  expect(await index.findSeeds(s.workspaceId, "  ", 5)).toEqual([]);
});

test("skill substrate: version uniqueness, supersedes edge, and head-pointer invariants", async () => {
  const s = await setup();
  const db = s.db;
  const skill = await db.learnedSkill.create({
    data: { workspaceId: s.workspaceId, key: "alpha", name: "Alpha", kind: "procedure" },
  });
  const v1 = await db.learnedSkillRevision.create({
    data: {
      workspaceId: s.workspaceId,
      skillId: skill.id,
      version: 1,
      body: { instructions: ["do"] },
      contentDigest: "sha256:" + "1".repeat(64),
    },
  });
  const v2 = await db.learnedSkillRevision.create({
    data: {
      workspaceId: s.workspaceId,
      skillId: skill.id,
      version: 2,
      body: { instructions: ["do", "verify"] },
      contentDigest: "sha256:" + "2".repeat(64),
      parentRevisionId: v1.id,
    },
  });
  await db.learnedSkill.update({ where: { id: skill.id }, data: { currentRevisionId: v2.id } });

  // Version is unique per lineage.
  await expectRejects(() =>
    db.learnedSkillRevision.create({
      data: {
        workspaceId: s.workspaceId,
        skillId: skill.id,
        version: 2,
        body: {},
        contentDigest: "x",
      },
    }),
  );

  // Supersedes edge is queryable from both ends.
  const child = await db.learnedSkillRevision.findUniqueOrThrow({
    where: { id: v2.id },
    include: { parent: true, headOf: true },
  });
  expect(child.parent?.id).toBe(v1.id);
  expect(child.headOf?.id).toBe(skill.id);

  // Head pointer is unique: a second lineage cannot point at v2.
  const skill2 = await db.learnedSkill.create({
    data: { workspaceId: s.workspaceId, key: "beta", name: "Beta", kind: "step_guidance" },
  });
  await expectRejects(() =>
    db.learnedSkill.update({ where: { id: skill2.id }, data: { currentRevisionId: v2.id } }),
  );
});
