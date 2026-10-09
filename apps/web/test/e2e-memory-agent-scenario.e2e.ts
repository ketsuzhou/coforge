import { expect, test } from "bun:test";
import { PrismaPg } from "@prisma/adapter-pg";
import { PrismaClient } from "../generated/client";
import { buildScenarioOne, materializeScenario, runProbe } from "./memory-scenarios";

/**
 * Memory Agent full-stack smoke (ADR 0053-G, manual gate): the S1 scenario
 * against a real model — the distillation sweep dials a live endpoint, then
 * the probe asserts the three metric layers on server records. Runs via
 * `mise run test:e2e:memory-agent` with MEMORY_SMOKE_* env; skips cleanly
 * without credentials. Run it deliberately — it spends real tokens.
 */

const API_KEY = Bun.env.MEMORY_SMOKE_API_KEY;
const BASE_URL = Bun.env.MEMORY_SMOKE_BASE_URL ?? "https://open.bigmodel.cn/api/paas/v4";
const MODEL = Bun.env.MEMORY_SMOKE_MODEL ?? "glm-4.7";
const PROVIDER_ID = Bun.env.MEMORY_SMOKE_PROVIDER_ID ?? "zhipu";

function skip(message: string): void {
  console.log(JSON.stringify({ event: "memory_agent_smoke.skipped", reason: message }));
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
  const { saveWorkspaceModelConfiguration } =
    await import("../src/server/group-memory/workspace-model-configuration.server");
  const { runShadowGateSweep } = await import("../src/server/group-memory/shadow-gate.server");

  const llm = new OpenAiCompatibleDistillationLlm(fetch, 120_000);

  test("S1 against a live model: distill for real, then probe the three layers", async () => {
    // Materialize the scenario shell WITHOUT the fixture insight: the real
    // critique pass must produce the knowledge. teach[0] carries the marker.
    const scenario = buildScenarioOne();
    const handles = await materializeScenario(db, {
      ...scenario,
      insights: [],
      skill: undefined,
    });
    const owner = await db.user.findFirstOrThrow({
      where: { username: { startsWith: "scn-" } },
      orderBy: { createdAt: "desc" },
    });
    await saveWorkspaceModelConfiguration(
      db,
      { workspaceId: handles.workspaceId, userId: owner.id },
      {
        providerId: PROVIDER_ID,
        baseUrl: BASE_URL,
        model: MODEL,
        apiKey: API_KEY,
        dailyBudget: 12,
      },
    );

    // The critique cadence trips at 5 distilled episodes: pre-stamp the two
    // materialized windows (teach + decoy; benign, marker-free stamps), then
    // admit three filler windows the REAL outcome pass distills — 5 total.
    const stamped = await db.memoryEpisode.findMany({
      where: { workspaceId: handles.workspaceId },
      orderBy: { createdAt: "asc" },
    });
    for (const [index, episode] of stamped.entries()) {
      await db.memoryEpisode.update({
        where: { id: episode.id },
        data: {
          outcome: index === 0 ? "failure" : "success",
          outcomeReason: "scenario pre-stamp",
          keySteps: "routine collaboration window",
          distilledAt: new Date(),
        },
      });
    }
    const { admitMemoryEpisode } =
      await import("../src/server/group-memory/memory-episodes.server");
    for (let index = 0; index < 3; index += 1) {
      const seq = 100 + index * 3;
      const body = `collab window ${index}: the team discussed the audit checklist, agreed credentials must rotate before the quarterly audit, and shipped the review`;
      await db.message.create({
        data: {
          conversationId: handles.channelId,
          workspaceId: handles.workspaceId,
          body,
          sequence: seq,
        },
      });
      await admitMemoryEpisode(db, {
        workspaceId: handles.workspaceId,
        conversationId: handles.channelId,
        kind: "quiet_window",
        startSequence: seq,
        endSequence: seq,
        title: `collab window ${index}`,
        body,
        participants: [{ kind: "human", id: owner.id, handle: owner.username }],
      });
    }
    // A failed pass degrades to "try again next sweep" by design (the
    // reasoning model occasionally returns empty content); loop the sweep
    // until the critique cadence lands, bounded.
    let insights = 0;
    for (let sweep = 0; sweep < 3 && insights === 0; sweep += 1) {
      await sweepMemoryDistillation(db, llm);
      insights = await db.memoryInsight.count({ where: { workspaceId: handles.workspaceId } });
      console.log(JSON.stringify({ event: "memory_agent_smoke.sweep", sweep, insights }));
    }

    // Mechanism evidence first: the real critique pass distilled something.
    console.log(JSON.stringify({ event: "memory_agent_smoke.distilled", insights }));
    expect(insights).toBeGreaterThan(0);

    // Probe S1 explicit: execution, recall, precision — on server records.
    const probe = await runProbe(db, handles, scenario.probes[0] as never);
    const session = await db.memoryExplorationSession.findUniqueOrThrow({
      where: { id: probe.sessionId },
    });
    expect(session.state).toBe("closed");
    console.log(
      JSON.stringify({
        event: "memory_agent_smoke.probe",
        served: probe.servedCitations.map((item) => item.kind),
        offer: probe.offer?.published === true,
      }),
    );
    expect(probe.servedCitations.every((item) => item.kind === "skill")).toBe(true);
    if (probe.offer?.published === true) {
      expect(probe.offer.targetRefs.every((ref) => ref.startsWith("skill:"))).toBe(true);
    }

    // Negative probe stays silent; the shadow gate sweep is a no-op here but
    // must not disturb the records.
    const negative = await runProbe(db, handles, scenario.probes[1] as never);
    expect(negative.servedCitations).toEqual([]);
    expect(negative.offer).toBeUndefined();
    await runShadowGateSweep(db, { workspaceId: handles.workspaceId });
  }, 300_000);
}
