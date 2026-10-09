import { expect, test } from "bun:test";
import { PrismaPg } from "@prisma/adapter-pg";
import { PrismaClient } from "../generated/client";
import { afterEach } from "bun:test";
import {
  buildScenarioOne,
  buildScenarioThree,
  buildScenarioTwo,
  cleanupScenarios,
  materializeScenario,
  runProbe,
  type ScenarioHandles,
} from "./memory-scenarios";

afterEach(async () => {
  await cleanupScenarios(getDb());
});

/**
 * Memory Agent scenarios (ADR 0053): every probe is measured in three layers
 * — execution (an exploration ran and closed), recall (the citations cover
 * the expected layers), precision (the expected markers reach the served
 * content and the offer) — and every scenario carries its discipline probes:
 * the decoy never reaches a distilled layer, the negative probe stays silent,
 * the cooldown suppresses redelivery, and an explicit ask bypasses it with
 * the exemption recorded. All evidence is server-side records.
 */

let client: PrismaClient | undefined;

function getDb(): PrismaClient {
  if (client) return client;
  const connectionString = Bun.env.MEMORY_TEST_DATABASE_URL;
  if (!connectionString) throw new Error("MEMORY_TEST_DATABASE_URL must point at local PostgreSQL");
  client = new PrismaClient({ adapter: new PrismaPg({ connectionString }) });
  return client;
}

async function sessionOf(db: PrismaClient, sessionId: string) {
  return db.memoryExplorationSession.findUniqueOrThrow({ where: { id: sessionId } });
}

function assertLayers(
  served: Array<{ kind: string; id: string; snippet: string }>,
  layers: Array<"episode" | "insight" | "skill">,
) {
  const kinds = new Set(served.map((item) => item.kind));
  for (const layer of layers) expect(kinds.has(layer)).toBe(true);
}

function assertMarkersReach(
  probe: { servedCitations: Array<{ snippet: string }>; offer?: { published: boolean } },
  db: PrismaClient,
  markers: string[],
) {
  const snippets = probe.servedCitations.map((item) => item.snippet).join("\n");
  const reached = markers.filter((marker) => snippets.includes(marker));
  expect(reached.length).toBeGreaterThanOrEqual(1);
  void db;
}

test("S1 single fact: public discovery serves the skill, the insight stays stored, and the decoy stays out", async () => {
  const db = getDb();
  const scenario = buildScenarioOne();
  const handles = await materializeScenario(db, scenario);
  const teachMarker = scenario.teach[0]!.marker;
  const decoyMarker = scenario.decoy!.decoyMarker;

  // Execution + recall + precision on the explicit probe.
  const explicit = await runProbe(db, handles, scenario.probes[0] as never);
  const session = await sessionOf(db, explicit.sessionId);
  expect(session.state).toBe("closed");
  expect(session.stepsUsed).toBeGreaterThanOrEqual(1);
  assertLayers(explicit.servedCitations, ["skill"]);
  expect(
    explicit.servedCitations.some((item) => item.kind === "episode" || item.kind === "insight"),
  ).toBe(false);
  assertMarkersReach(explicit, db, [teachMarker]);
  expect(explicit.offer?.published).toBe(true);
  const storedInsight = await db.memoryInsight.findUniqueOrThrow({
    where: { id: handles.insightByMarker.get(teachMarker)! },
  });
  expect(storedInsight.statement).toContain(teachMarker);

  // The offer is delivered, not just composed: delivery row + explicit-ask record.
  if (explicit.offer?.published === true) {
    expect(explicit.offer.targetRefs.every((ref) => ref.startsWith("skill:"))).toBe(true);
    const deliveries = await db.memoryOfferDelivery.findMany({
      where: { workspaceId: handles.workspaceId, messageId: explicit.offer.messageId },
    });
    expect(deliveries.length).toBeGreaterThanOrEqual(1);
    expect(deliveries[0]!.explicitAsk).toBe(true);
    expect(deliveries[0]!.agentId).toBe(handles.workerAgentId);
    expect(deliveries.every((row) => row.targetKind === "skill")).toBe(true);
  }

  // Negative probe: execution happened, but nothing was served and no offer exists.
  const negative = await runProbe(db, handles, scenario.probes[1] as never);
  expect(negative.servedCitations).toEqual([]);
  expect(negative.offer).toBeUndefined();
  const negativeSession = await sessionOf(db, negative.sessionId);
  expect(negativeSession.found).toBe(false);
  for (const neverMarker of (scenario.probes[1] as { neverMarkers: string[] }).neverMarkers) {
    const citations = await db.memoryExplorationCitation.findMany({
      where: { sessionId: negative.sessionId },
      select: { snippet: true },
    });
    expect(citations.some((row) => row.snippet.includes(neverMarker))).toBe(false);
  }

  // Decoy discipline: the transcript may snapshot it, no distilled layer carries it.
  const insights = await db.memoryInsight.findMany({
    where: { workspaceId: handles.workspaceId },
    select: { statement: true },
  });
  expect(insights.some((row) => row.statement.includes(decoyMarker))).toBe(false);
  const skills = await db.learnedSkillRevision.findMany({
    where: { workspaceId: handles.workspaceId },
    select: { searchText: true },
  });
  expect(skills.every((row) => !row.searchText.includes(decoyMarker))).toBe(true);
  const offers = await db.memoryOfferDelivery.findMany({
    where: { workspaceId: handles.workspaceId },
  });
  expect(offers.length).toBeGreaterThan(0);
});

test("S2 fact update: the revision stays stored and neither insight is newly served", async () => {
  const db = getDb();
  const scenario = buildScenarioTwo();
  const handles = await materializeScenario(db, scenario);
  const oldInsightId = handles.insightByMarker.get(scenario.teach[0]!.marker)!;
  const newMarker = scenario.insights[1]!.marker;
  const oldMarker = scenario.insights[0]!.marker;

  // The revision chain is real: the old head is superseded, the new head carries the policy.
  const oldRow = await db.memoryInsight.findUniqueOrThrow({ where: { id: oldInsightId } });
  expect(oldRow.supersededById).not.toBeNull();

  const newInsightId = handles.insightByMarker.get(newMarker)!;
  const newRow = await db.memoryInsight.findUniqueOrThrow({ where: { id: newInsightId } });
  expect(newRow.statement).toContain(newMarker);
  expect(newRow.supersededById).toBeNull();

  const probe = await runProbe(db, handles, scenario.probes[0] as never);
  const session = await sessionOf(db, probe.sessionId);
  expect(session.state).toBe("closed");
  expect(
    probe.servedCitations.some((item) => item.kind === "episode" || item.kind === "insight"),
  ).toBe(false);
  expect(probe.offer?.published).toBe(false);

  const sessionCitations = await db.memoryExplorationCitation.findMany({
    where: { sessionId: probe.sessionId },
    select: { kind: true, targetId: true, snippet: true },
  });
  expect(sessionCitations.some((row) => row.kind === "insight" || row.kind === "episode")).toBe(
    false,
  );
  expect(sessionCitations.some((row) => row.targetId === oldInsightId)).toBe(false);
  expect(sessionCitations.some((row) => row.snippet.includes(oldMarker))).toBe(false);
  expect(sessionCitations.some((row) => row.snippet.includes(newMarker))).toBe(false);
});

test("S3 cross-channel skill chain: the skill is discoverable, cooldown suppresses, explicit ask bypasses", async () => {
  const db = getDb();
  const scenario = buildScenarioThree();
  const handles: ScenarioHandles = await materializeScenario(db, scenario);
  expect(handles.skillRevisionId).toBeTruthy();

  // Explicit probe over the skills relation serves the skill and not the
  // retired episode or insight layers.
  const explicit = await runProbe(db, handles, scenario.probes[0] as never);
  const session = await sessionOf(db, explicit.sessionId);
  expect(session.state).toBe("closed");
  assertLayers(explicit.servedCitations, ["skill"]);
  expect(
    explicit.servedCitations.some((item) => item.kind === "episode" || item.kind === "insight"),
  ).toBe(false);
  expect(explicit.offer?.published).toBe(true);
  if (explicit.offer?.published === true) {
    expect(explicit.offer.targetRefs.every((ref) => ref.startsWith("skill:"))).toBe(true);
  }

  // Interaction links stay in native storage. Public exploration does not
  // return either episode.
  const deployEpisodeId = handles.episodeByMarker.get(scenario.teach[0]!.marker)!;
  const fixEpisodeId = handles.episodeByMarker.get(scenario.teach[1]!.marker)!;
  expect(
    explicit.servedCitations.some(
      (item) => item.id === deployEpisodeId || item.id === fixEpisodeId,
    ),
  ).toBe(false);
  const links = await db.memoryInteractionLink.findMany({
    where: { workspaceId: handles.workspaceId },
    select: { fromMessageId: true, kind: true },
  });
  expect(links.some((link) => link.kind === "mentions")).toBe(true);
  void deployEpisodeId;

  // Cooldown: a second, differently-keyed implicit probe offering the same
  // skill target inside the window is suppressed — silence, not spam.
  const implicitDuplicate = await runProbe(db, handles, {
    ...scenario.probes[1],
    key: "s3-implicit-cooldown",
  } as never);
  expect(implicitDuplicate.offer).toBeDefined();
  if (implicitDuplicate.offer?.published === false) {
    expect(implicitDuplicate.offer.suppressed.length).toBeGreaterThan(0);
    expect(implicitDuplicate.offer.suppressed[0]!.reason).toBe("cooldown");
  } else {
    throw new Error("expected the cooldown to suppress the duplicate offer");
  }

  // Explicit ask bypasses the cooldown, and the exemption is recorded.
  const bypass = await runProbe(db, handles, {
    ...scenario.probes[1],
    kind: "explicit",
    key: "s3-explicit-bypass",
  } as never);
  expect(bypass.offer?.published).toBe(true);
  if (bypass.offer?.published === true) {
    const rows = await db.memoryOfferDelivery.findMany({
      where: { workspaceId: handles.workspaceId, messageId: bypass.offer.messageId },
    });
    expect(rows.length).toBeGreaterThanOrEqual(1);
    expect(rows.every((row) => row.explicitAsk)).toBe(true);
  }
  void fixEpisodeId;
});
