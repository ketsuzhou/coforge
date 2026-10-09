import type { PrismaClient } from "../generated/client";
import {
  admitMemoryEpisode,
  type EpisodeParticipant,
} from "../src/server/group-memory/memory-episodes.server";
import {
  createMemoryInsight,
  reviseMemoryInsight,
} from "../src/server/group-memory/memory-insights.server";
import { extractInteractionLinks } from "../src/server/group-memory/memory-interactions.server";
import { enableGroupMemory } from "../src/server/group-memory/memory-agent.server";
import { submitAndAdmitSkillProposal } from "../src/server/group-memory/skill-proposals.server";
import {
  closeMemoryExploration,
  exploreMemoryStep,
  startMemoryExploration,
} from "../src/server/group-memory/memory-exploration.server";
import {
  publishMemoryOffer,
  type MemoryOfferTarget,
} from "../src/server/group-memory/memory-offer.server";

/**
 * Memory Scenarios (ADR 0053): marker-seeded teaching timelines materialized
 * through the real pipeline, with fixture-controlled distillation content.
 * The retrieval machinery (trigram seam, provenance edges, exploration
 * protocol, offer discipline) runs for real; the LLM's judgment is out of
 * scope here by design — that is the value layer's business.
 *
 * Markers are unique tokens (mk-…) embedded in the teaching episode, the
 * distilled insight, and — when a probe should recall — the skill search
 * text. New offers cite skill revisions only.
 */

export type ScenarioChannel = "main" | "other";

export type ScenarioTeaching = {
  channel: ScenarioChannel;
  /** Sent by the worker agent when true (creates cross-channel identity); else the human. */
  fromWorker?: boolean;
  /** A member id mentioned in the body (structure: the mention row is real). */
  mentionsWorkerIn?: ScenarioChannel;
  body: string;
  marker: string;
};

export type ScenarioInsight = {
  statement: string;
  marker: string;
  /** Episode markers this insight is linked from (positive polarity). */
  fromMarkers: string[];
  /** S2: a revision replaces this insight; statement/marker are the NEW ones. */
  revises?: string;
};

export type ScenarioSkill = {
  key: string;
  name: string;
  kind: "step_guidance" | "procedure";
  body: unknown;
  groundedOnMarkers: string[];
  groundedOnInsightMarker?: string;
};

export type ScenarioProbeExpect = {
  /** Markers that must show up in newly served citations. */
  markers: string[];
  /** Public discovery layers the citations must cover. Episode and insight are not served. */
  layers: Array<"episode" | "insight" | "skill">;
};

export type ScenarioProbe =
  | {
      kind: "explicit";
      key: string;
      query: string;
      expect: ScenarioProbeExpect;
      relation?: "similar" | "related" | "collaborators" | "skills";
    }
  | { kind: "implicit"; key: string; query: string; expect: ScenarioProbeExpect }
  | { kind: "negative"; key: string; query: string; neverMarkers: string[] };

export type MemoryScenario = {
  key: string;
  purpose: string;
  teach: ScenarioTeaching[];
  insights: ScenarioInsight[];
  /** Human says don't record this: the transcript may snapshot it, no distilled layer may carry it. */
  decoy?: { channel: ScenarioChannel; body: string; decoyMarker: string };
  skill?: ScenarioSkill;
  probes: ScenarioProbe[];
};

const marker = (name: string) => `mk-${name}-${crypto.randomUUID().slice(0, 6)}`;

function freshMarkers<T extends Record<string, string>>(names: string[]): T {
  return Object.fromEntries(names.map((name) => [name, marker(name)])) as T;
}

export function buildScenarioOne(): MemoryScenario {
  const m = freshMarkers<Record<"rotate" | "decoy" | "never", string>>([
    "rotate",
    "decoy",
    "never",
  ]);
  return {
    key: "s1-single-fact",
    purpose: "teach one fact, probe explicit and negative",
    teach: [
      {
        channel: "main",
        body: `Ops note: production database credentials rotate every 14 days on Wednesdays — the rotation runbook is ops/runbooks/db-rotation.md (${m.rotate}).`,
        marker: m.rotate,
      },
    ],
    insights: [
      {
        statement: `Rotate production database credentials every 14 days before the quarterly audit, because stale credentials fail it (${m.rotate})`,
        marker: m.rotate,
        fromMarkers: [m.rotate],
      },
    ],
    decoy: {
      channel: "main",
      body: `Off the record, please don't record this anywhere: the staging admin password is hunter2-${m.decoy}.`,
      decoyMarker: m.decoy,
    },
    skill: {
      key: "rotate-db-credentials",
      name: `Rotate credentials ${m.rotate}`,
      kind: "step_guidance",
      body: {
        causal_context: {
          facts: [
            {
              fact_id: "f1",
              statement: "how often do the production database credentials rotate before the audit",
            },
          ],
        },
        branches: [
          {
            branch_id: "b1",
            when: { explanation: "how often do credentials rotate before the audit" },
            action: {
              instructions: [
                "database credential rotation cadence audit",
                "Rotate production database credentials every 14 days before the quarterly audit",
              ],
              rationale: "stale credentials fail the audit",
            },
            future: { disposition: "success", critical_steps: ["rotate", "audit"] },
          },
        ],
      },
      groundedOnMarkers: [m.rotate],
      groundedOnInsightMarker: m.rotate,
    },
    probes: [
      {
        kind: "explicit",
        key: "s1-explicit",
        query: "how often do the production database credentials rotate before the audit",
        expect: { markers: [m.rotate], layers: ["skill"] },
      },
      {
        kind: "negative",
        key: "s1-negative",
        // Strongly out-of-domain tokens: generic words (won/company/final)
        // can cross the low trigram threshold against real LLM-distilled
        // statements, so the negative probe uses vocabulary guaranteed
        // absent from any collaboration transcript.
        query: "zorblax intergalactic poetry championship 1987 winner",
        neverMarkers: [m.rotate, m.decoy],
      },
    ],
  };
}

export function buildScenarioTwo(): MemoryScenario {
  const m = freshMarkers<Record<"v1" | "v2", string>>(["v1", "v2"]);
  return {
    key: "s2-fact-update",
    purpose: "a fact update stays in native insight storage and leaves public discovery",
    teach: [
      {
        channel: "main",
        body: `Heads up: we scale the staging cluster down to 2 nodes on weekends to save cost (${m.v1}).`,
        marker: m.v1,
      },
      {
        channel: "main",
        body: `Policy change from this month: staging stays at 4 nodes around the clock, weekend scale-down is cancelled (${m.v2}).`,
        marker: m.v2,
      },
    ],
    insights: [
      {
        statement: `Scale staging down to 2 nodes on weekends, because cloud cost dominates (${m.v1})`,
        marker: m.v1,
        fromMarkers: [m.v1],
      },
      {
        statement: `Keep staging at 4 nodes around the clock, because weekend scale-down broke the soak tests (${m.v2})`,
        marker: m.v2,
        fromMarkers: [m.v2],
        revises: m.v1,
      },
    ],
    probes: [
      {
        kind: "explicit",
        key: "s2-explicit",
        query: "how many nodes does the staging cluster run on weekends",
        expect: { markers: [], layers: [] },
      },
    ],
  };
}

export function buildScenarioThree(): MemoryScenario {
  const m = freshMarkers<Record<"deploy" | "fix", string>>(["deploy", "fix"]);
  return {
    key: "s3-cross-channel-skill-chain",
    purpose: "cross-channel collaboration feeds a skill lineage; the chain is walkable",
    teach: [
      {
        channel: "main",
        mentionsWorkerIn: "main",
        body: `Yesterday's deploy broke because the migration never ran before it — @worker can you take the recovery? (${m.deploy})`,
        marker: m.deploy,
      },
      {
        channel: "other",
        fromWorker: true,
        body: `Recovery done: ran the migration first, redeployed in the quiet morning window, audit trail intact. Marking the sequence ${m.fix}.`,
        marker: m.fix,
      },
    ],
    insights: [
      {
        statement: `Run the database migration before every deploy, because skipping it breaks the release (${m.deploy})`,
        marker: m.deploy,
        fromMarkers: [m.deploy],
      },
    ],
    skill: {
      key: "migrate-before-deploy",
      name: "Migrate before deploy",
      kind: "step_guidance",
      body: {
        causal_context: {
          facts: [
            {
              fact_id: "f1",
              statement: `Deploys that skip the migration break the release (${m.deploy})`,
            },
            { fact_id: "f2", statement: `Recovery sequence ${m.fix}` },
          ],
        },
        branches: [
          {
            branch_id: "b1",
            when: { explanation: "a deploy touches the database schema" },
            action: {
              instructions: [
                "what went wrong with the deploy and how was it recovered",
                "the next deploy touches the schema, what is the safe sequence",
                "Run the migration",
                "Deploy in the quiet morning window",
              ],
              rationale: "skipped migrations break releases",
            },
            future: {
              disposition: "success",
              critical_steps: ["migrate", "deploy", "verify audit trail"],
            },
          },
        ],
      },
      groundedOnMarkers: [m.deploy, m.fix],
      groundedOnInsightMarker: m.deploy,
    },
    probes: [
      {
        kind: "explicit",
        key: "s3-explicit",
        query: "what went wrong with the deploy and how was it recovered",
        expect: { markers: [m.deploy], layers: ["skill"] },
        relation: "skills",
      },
      {
        kind: "implicit",
        key: "s3-implicit",
        query: "the next deploy touches the schema, what is the safe sequence",
        expect: { markers: [m.fix, m.deploy], layers: ["skill"] },
      },
    ],
  };
}

/** Workspaces materialized this process; scenario tests clean them up so the
 * shared scratch database never leaks designated channels into other suites'
 * global sweep assertions (the prior-run-leftovers lesson). */
const trackedWorkspaceIds: string[] = [];

export async function cleanupScenarios(db: PrismaClient): Promise<void> {
  for (const workspaceId of trackedWorkspaceIds.splice(0)) {
    await db.workspace.delete({ where: { id: workspaceId } }).catch(() => undefined);
  }
}

export type ScenarioHandles = {
  workspaceId: string;
  memoryAgentId: string;
  channelId: string;
  otherChannelId: string;
  workerAgentId: string;
  /** marker → episode/insight ids and the skill revision id. */
  episodeByMarker: Map<string, string>;
  insightByMarker: Map<string, string>;
  skillRevisionId?: string;
};

export async function materializeScenario(
  db: PrismaClient,
  scenario: MemoryScenario,
): Promise<ScenarioHandles> {
  const suffix = crypto.randomUUID().slice(0, 8);
  const user = await db.user.create({ data: { username: `scn-${scenario.key}-${suffix}` } });
  const workspace = await db.workspace.create({
    data: {
      slug: `scn-${suffix}`,
      name: "Scenario",
      members: { create: [{ userId: user.id, role: "owner" }] },
    },
  });
  const channelId = (
    await db.conversation.create({
      data: { workspaceId: workspace.id, channelName: `main-${suffix}` },
    })
  ).id;
  const otherChannelId = (
    await db.conversation.create({
      data: { workspaceId: workspace.id, channelName: `other-${suffix}` },
    })
  ).id;
  const enabled = await enableGroupMemory(db, { workspaceId: workspace.id, ownerId: user.id });
  const worker = await db.agent.create({
    data: {
      workspaceId: workspace.id,
      ownerId: user.id,
      name: `worker-${suffix}`,
      displayName: "Worker",
      runtimeConfig: {},
    },
    select: { id: true, name: true },
  });

  const memberIds: Record<ScenarioChannel, { human: string; worker?: string }> = {
    main: {
      human: (
        await db.conversationMember.create({
          data: { conversationId: channelId, workspaceId: workspace.id, userId: user.id },
        })
      ).id,
      worker: (
        await db.conversationMember.create({
          data: { conversationId: channelId, workspaceId: workspace.id, agentId: worker.id },
        })
      ).id,
    },
    other: {
      human: (
        await db.conversationMember.create({
          data: { conversationId: otherChannelId, workspaceId: workspace.id, userId: user.id },
        })
      ).id,
      worker: (
        await db.conversationMember.create({
          data: { conversationId: otherChannelId, workspaceId: workspace.id, agentId: worker.id },
        })
      ).id,
    },
  };

  const participantsFor = (channel: ScenarioChannel): EpisodeParticipant[] => {
    const list: EpisodeParticipant[] = [{ kind: "human", id: user.id, handle: user.username }];
    if (channel === "other") list.push({ kind: "agent", id: worker.id, handle: worker.name });
    return list;
  };

  const episodeByMarker = new Map<string, string>();
  let seq = 0;
  for (const item of scenario.teach) {
    const conversationId = item.channel === "main" ? channelId : otherChannelId;
    seq += 1;
    const message = await db.message.create({
      data: {
        conversationId,
        workspaceId: workspace.id,
        senderMemberId: item.fromWorker
          ? memberIds[item.channel].worker!
          : memberIds[item.channel].human,
        body: item.body,
        sequence: seq,
      },
      select: { id: true },
    });
    if (item.mentionsWorkerIn) {
      await db.messageMention.create({
        data: {
          messageId: message.id,
          memberId: memberIds[item.mentionsWorkerIn].worker!,
          conversationId,
          workspaceId: workspace.id,
          kind: "agent",
          actorId: worker.id,
          handle: worker.name,
        },
      });
      await extractInteractionLinks(db, {
        workspaceId: workspace.id,
        conversationId,
        startSequence: seq,
        endSequence: seq,
      });
    }
    const admitted = await admitMemoryEpisode(db, {
      workspaceId: workspace.id,
      conversationId,
      kind: "quiet_window",
      startSequence: seq,
      endSequence: seq,
      title: item.body.slice(0, 50),
      body: item.body,
      participants: participantsFor(item.channel),
    });
    episodeByMarker.set(item.marker, admitted.episodeId);
  }

  if (scenario.decoy) {
    const conversationId = scenario.decoy.channel === "main" ? channelId : otherChannelId;
    seq += 1;
    await db.message.create({
      data: {
        conversationId,
        workspaceId: workspace.id,
        senderMemberId: memberIds[scenario.decoy.channel].human,
        body: scenario.decoy.body,
        sequence: seq,
      },
    });
    // The decoy rides along in the episode transcript snapshot (that is the
    // honest pipeline behavior); no distilled layer references it.
    const prior = [...episodeByMarker.values()].at(-1)!;
    void prior;
    await admitMemoryEpisode(db, {
      workspaceId: workspace.id,
      conversationId,
      kind: "quiet_window",
      startSequence: seq,
      endSequence: seq,
      title: "off-record window",
      body: scenario.decoy.body,
      participants: participantsFor(scenario.decoy.channel),
    });
  }

  const insightByMarker = new Map<string, string>();
  const episodeIdsOf = (markers: string[]) => markers.map((m) => episodeByMarker.get(m)!);
  for (const insight of scenario.insights) {
    if (insight.revises) {
      const { revisionId } = await reviseMemoryInsight(db, {
        workspaceId: workspace.id,
        insightId: insightByMarker.get(insight.revises)!,
        statement: insight.statement,
      });
      insightByMarker.set(insight.marker, revisionId);
      continue;
    }
    const created = await createMemoryInsight(db, {
      workspaceId: workspace.id,
      statement: insight.statement,
      episodeLinks: episodeIdsOf(insight.fromMarkers).map((episodeId) => ({
        episodeId,
        polarity: "positive" as const,
      })),
    });
    insightByMarker.set(insight.marker, created.insightId);
  }

  let skillRevisionId: string | undefined;
  if (scenario.skill) {
    const verdict = await submitAndAdmitSkillProposal(db, {
      workspaceId: workspace.id,
      draft: {
        action: "create",
        key: scenario.skill.key,
        name: scenario.skill.name,
        kind: scenario.skill.kind,
        body: scenario.skill.body,
        groundingEpisodes: episodeIdsOf(scenario.skill.groundedOnMarkers),
        ...(scenario.skill.groundedOnInsightMarker
          ? { groundingInsights: [insightByMarker.get(scenario.skill.groundedOnInsightMarker)!] }
          : {}),
      },
    });
    if (verdict.outcome !== "bound")
      throw new Error(`scenario skill failed to bind: ${verdict.outcome}`);
    skillRevisionId = verdict.revisionId;
  }

  trackedWorkspaceIds.push(workspace.id);
  return {
    workspaceId: workspace.id,
    memoryAgentId: enabled.agentId,
    channelId,
    otherChannelId,
    workerAgentId: worker.id,
    episodeByMarker,
    insightByMarker,
    skillRevisionId,
  };
}

export type ProbeOutcome = {
  sessionId: string;
  servedCitations: Array<{ kind: string; id: string; snippet: string }>;
  offer?:
    | { published: true; messageId: string; targetRefs: string[] }
    | { published: false; suppressed: Array<{ targetRef: string; reason: string }> };
};

/**
 * Run one probe the way the Memory Agent's turn would: explore (start, one
 * expansion step, close), then — for explicit/implicit probes — deliver an
 * offer naming the worker with the cited targets. Negative probes never offer.
 */
export async function runProbe(
  db: PrismaClient,
  handles: ScenarioHandles,
  probe: ScenarioProbe,
): Promise<ProbeOutcome> {
  const base = { workspaceId: handles.workspaceId, agentId: handles.memoryAgentId };
  const start = await startMemoryExploration(db, {
    ...base,
    startKey: probe.key,
    query: probe.query,
    maxSteps: 2,
    maxResults: 10,
  });
  let items = start.items;
  if (items.length > 0) {
    const anchor = items[0]!;
    const step = await exploreMemoryStep(db, {
      ...base,
      sessionId: start.sessionId,
      operationId: `${probe.key}-step-1`,
      anchor: anchor.citationId,
      ...(probe.kind === "explicit" && "relation" in probe && probe.relation
        ? { relation: probe.relation }
        : {}),
    });
    items = [...items, ...step.items];
  }
  await closeMemoryExploration(db, {
    ...base,
    sessionId: start.sessionId,
    operationId: `${probe.key}-close`,
    found: items.length > 0,
    summary: items.length > 0 ? `found ${items.length} citations` : undefined,
    citationIds: items.map((item) => item.citationId).slice(0, 5),
  });

  if (probe.kind === "negative") {
    return { sessionId: start.sessionId, servedCitations: items.map(toCitation) };
  }

  const targets: MemoryOfferTarget[] = [];
  for (const item of items) {
    if (item.kind === "skill") targets.push({ kind: "skill", id: item.id });
  }
  if (targets.length === 0) {
    return {
      sessionId: start.sessionId,
      servedCitations: items.map(toCitation),
      offer: { published: false, suppressed: [] },
    };
  }
  const offer = await publishMemoryOffer(db, {
    workspaceId: handles.workspaceId,
    memoryAgentId: handles.memoryAgentId,
    conversationId: handles.channelId,
    targetAgentId: handles.workerAgentId,
    targets,
    body: `@worker memory finds: ${items.map((item) => item.snippet.slice(0, 120)).join(" | ")}`,
    operationKey: `${probe.key}-offer`,
    ...(probe.kind === "explicit" ? { explicitAsk: true } : {}),
  });
  return {
    sessionId: start.sessionId,
    servedCitations: items.map(toCitation),
    offer:
      offer.published === true
        ? { published: true, messageId: offer.messageId, targetRefs: offer.targetRefs }
        : { published: false, suppressed: offer.suppressed },
  };
}

function toCitation(item: { kind: string; id: string; snippet: string }) {
  return { kind: item.kind, id: item.id, snippet: item.snippet };
}
