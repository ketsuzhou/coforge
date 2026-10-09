import { expect, test } from "bun:test";
import { PrismaPg } from "@prisma/adapter-pg";
import { PrismaClient } from "../generated/client";
import { handleAgentMemoryPost } from "../src/routes/api/agent/v1/memory";
import { afterEach } from "bun:test";
import { buildScenarioOne, cleanupScenarios, materializeScenario } from "./memory-scenarios";

afterEach(async () => {
  await cleanupScenarios(getDb());
});

/**
 * The fenced tool wire over the real HTTP boundary (ADR 0053-G): a
 * protocol-faithful client — the same payloads the runner's six native tools
 * emit — drives start → explore → redirect → submit → offer end to end.
 * Asserts the fence (an ordinary Agent is refused on every op), operation
 * idempotency (byte-replays return duplicates, drift conflicts), and that
 * the offer lands with delivery rows on the server side.
 */

let client: PrismaClient | undefined;

function getDb(): PrismaClient {
  if (client) return client;
  const connectionString = Bun.env.MEMORY_TEST_DATABASE_URL;
  if (!connectionString) throw new Error("MEMORY_TEST_DATABASE_URL must point at local PostgreSQL");
  client = new PrismaClient({ adapter: new PrismaPg({ connectionString }) });
  return client;
}

const post = (body: unknown, principal: { workspaceId: string; agentId: string }) =>
  handleAgentMemoryPost(
    new Request("https://server.example/api/agent/v1/memory", {
      method: "POST",
      body: JSON.stringify(body),
    }),
    getDb(),
    principal,
  );

test("the fenced wire: full tool chain, fence, idempotency, drift, and a delivered offer", async () => {
  const db = getDb();
  const scenario = buildScenarioOne();
  const handles = await materializeScenario(db, scenario);
  const principal = { workspaceId: handles.workspaceId, agentId: handles.memoryAgentId };
  const marker = scenario.teach[0]!.marker;
  if (!handles.skillRevisionId) throw new Error("skillRevisionId missing");
  const skillRevisionId = handles.skillRevisionId;

  // Fence: an ordinary Agent is refused on exploration AND offer ops.
  const ordinary = await db.agent.create({
    data: {
      workspaceId: handles.workspaceId,
      ownerId: (await db.user.findFirstOrThrow({ where: { username: { startsWith: "scn-" } } })).id,
      name: `ordinary-${crypto.randomUUID().slice(0, 6)}`,
      displayName: "Ordinary",
      runtimeConfig: {},
    },
  });
  for (const body of [
    { op: "start", startKey: "fence", query: "credentials rotation" },
    {
      op: "offer",
      operationKey: "fence-offer",
      conversationId: handles.channelId,
      targetAgentId: handles.workerAgentId,
      targets: [{ kind: "insight", id: handles.insightByMarker.get(marker)! }],
      body: "spoof",
    },
  ]) {
    const refused = await post(body, { workspaceId: handles.workspaceId, agentId: ordinary.id });
    expect(refused.status).toBe(403);
    expect((await refused.json()).errorCode).toBe("gm-memory-explorer-only");
  }

  // start — seeds with the marker-bearing content.
  const start = await post(
    {
      op: "start",
      startKey: "wire-1",
      query: "how often do credentials rotate before the audit",
      maxSteps: 3,
    },
    principal,
  );
  expect(start.status).toBe(200);
  const startBody = await start.json();
  expect(startBody.ok).toBe(true);
  expect(
    startBody.items.some(
      (item: { kind: string }) => item.kind === "episode" || item.kind === "insight",
    ),
  ).toBe(false);
  expect(startBody.items.every((item: { kind: string }) => item.kind === "skill")).toBe(true);
  const anchor = startBody.items.find((item: { id: string }) => item.id === skillRevisionId);
  if (!anchor) throw new Error("skill seed missing");

  // explore — anchored on a served citation, one expansion hop.
  const explore = await post(
    {
      op: "explore",
      sessionId: startBody.sessionId,
      operationId: "wire-explore-1",
      anchor: anchor.citationId,
      relation: "similar",
      limit: 5,
    },
    principal,
  );
  expect(explore.status).toBe(200);

  // redirect — a mid-session re-seed, then submit with what was served.
  const redirect = await post(
    {
      op: "redirect",
      sessionId: startBody.sessionId,
      operationId: "wire-redirect-1",
      query: "database credential rotation cadence audit",
    },
    principal,
  );
  expect(redirect.status).toBe(200);
  const redirected = await redirect.json();
  expect(redirected.items.every((item: { kind: string }) => item.kind === "skill")).toBe(true);
  const citations = [...startBody.items, ...redirected.items].map(
    (item: { citationId: string }) => item.citationId,
  );
  const submit = await post(
    {
      op: "close",
      sessionId: startBody.sessionId,
      operationId: "wire-close-1",
      found: true,
      summary: "Credentials rotate every 14 days before the audit",
      citationIds: [...new Set(citations)].slice(0, 5),
    },
    principal,
  );
  expect(submit.status).toBe(200);
  expect((await submit.json()).state).toBe("closed");

  // offer — the memory agent delivers the skill revision to the worker.
  const offer = await post(
    {
      op: "offer",
      operationKey: "wire-offer-1",
      conversationId: handles.channelId,
      targetAgentId: handles.workerAgentId,
      targets: [{ kind: "skill", id: skillRevisionId }],
      body: `@worker rotate credentials with the published skill (${marker})`,
      explicitAsk: true,
    },
    principal,
  );
  expect(offer.status).toBe(200);
  const offerBody = await offer.json();
  expect(offerBody.published).toBe(true);

  // Delivery evidence on the server: row + structured mention + wake.
  const delivery = await db.memoryOfferDelivery.findFirstOrThrow({
    where: { workspaceId: handles.workspaceId, operationKey: "wire-offer-1" },
  });
  expect(delivery.agentId).toBe(handles.workerAgentId);
  expect(delivery.explicitAsk).toBe(true);
  const mention = await db.messageMention.findFirst({
    where: { workspaceId: handles.workspaceId, messageId: delivery.messageId },
  });
  expect(mention?.actorId).toBe(handles.workerAgentId);
  expect(
    await db.agentMessageDelivery.findFirst({
      where: { workspaceId: handles.workspaceId, messageId: delivery.messageId },
    }),
  ).toBeTruthy();

  // Idempotency: byte-identical replays return duplicates, nothing new lands.
  const startReplay = await post(
    {
      op: "start",
      startKey: "wire-1",
      query: "how often do credentials rotate before the audit",
      maxSteps: 3,
    },
    principal,
  );
  const startReplayBody = await startReplay.json();
  expect(startReplayBody.duplicate).toBe(true);
  expect(startReplayBody.sessionId).toBe(startBody.sessionId);
  const exploreReplay = await post(
    {
      op: "explore",
      sessionId: startBody.sessionId,
      operationId: "wire-explore-1",
      anchor: anchor.citationId,
      relation: "similar",
      limit: 5,
    },
    principal,
  );
  expect((await exploreReplay.json()).duplicate).toBe(true);
  void exploreReplay;
  const offerReplay = await post(
    {
      op: "offer",
      operationKey: "wire-offer-1",
      conversationId: handles.channelId,
      targetAgentId: handles.workerAgentId,
      targets: [{ kind: "skill", id: skillRevisionId }],
      body: `@worker rotate credentials with the published skill (${marker})`,
      explicitAsk: true,
    },
    principal,
  );
  const replayBody = await offerReplay.json();
  expect(replayBody.duplicate).toBe(true);
  expect(replayBody.messageId).toBe(delivery.messageId);
  expect(
    await db.memoryOfferDelivery.count({
      where: { workspaceId: handles.workspaceId, operationKey: "wire-offer-1" },
    }),
  ).toBe(1);

  // Drift under the same operation key is a conflict, never a second offer.
  const drifted = await post(
    {
      op: "offer",
      operationKey: "wire-offer-1",
      conversationId: handles.channelId,
      targetAgentId: handles.workerAgentId,
      targets: [
        { kind: "skill", id: skillRevisionId },
        { kind: "skill", id: crypto.randomUUID() },
      ],
      body: "different shape",
      explicitAsk: true,
    },
    principal,
  );
  expect(drifted.status).toBe(409);
  expect((await drifted.json()).errorCode).toBe("gm-offer-operation-drift");

  // A new insight target is retired before it can publish, even with explicitAsk.
  const retiredInsight = await post(
    {
      op: "offer",
      operationKey: "wire-offer-insight",
      conversationId: handles.channelId,
      targetAgentId: handles.workerAgentId,
      targets: [{ kind: "insight", id: crypto.randomUUID() }],
      body: "ghost insight",
      explicitAsk: true,
    },
    principal,
  );
  expect(retiredInsight.status).toBe(400);
  expect((await retiredInsight.json()).errorCode).toBe("retired_from_memory_discovery");

  // An unknown skill revision is still refused before anything publishes.
  const unknown = await post(
    {
      op: "offer",
      operationKey: "wire-offer-unknown",
      conversationId: handles.channelId,
      targetAgentId: handles.workerAgentId,
      targets: [{ kind: "skill", id: crypto.randomUUID() }],
      body: "ghost",
      explicitAsk: true,
    },
    principal,
  );
  expect(unknown.status).toBe(404);
  expect((await unknown.json()).errorCode).toBe("gm-offer-skill-missing");

  // Malformed wire is rejected at the schema gate.
  const malformed = await post({ op: "offer", targets: [] }, principal);
  expect(malformed.status).toBe(400);
  expect((await malformed.json()).errorCode).toBe("gm-memory-request-invalid");
});
