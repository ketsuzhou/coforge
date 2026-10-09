import { expect, test } from "bun:test";
import { PrismaPg } from "@prisma/adapter-pg";
import { PrismaClient } from "../generated/client";
import { handleAgentMemoryPost } from "../src/routes/api/agent/v1/memory";
import { createMemoryInsight } from "../src/server/group-memory/memory-insights.server";
import { enableGroupMemory } from "../src/server/group-memory/memory-agent.server";

/**
 * The Memory Agent's HTTP boundary (ADR 0052-E): the exploration
 * command wire over /api/agent/v1/memory — the designation fence refusing
 * ordinary Agents with 403 before any memory content is served, the full
 * start→explore→close protocol over HTTP JSON, and AppError-to-status
 * mapping for the protocol's own rejections.
 *
 * Runs via `mise run test:memory` with MEMORY_TEST_DATABASE_URL pointing at
 * a scratch database.
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

test("the memory boundary admits only the designated Memory Agent over HTTP", async () => {
  const db = getDb();
  const suffix = crypto.randomUUID().slice(0, 8);
  const user = await db.user.create({ data: { username: `mem-http-${suffix}` } });
  const workspace = await db.workspace.create({
    data: {
      slug: `mem-http-${suffix}`,
      name: "Memory HTTP Test",
      members: { create: [{ userId: user.id, role: "owner" }] },
    },
    select: { id: true },
  });
  const ordinary = await db.agent.create({
    data: {
      workspaceId: workspace.id,
      ownerId: user.id,
      name: `ordinary-${suffix}`,
      displayName: "Ordinary",
      runtimeConfig: {},
    },
    select: { id: true },
  });

  const refused = await post(
    { op: "start", startKey: "http-1", query: "database backups" },
    { workspaceId: workspace.id, agentId: ordinary.id },
  );
  expect(refused.status).toBe(403);
  expect(await refused.json()).toEqual({ ok: false, errorCode: "gm-memory-explorer-only" });

  const enabled = await enableGroupMemory(db, { workspaceId: workspace.id, ownerId: user.id });
  const badBody = await post(
    { op: "start", startKey: "bad", query: "" },
    { workspaceId: workspace.id, agentId: enabled.agentId },
  );
  expect(badBody.status).toBe(400);
  expect((await badBody.json()).errorCode).toBe("gm-memory-request-invalid");

  const insight = await createMemoryInsight(db, {
    workspaceId: workspace.id,
    statement: "Back up the database nightly before the cleanup window",
  });

  const start = await post(
    { op: "start", startKey: "http-2", query: "how do we back up the database", maxSteps: 2 },
    { workspaceId: workspace.id, agentId: enabled.agentId },
  );
  expect(start.status).toBe(200);
  const startBody = await start.json();
  expect(startBody.ok).toBe(true);
  expect(startBody.items).toEqual([]);
  expect(startBody.remainingSteps).toBe(2);

  const storedAnchor = `insight:${insight.insightId}`;
  const retired = await post(
    {
      op: "explore",
      sessionId: startBody.sessionId,
      operationId: "explore-1",
      anchor: storedAnchor,
    },
    { workspaceId: workspace.id, agentId: enabled.agentId },
  );
  expect(retired.status).toBe(400);
  expect((await retired.json()).errorCode).toBe("retired_from_memory_discovery");

  const unservedInsight = await post(
    {
      op: "explore",
      sessionId: startBody.sessionId,
      operationId: "explore-2",
      anchor: `insight:${crypto.randomUUID()}`,
    },
    { workspaceId: workspace.id, agentId: enabled.agentId },
  );
  expect(unservedInsight.status).toBe(400);
  expect((await unservedInsight.json()).errorCode).toBe("retired_from_memory_discovery");
});

test("an exploration serves learned-skill citations over the HTTP boundary", async () => {
  // Q160-B: new discovery serves active SkillRevisions. The HTTP boundary
  // still carries kind "skill" through start, explore, and close.
  const db = getDb();
  const suffix = crypto.randomUUID().slice(0, 8);
  const user = await db.user.create({ data: { username: `mem-skill-${suffix}` } });
  const workspace = await db.workspace.create({
    data: {
      slug: `mem-skill-${suffix}`,
      name: "Memory Skill HTTP Test",
      members: { create: [{ userId: user.id, role: "owner" }] },
    },
    select: { id: true },
  });
  const enabled = await enableGroupMemory(db, { workspaceId: workspace.id, ownerId: user.id });
  const needle = `zighurst-${suffix}`;
  const skill = await db.learnedSkill.create({
    data: {
      workspaceId: workspace.id,
      key: `rerun-${suffix}`,
      name: "Rerun flaky suites once",
      kind: "step_guidance",
    },
  });
  const revision = await db.learnedSkillRevision.create({
    data: {
      workspaceId: workspace.id,
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

  const start = await post(
    { op: "start", startKey: `skill-http-${suffix}`, query: needle },
    { workspaceId: workspace.id, agentId: enabled.agentId },
  );
  expect(start.status).toBe(200);
  const body = await start.json();
  const served = body.items.find((item: { kind: string }) => item.kind === "skill");
  // Start serves the seed's retrieval snippet (the revision's searchText);
  // the display-name snippet is the explore step's rendering.
  expect(served).toMatchObject({
    citationId: `skill:${revision.id}`,
    kind: "skill",
    id: revision.id,
    snippet: `when a ${needle} appears rerun once then quarantine`,
  });
  expect(
    body.items.some((item: { kind: string }) => item.kind === "episode" || item.kind === "insight"),
  ).toBe(false);

  const anchor = `skill:${revision.id}`;
  const explore = await post(
    { op: "explore", sessionId: body.sessionId, operationId: "explore-skill-1", anchor },
    { workspaceId: workspace.id, agentId: enabled.agentId },
  );
  expect(explore.status).toBe(200);
  expect((await explore.json()).state).toBe("active");

  const unserved = await post(
    {
      op: "explore",
      sessionId: body.sessionId,
      operationId: "explore-skill-unserved",
      anchor: `skill:${crypto.randomUUID()}`,
    },
    { workspaceId: workspace.id, agentId: enabled.agentId },
  );
  expect(unserved.status).toBe(400);
  expect((await unserved.json()).errorCode).toBe("gm-exploration-anchor-unserved");

  const close = await post(
    {
      op: "close",
      sessionId: body.sessionId,
      operationId: "close-skill-1",
      found: true,
      summary: "Rerun a flaky suite once, then quarantine it",
      citationIds: [anchor],
    },
    { workspaceId: workspace.id, agentId: enabled.agentId },
  );
  expect(close.status).toBe(200);
  const closeBody = await close.json();
  expect(closeBody.state).toBe("closed");
  expect(closeBody.citations).toEqual([{ citationId: anchor, kind: "skill", id: revision.id }]);

  const afterClose = await post(
    { op: "explore", sessionId: body.sessionId, operationId: "explore-skill-closed", anchor },
    { workspaceId: workspace.id, agentId: enabled.agentId },
  );
  expect(afterClose.status).toBe(409);
  expect((await afterClose.json()).errorCode).toBe("gm-exploration-session-closed");
});
