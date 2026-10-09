import { expect, test } from "bun:test";
import { PrismaPg } from "@prisma/adapter-pg";
import { PrismaClient } from "../generated/client";

/**
 * LearnedSkill loop real-LLM E2E smoke (ADR 0052 slice 6): the ingest →
 * distill → propose → recall → offer chain against a live model, plus the
 * degradation red line.
 *
 * Unlike the fixture-driven integration suites, the distillation passes here
 * dial a real OpenAI-compatible endpoint through the Workspace model
 * credential — the same path production uses. The script skips (exit 0, zero
 * tests failing) when the smoke credentials are absent, so it is safe in
 * every environment; run it via `mise run test:e2e:group-memory` with
 * MEMORY_SMOKE_* env set.
 */

const API_KEY = Bun.env.MEMORY_SMOKE_API_KEY;
const BASE_URL = Bun.env.MEMORY_SMOKE_BASE_URL ?? "https://open.bigmodel.cn/api/paas/v4";
const MODEL = Bun.env.MEMORY_SMOKE_MODEL ?? "glm-4.7";
const PROVIDER_ID = Bun.env.MEMORY_SMOKE_PROVIDER_ID ?? "zhipu";

function skip(message: string): void {
  console.log(JSON.stringify({ event: "group_memory_smoke.skipped", reason: message }));
}

if (!API_KEY) {
  skip("MEMORY_SMOKE_API_KEY is not set");
} else {
  const db = new PrismaClient({
    adapter: new PrismaPg({
      connectionString:
        Bun.env.MEMORY_SMOKE_DATABASE_URL ??
        (() => {
          throw new Error("MEMORY_SMOKE_DATABASE_URL is required with MEMORY_SMOKE_API_KEY");
        })(),
    }),
  });
  process.env.COFORGE_AGENT_CREDENTIAL_ENCRYPTION_KEY ??=
    Bun.env.COFORGE_AGENT_CREDENTIAL_ENCRYPTION_KEY!;
  const { sweepMemoryDistillation } =
    await import("../src/server/group-memory/memory-distillation.server");
  const { OpenAiCompatibleDistillationLlm } =
    await import("../src/server/group-memory/distillation-llm.server");
  const { enableGroupMemory } = await import("../src/server/group-memory/memory-agent.server");
  const { saveWorkspaceModelConfiguration } =
    await import("../src/server/group-memory/workspace-model-configuration.server");
  const { listIngestableCompletedTasks, ingestCompletedTask } =
    await import("../src/server/group-memory/memory-ingestion.server");
  const { startMemoryExploration, exploreMemoryStep, closeMemoryExploration } =
    await import("../src/server/group-memory/memory-exploration.server");
  const { publishMemoryOffer } = await import("../src/server/group-memory/memory-offer.server");

  const llm = new OpenAiCompatibleDistillationLlm(fetch, 120_000);

  test("ingest → real-LLM distillation → recall → offer, and degradation", async () => {
    const suffix = crypto.randomUUID().slice(0, 8);
    const user = await db.user.create({ data: { username: `smoke-${suffix}` } });
    const workspace = await db.workspace.create({
      data: {
        slug: `smoke-${suffix}`,
        name: "Smoke",
        members: { create: [{ userId: user.id, role: "owner" }] },
      },
      select: { id: true },
    });
    const channel = await db.conversation.create({
      data: { workspaceId: workspace.id, channelName: `smoke-${suffix}` },
      select: { id: true },
    });
    const humanMember = await db.conversationMember.create({
      data: { conversationId: channel.id, workspaceId: workspace.id, userId: user.id },
      select: { id: true },
    });

    // A realistic collaboration slice: a hotfix gone wrong, then fixed.
    const transcript = [
      "We hotfixed production directly yesterday and the audit trail was a mess.",
      "Next time: run the database migration first, then deploy in the morning when staging is quiet.",
      "The rollback took an hour because nobody had backed up the database before the cleanup job.",
    ];
    for (const [index, body] of transcript.entries()) {
      await db.message.create({
        data: {
          conversationId: channel.id,
          workspaceId: workspace.id,
          senderMemberId: humanMember.id,
          body,
          sequence: index + 1,
          createdAt: new Date(Date.now() - 3 * 60 * 60_000),
        },
      });
    }
    const taskMessageId = crypto.randomUUID();
    await db.message.create({
      data: {
        id: taskMessageId,
        conversationId: channel.id,
        workspaceId: workspace.id,
        senderMemberId: humanMember.id,
        body: "Retrospective: fix the hotfix process",
        sequence: transcript.length + 1,
        createdAt: new Date(Date.now() - 2 * 60 * 60_000),
      },
    });
    await db.task.create({
      data: {
        messageId: taskMessageId,
        conversationId: channel.id,
        workspaceId: workspace.id,
        number: 1,
        title: "Fix the hotfix process",
        status: "done",
        creatorMemberId: humanMember.id,
      },
    });

    // Enable Group Memory + a real model configuration, then run the sweeps.
    const enabled = await enableGroupMemory(db, { workspaceId: workspace.id, ownerId: user.id });
    await saveWorkspaceModelConfiguration(
      db,
      { workspaceId: workspace.id, userId: user.id },
      {
        providerId: PROVIDER_ID,
        baseUrl: BASE_URL,
        model: MODEL,
        apiKey: API_KEY,
        dailyBudget: 10,
      },
    );

    const ingestable = await listIngestableCompletedTasks(db);
    expect(ingestable.some((task) => task.taskMessageId === taskMessageId)).toBe(true);
    const ingested = await ingestCompletedTask(db, { taskMessageId });
    expect(ingested.skipped).toBe(false);

    // The critique cadence trips at CRITIQUE_CADENCE (5) distilled episodes;
    // four more admitted windows around the same theme get the loop there so
    // the sweep chain exercises outcome → critique → propose for real.
    const { admitMemoryEpisode } =
      await import("../src/server/group-memory/memory-episodes.server");
    const extraBodies = [
      "We skipped the migration again under deadline pressure; the deploy failed and we hotfixed production.",
      "This time we ran the migration first, deployed in the quiet morning window, and the audit trail stayed clean.",
      "The rollback rehearsal showed nobody had backed up the database before the cleanup job; we lost an hour.",
      "After the checklist change the hotfix went smoothly: migrate first, deploy in the morning, verify the audit log.",
    ];
    let seq = transcript.length + 2;
    for (const body of extraBodies) {
      seq += 3;
      await admitMemoryEpisode(db, {
        workspaceId: workspace.id,
        conversationId: channel.id,
        kind: "quiet_window",
        startSequence: seq - 2,
        endSequence: seq,
        title: "hotfix process window",
        body,
        participants: [{ kind: "human", id: user.id, handle: user.username }],
      });
    }

    await sweepMemoryDistillation(db, llm);
    const episode = await db.memoryEpisode.findFirstOrThrow({
      where: { workspaceId: workspace.id, taskMessageId },
    });
    expect(episode.distilledAt).not.toBeNull();
    expect(episode.outcome === "success" || episode.outcome === "failure").toBe(true);
    const insights = await db.memoryInsight.count({ where: { workspaceId: workspace.id } });
    console.log(
      JSON.stringify({
        event: "group_memory_smoke.distilled",
        outcome: episode.outcome,
        key_steps: episode.keySteps?.slice(0, 80),
        insights,
      }),
    );
    expect(insights).toBeGreaterThan(0);

    // The sweep chain ends with one proposer pass (ADR 0052-G): a bound
    // skill or a recorded no_action — never silence.
    const proposeRun = await db.memoryDistillationRun.findFirst({
      where: { workspaceId: workspace.id, kind: "propose" },
    });
    expect(proposeRun).not.toBeNull();
    const ledgerEntries = await db.skillProposalLedgerEntry.count({
      where: { workspaceId: workspace.id },
    });
    expect(ledgerEntries).toBeGreaterThan(0);
    const skillCount = await db.learnedSkill.count({ where: { workspaceId: workspace.id } });
    console.log(
      JSON.stringify({
        event: "learned_skill_smoke.proposed",
        ledger_entries: ledgerEntries,
        lineages: skillCount,
      }),
    );

    // Recall: the designated Memory Agent explores with a related query.
    const start = await startMemoryExploration(db, {
      workspaceId: workspace.id,
      agentId: enabled.agentId,
      startKey: `smoke-${suffix}`,
      query: "how do we deploy safely without breaking the audit trail",
      maxSteps: 2,
      maxResults: 20,
    });
    console.log(
      JSON.stringify({
        event: "group_memory_smoke.recall",
        seeds: start.items.map((item) => item.citationId),
      }),
    );
    expect(start.items.every((item) => item.kind === "skill")).toBe(true);
    const anchor = start.items.find((item) => item.kind === "skill");
    if (anchor) {
      const step = await exploreMemoryStep(db, {
        workspaceId: workspace.id,
        agentId: enabled.agentId,
        sessionId: start.sessionId,
        operationId: "smoke-explore-1",
        anchor: anchor.citationId,
      });
      const closed = await closeMemoryExploration(db, {
        workspaceId: workspace.id,
        agentId: enabled.agentId,
        sessionId: start.sessionId,
        operationId: "smoke-close-1",
        found: true,
        summary: "The team learned to migrate first and deploy in quiet windows",
        citationIds: [anchor.citationId, ...step.items.map((item) => item.citationId)].slice(0, 3),
      });
      expect(closed.state).toBe("closed");
      const offered = await publishMemoryOffer(db, {
        workspaceId: workspace.id,
        memoryAgentId: enabled.agentId,
        conversationId: channel.id,
        targetAgentId: enabled.agentId,
        targets: [{ kind: "skill", id: anchor.id }],
        body: `@Memory smoke: published skill from the hotfix retrospective (${insights} stored insights)`,
        operationKey: `smoke-offer-${suffix}`,
        explicitAsk: true,
      });
      expect(offered.published).toBe(true);
      if (!offered.published) throw new Error("expected the smoke offer to publish");
      console.log(
        JSON.stringify({ event: "group_memory_smoke.offer", message_id: offered.messageId }),
      );
    }

    // Degradation red line (ADR 0053-E analog on the API boundary): an
    // undesigned caller is refused without touching memory — the "turn"
    // (this test) continues unaffected.
    const outsider = await db.agent.create({
      data: {
        workspaceId: workspace.id,
        ownerId: user.id,
        name: `outsider-${suffix}`,
        displayName: "Outsider",
        runtimeConfig: {},
      },
      select: { id: true },
    });
    let refused = false;
    try {
      await startMemoryExploration(db, {
        workspaceId: workspace.id,
        agentId: outsider.id,
        startKey: `out-${suffix}`,
        query: "anything",
      });
    } catch {
      refused = true;
    }
    expect(refused).toBe(true);
  }, 300_000);
}
