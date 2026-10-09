import { createHash } from "node:crypto";
import { AppError } from "../../lib/app-error";
import type { PrismaClient, Prisma } from "../../../generated/client";
import {
  assertDiscoveryAnchor,
  assertPublicExpansionClasses,
  isRetiredFromMemoryDiscovery,
} from "./memory-discovery-eligibility";
import { createTrgmSimilarityIndex, type MemorySeed } from "./memory-similarity.server";
import {
  expandMemoryNeighborhood,
  type ExpansionNode,
  type MemoryCitationKind,
  type MemoryExpansionEdgeClass,
} from "./memory-expansion.server";

/**
 * Bounded memory exploration sessions (ADR 0052-E/I).
 *
 * The protocol shape is ported from the reference stack: start → explore /
 * redirect steps → close, with per-session step and result budgets, a TTL,
 * citation grounding (a close may only cite what the session served), and an
 * idempotency ledger on every step — byte-identical replays return the
 * recorded response as duplicates, content drift under the same operation id
 * is rejected.
 *
 * The boundary fence (ADR 0052-E): every entry point resolves the caller
 * against the Workspace's Memory Agent designation — ordinary Agents cannot
 * query Group Memory through this API. Slice 5 wires the RPC principal into
 * these functions; the fence itself lives here.
 */

export const MEMORY_EXPLORATION_SESSION_TTL_MS = 10 * 60_000;
export const MEMORY_EXPLORATION_MAX_STEPS = 8;
export const MEMORY_EXPLORATION_MAX_RESULTS = 30;
export const MEMORY_EXPLORATION_MAX_EXPLORE_LIMIT = 20;
const DEFAULT_MAX_STEPS = 4;
const DEFAULT_MAX_RESULTS = 10;
const DEFAULT_EXPLORE_LIMIT = 5;
const QUERY_MAX_LENGTH = 500;
const SUMMARY_MAX_LENGTH = 2000;
const OPERATION_KEY = /^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$/;
const CITATION_ID =
  /^(episode|insight|skill):[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

export type MemoryCitation = {
  /** Normalized citation id: "episode:<uuid>" | "insight:<uuid>" | "skill:<uuid>". */
  citationId: string;
  kind: MemoryCitationKind;
  id: string;
  snippet: string;
};

export type MemoryExplorationRelation = "similar" | "related" | "collaborators" | "skills";

export type MemoryExplorationState = "active" | "closed" | "expired";

export type MemoryExplorationStepView = {
  sessionId: string;
  state: MemoryExplorationState;
  items: MemoryCitation[];
  remainingSteps: number;
  duplicate: boolean;
};

export type MemoryExplorationStartView = MemoryExplorationStepView & { query: string };

export type MemoryExplorationCloseView = {
  sessionId: string;
  state: "closed";
  found: boolean;
  summary: string | null;
  citations: Array<Pick<MemoryCitation, "citationId" | "kind" | "id">>;
  duplicate: boolean;
};

const RELATION_EDGE_CLASSES: Record<MemoryExplorationRelation, MemoryExpansionEdgeClass[]> = {
  similar: ["similar"],
  // Still nameable so a new request is refused as retired_from_memory_discovery
  // instead of a schema error. Neither class is expanded.
  related: ["episodeInsight"],
  collaborators: ["interactions"],
  skills: ["skillGrounding", "skillLineage"],
};

/**
 * The API boundary fence (ADR 0054-C): resolves the caller against the
 * Workspace's Memory Agent designation. Ordinary Agents (and unknown
 * identities) are refused here, before any memory content is touched.
 */
export async function requireMemoryExplorer(
  db: PrismaClient,
  input: { workspaceId: string; agentId: string },
): Promise<void> {
  const designation = await db.memoryAgentDesignation.findUnique({
    where: { workspaceId: input.workspaceId },
    select: { agentId: true },
  });
  if (!designation || designation.agentId !== input.agentId)
    throw new AppError("ACCESS_DENIED", { errorId: "gm-memory-explorer-only" });
}

export async function startMemoryExploration(
  db: PrismaClient,
  input: {
    workspaceId: string;
    agentId: string;
    /** Caller idempotency key; replays map to the same session. */
    startKey: string;
    query: string;
    maxSteps?: number;
    maxResults?: number;
    now?: Date;
  },
): Promise<MemoryExplorationStartView> {
  await requireMemoryExplorer(db, input);
  const query = clampQuery(input.query);
  const maxSteps = clampInt(
    input.maxSteps ?? DEFAULT_MAX_STEPS,
    1,
    MEMORY_EXPLORATION_MAX_STEPS,
    "maxSteps",
  );
  const maxResults = clampInt(
    input.maxResults ?? DEFAULT_MAX_RESULTS,
    1,
    MEMORY_EXPLORATION_MAX_RESULTS,
    "maxResults",
  );
  assertOperationKey(input.startKey, "startKey");
  const now = input.now ?? new Date();

  const existing = await db.memoryExplorationSession.findUnique({
    where: { workspaceId_startKey: { workspaceId: input.workspaceId, startKey: input.startKey } },
  });
  if (existing) {
    assertStartReplay(existing, { agentId: input.agentId, query, maxSteps, maxResults });
    return startView(db, existing);
  }

  const seeds = onlySkillSeeds(
    await createTrgmSimilarityIndex(db).findSeeds(
      input.workspaceId,
      query,
      Math.min(maxResults, 50),
    ),
  );
  try {
    await db.$transaction(async (tx) => {
      const session = await tx.memoryExplorationSession.create({
        data: {
          workspaceId: input.workspaceId,
          agentId: input.agentId,
          query,
          maxSteps,
          maxResults,
          startKey: input.startKey,
          expiresAt: new Date(now.getTime() + MEMORY_EXPLORATION_SESSION_TTL_MS),
        },
      });
      await serveCitations(tx, session.id, 0, seeds, maxResults);
    });
  } catch (error) {
    if (isUniqueViolation(error)) {
      const raced = await db.memoryExplorationSession.findUniqueOrThrow({
        where: {
          workspaceId_startKey: { workspaceId: input.workspaceId, startKey: input.startKey },
        },
      });
      assertStartReplay(raced, { agentId: input.agentId, query, maxSteps, maxResults });
      return startView(db, raced, true);
    }
    throw error;
  }
  const session = await db.memoryExplorationSession.findUniqueOrThrow({
    where: { workspaceId_startKey: { workspaceId: input.workspaceId, startKey: input.startKey } },
  });
  return startView(db, session, true);
}

export async function exploreMemoryStep(
  db: PrismaClient,
  input: {
    workspaceId: string;
    agentId: string;
    sessionId: string;
    operationId: string;
    /** A citation this session already served; the step expands from it. */
    anchor: string;
    relation?: MemoryExplorationRelation;
    limit?: number;
    now?: Date;
  },
): Promise<MemoryExplorationStepView> {
  await requireMemoryExplorer(db, input);
  const limit = clampInt(
    input.limit ?? DEFAULT_EXPLORE_LIMIT,
    1,
    MEMORY_EXPLORATION_MAX_EXPLORE_LIMIT,
    "limit",
  );
  assertOperationKey(input.operationId, "operationId");
  const anchorNode = parseCitationId(input.anchor);
  const requestHash = hashRequest({
    op: "explore",
    anchor: input.anchor,
    relation: input.relation ?? null,
    limit,
  });

  const outcome = await replayOrApply(db, input, requestHash, async (tx, session) => {
    // Retired anchors and relations are refused before the unserved check, so
    // an episode/insight citation is not reported as merely unserved.
    assertDiscoveryAnchor(anchorNode.kind);
    const edgeClasses = input.relation ? RELATION_EDGE_CLASSES[input.relation] : undefined;
    if (edgeClasses) assertPublicExpansionClasses(edgeClasses);
    await assertStepBudget(session);
    const served = await tx.memoryExplorationCitation.findUnique({
      where: {
        sessionId_kind_targetId: {
          sessionId: session.id,
          kind: anchorNode.kind,
          targetId: anchorNode.id,
        },
      },
      select: { id: true },
    });
    if (!served) throw new AppError("INVALID_INPUT", { errorId: "gm-exploration-anchor-unserved" });
    const remainingResults = session.maxResults - session.resultsServed;
    if (remainingResults <= 0)
      throw new AppError("CONFLICT", { errorId: "gm-exploration-results-exhausted" });
    const expansion = await expandMemoryNeighborhood(db, {
      workspaceId: input.workspaceId,
      seeds: [anchorNode],
      limit: Math.min(limit, remainingResults),
      ...(edgeClasses ? { edgeClasses } : {}),
    });
    const items = await serveNodes(tx, session, expansion, session.stepsUsed + 1);
    await consumeStep(tx, session.id);
    return stepPayload("active", items, session.maxSteps - session.stepsUsed - 1);
  });
  return { sessionId: input.sessionId, ...outcome.response, duplicate: outcome.duplicate };
}

export async function redirectMemoryStep(
  db: PrismaClient,
  input: {
    workspaceId: string;
    agentId: string;
    sessionId: string;
    operationId: string;
    query: string;
    now?: Date;
  },
): Promise<MemoryExplorationStepView> {
  await requireMemoryExplorer(db, input);
  const query = clampQuery(input.query);
  assertOperationKey(input.operationId, "operationId");
  const requestHash = hashRequest({ op: "redirect", query });

  const outcome = await replayOrApply(db, input, requestHash, async (tx, session) => {
    await assertStepBudget(session);
    const remainingResults = session.maxResults - session.resultsServed;
    if (remainingResults <= 0)
      throw new AppError("CONFLICT", { errorId: "gm-exploration-results-exhausted" });
    const seeds = onlySkillSeeds(
      await createTrgmSimilarityIndex(db).findSeeds(
        input.workspaceId,
        query,
        Math.min(remainingResults, 50),
      ),
    );
    const items = await serveCitations(
      tx,
      session.id,
      session.stepsUsed + 1,
      seeds,
      remainingResults,
    );
    await consumeStep(tx, session.id);
    return stepPayload("active", items, session.maxSteps - session.stepsUsed - 1);
  });
  return { sessionId: input.sessionId, ...outcome.response, duplicate: outcome.duplicate };
}

export async function closeMemoryExploration(
  db: PrismaClient,
  input: {
    workspaceId: string;
    agentId: string;
    sessionId: string;
    operationId: string;
    found: boolean;
    summary?: string;
    citationIds?: string[];
    now?: Date;
  },
): Promise<MemoryExplorationCloseView> {
  await requireMemoryExplorer(db, input);
  assertOperationKey(input.operationId, "operationId");
  const summary = input.summary?.trim() ?? "";
  if (summary.length > SUMMARY_MAX_LENGTH)
    throw new AppError("INVALID_INPUT", { errorId: "gm-exploration-summary-too-long" });
  const citationIds = [...new Set(input.citationIds ?? [])];
  for (const citationId of citationIds) {
    if (!CITATION_ID.test(citationId))
      throw new AppError("INVALID_INPUT", { errorId: "gm-exploration-citation-malformed" });
  }
  if (input.found && (!summary || citationIds.length === 0))
    throw new AppError("INVALID_INPUT", { errorId: "gm-exploration-found-needs-citations" });
  const requestHash = hashRequest({ op: "close", found: input.found, summary, citationIds });

  const outcome = await replayOrApply(db, input, requestHash, async (tx, session) => {
    await assertSessionUsable(session);
    const served: Array<Pick<MemoryCitation, "citationId" | "kind" | "id">> = [];
    for (const citationId of citationIds) {
      const node = parseCitationId(citationId);
      const row = await tx.memoryExplorationCitation.findUnique({
        where: {
          sessionId_kind_targetId: { sessionId: session.id, kind: node.kind, targetId: node.id },
        },
        select: { id: true },
      });
      if (!row)
        throw new AppError("INVALID_INPUT", { errorId: "gm-exploration-citation-unserved" });
      served.push({ citationId, kind: node.kind, id: node.id });
    }
    await tx.memoryExplorationSession.update({
      where: { id: session.id },
      data: {
        state: "closed",
        found: input.found,
        summary: summary || null,
        closedAt: input.now ?? new Date(),
      },
      select: { id: true },
    });
    return {
      state: "closed" as const,
      found: input.found,
      summary: summary || null,
      citations: served,
    };
  });
  return { sessionId: input.sessionId, ...outcome.response, duplicate: outcome.duplicate };
}

type StepPayload = {
  state: MemoryExplorationState;
  items: MemoryCitation[];
  remainingSteps: number;
};

type StepResponse =
  | StepPayload
  | {
      state: "closed";
      found: boolean;
      summary: string | null;
      citations: Array<Pick<MemoryCitation, "citationId" | "kind" | "id">>;
    };

type SessionRow = {
  id: string;
  workspaceId: string;
  agentId: string;
  query: string;
  maxSteps: number;
  maxResults: number;
  stepsUsed: number;
  resultsServed: number;
  state: string;
  expiresAt: Date;
};

/**
 * The step idempotency ledger. A recorded operation id replays only under a
 * byte-identical request; drift is a conflict. Step effects and the ledger
 * row commit in one transaction, so identical concurrent replays collapse to
 * the winner's recorded response and drift applies nothing.
 */
async function replayOrApply<T extends StepResponse>(
  db: PrismaClient,
  input: {
    workspaceId: string;
    agentId: string;
    sessionId: string;
    operationId: string;
    now?: Date;
  },
  requestHash: string,
  apply: (tx: Prisma.TransactionClient, session: SessionRow) => Promise<T>,
): Promise<{ duplicate: boolean; response: T }> {
  const recorded = await db.memoryExplorationOperation.findUnique({
    where: {
      sessionId_operationId: { sessionId: input.sessionId, operationId: input.operationId },
    },
  });
  if (recorded) {
    if (recorded.requestHash !== requestHash)
      throw new AppError("CONFLICT", { errorId: "gm-exploration-operation-drift" });
    return { duplicate: true, response: recorded.response as T };
  }
  // Recorded operations replay regardless of session state; only fresh steps
  // face the open/expired check (whose expiry flip must also commit on its
  // own, outside the step transaction below).
  await ensureSessionOpenForSteps(db, input);

  const loadSession = async (tx: Prisma.TransactionClient): Promise<SessionRow> => {
    const session = await tx.memoryExplorationSession.findUnique({
      where: { id: input.sessionId },
    });
    if (!session || session.workspaceId !== input.workspaceId || session.agentId !== input.agentId)
      throw new AppError("NOT_FOUND", { errorId: "gm-exploration-session-missing" });
    return session as SessionRow;
  };

  try {
    const response = await db.$transaction(async (tx) => {
      const session = await loadSession(tx);
      const payload = await apply(tx, session);
      await tx.memoryExplorationOperation.create({
        data: {
          sessionId: session.id,
          operationId: input.operationId,
          requestHash,
          response: payload as unknown as Prisma.InputJsonValue,
        },
        select: { id: true },
      });
      return payload;
    });
    return { duplicate: false, response };
  } catch (error) {
    if (isUniqueViolation(error)) {
      const raced = await db.memoryExplorationOperation.findUniqueOrThrow({
        where: {
          sessionId_operationId: { sessionId: input.sessionId, operationId: input.operationId },
        },
      });
      if (raced.requestHash !== requestHash)
        throw new AppError("CONFLICT", { errorId: "gm-exploration-operation-drift" });
      return { duplicate: true, response: raced.response as T };
    }
    throw error;
  }
}

async function assertStepBudget(session: SessionRow): Promise<void> {
  await assertSessionUsable(session);
  if (session.stepsUsed >= session.maxSteps)
    throw new AppError("CONFLICT", { errorId: "gm-exploration-steps-exhausted" });
}

/**
 * Pre-step session check, outside any step transaction: an expired session's
 * state flip must survive the rejection itself, so it commits on its own
 * before the CONFLICT is thrown.
 */
async function ensureSessionOpenForSteps(
  db: PrismaClient,
  input: { workspaceId: string; agentId: string; sessionId: string; now?: Date },
): Promise<void> {
  const session = await db.memoryExplorationSession.findUnique({ where: { id: input.sessionId } });
  if (!session || session.workspaceId !== input.workspaceId || session.agentId !== input.agentId)
    throw new AppError("NOT_FOUND", { errorId: "gm-exploration-session-missing" });
  if (session.state === "closed")
    throw new AppError("CONFLICT", { errorId: "gm-exploration-session-closed" });
  if (
    session.state === "expired" ||
    (input.now ?? new Date()).getTime() > session.expiresAt.getTime()
  ) {
    if (session.state === "active") {
      await db.memoryExplorationSession.update({
        where: { id: session.id },
        data: { state: "expired" },
        select: { id: true },
      });
    }
    throw new AppError("CONFLICT", { errorId: "gm-exploration-session-expired" });
  }
}

async function assertSessionUsable(session: SessionRow): Promise<void> {
  if (session.state === "closed")
    throw new AppError("CONFLICT", { errorId: "gm-exploration-session-closed" });
  if (session.state === "expired")
    throw new AppError("CONFLICT", { errorId: "gm-exploration-session-expired" });
}

async function consumeStep(tx: Prisma.TransactionClient, sessionId: string): Promise<void> {
  await tx.memoryExplorationSession.update({
    where: { id: sessionId },
    data: { stepsUsed: { increment: 1 } },
    select: { id: true },
  });
}

/** Serve trigram seeds as citations, deduplicated against earlier serves. */
async function serveCitations(
  tx: Prisma.TransactionClient,
  sessionId: string,
  step: number,
  seeds: MemorySeed[],
  maxServe: number,
): Promise<MemoryCitation[]> {
  if (!seeds.length) return [];
  const served = await tx.memoryExplorationCitation.findMany({
    where: { sessionId },
    select: { kind: true, targetId: true },
  });
  const already = new Set(served.map((row) => `${row.kind}:${row.targetId}`));
  const fresh = seeds
    .filter((seed) => seed.kind === "skill" && !already.has(`${seed.kind}:${seed.id}`))
    .slice(0, maxServe)
    .map((seed) => ({
      sessionId,
      kind: seed.kind,
      targetId: seed.id,
      snippet: seed.snippet,
      step,
    }));
  if (fresh.length) {
    await tx.memoryExplorationCitation.createMany({ data: fresh, skipDuplicates: true });
    await tx.memoryExplorationSession.update({
      where: { id: sessionId },
      data: { resultsServed: { increment: fresh.length } },
      select: { id: true },
    });
  }
  return fresh.map((row) => ({
    citationId: `${row.kind}:${row.targetId}`,
    kind: row.kind as MemoryCitationKind,
    id: row.targetId,
    snippet: row.snippet,
  }));
}

/** Serve graph-expansion nodes as citations, resolving display snippets. */
async function serveNodes(
  tx: Prisma.TransactionClient,
  session: SessionRow,
  nodes: ExpansionNode[],
  step: number,
): Promise<MemoryCitation[]> {
  const visible = nodes.filter((node) => !isRetiredFromMemoryDiscovery(node.kind));
  const snippets = await snippetsFor(tx, session.workspaceId, visible);
  const seeds: MemorySeed[] = visible
    .filter((node) => snippets.has(`${node.kind}:${node.id}`))
    .map((node) => ({
      kind: node.kind,
      id: node.id,
      score: 0,
      snippet: snippets.get(`${node.kind}:${node.id}`)!,
    }));
  return serveCitations(tx, session.id, step, seeds, session.maxResults - session.resultsServed);
}

async function snippetsFor(
  tx: Prisma.TransactionClient,
  workspaceId: string,
  nodes: ExpansionNode[],
): Promise<Map<string, string>> {
  const map = new Map<string, string>();
  const episodeIds = nodes.filter((n) => n.kind === "episode").map((n) => n.id);
  const insightIds = nodes.filter((n) => n.kind === "insight").map((n) => n.id);
  if (episodeIds.length) {
    const episodes = await tx.memoryEpisode.findMany({
      where: { workspaceId, id: { in: episodeIds } },
      select: { id: true, title: true, body: true },
    });
    for (const episode of episodes)
      map.set(`episode:${episode.id}`, `${episode.title}: ${episode.body}`.slice(0, 280));
  }
  const skillIds = nodes.filter((n) => n.kind === "skill").map((n) => n.id);
  if (skillIds.length) {
    const skills = await tx.$queryRaw<Array<{ id: string; snippet: string }>>`
      SELECT r.id, s.name || ' v' || r.version AS snippet
      FROM learned_skill_revisions r JOIN learned_skills s ON s.id = r."skillId"
      WHERE r."workspaceId" = ${workspaceId}::uuid AND r.id = ANY(${skillIds}::uuid[])`;
    for (const skill of skills) map.set(`skill:${skill.id}`, skill.snippet);
  }
  if (insightIds.length) {
    const insights = await tx.memoryInsight.findMany({
      where: { workspaceId, id: { in: insightIds } },
      select: { id: true, statement: true },
    });
    for (const insight of insights) map.set(`insight:${insight.id}`, insight.statement);
  }
  return map;
}

async function startView(
  db: PrismaClient,
  session: { id: string; query: string; maxSteps: number; state: string },
  fresh = false,
): Promise<MemoryExplorationStartView> {
  const citations = await db.memoryExplorationCitation.findMany({
    where: { sessionId: session.id, step: 0 },
    orderBy: { createdAt: "asc" },
  });
  return {
    sessionId: session.id,
    query: session.query,
    state: "active",
    items: citations.map((row) => ({
      citationId: `${row.kind}:${row.targetId}`,
      kind: row.kind as MemoryCitationKind,
      id: row.targetId,
      snippet: row.snippet,
    })),
    remainingSteps: session.maxSteps,
    duplicate: !fresh,
  };
}

function assertStartReplay(
  session: { agentId: string; query: string; maxSteps: number; maxResults: number },
  request: { agentId: string; query: string; maxSteps: number; maxResults: number },
): void {
  if (
    session.agentId !== request.agentId ||
    session.query !== request.query ||
    session.maxSteps !== request.maxSteps ||
    session.maxResults !== request.maxResults
  )
    throw new AppError("CONFLICT", { errorId: "gm-exploration-start-drift" });
}

function stepPayload(
  state: MemoryExplorationState,
  items: MemoryCitation[],
  remainingSteps: number,
): StepPayload {
  return { state, items, remainingSteps };
}

function onlySkillSeeds(seeds: MemorySeed[]): MemorySeed[] {
  return seeds.filter((seed) => seed.kind === "skill");
}

function parseCitationId(citationId: string): { kind: MemoryCitationKind; id: string } {
  if (!CITATION_ID.test(citationId))
    throw new AppError("INVALID_INPUT", { errorId: "gm-exploration-citation-malformed" });
  const [kind, id] = citationId.split(":") as [MemoryCitationKind, string];
  return { kind, id };
}

function hashRequest(payload: unknown): string {
  return createHash("sha256").update(canonicalJson(payload)).digest("hex");
}

function canonicalJson(value: unknown): string {
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  const entries = Object.entries(value as Record<string, unknown>)
    .filter(([, v]) => v !== undefined)
    .sort(([a], [b]) => (a < b ? -1 : 1));
  return `{${entries.map(([k, v]) => `${JSON.stringify(k)}:${canonicalJson(v)}`).join(",")}}`;
}

function clampQuery(query: string): string {
  const trimmed = query.trim();
  if (!trimmed || trimmed.length > QUERY_MAX_LENGTH)
    throw new AppError("INVALID_INPUT", { errorId: "gm-exploration-query-invalid" });
  return trimmed;
}

function clampInt(value: number, min: number, max: number, field: string): number {
  if (!Number.isInteger(value) || value < min || value > max)
    throw new AppError("INVALID_INPUT", { errorId: "gm-exploration-budget-invalid" });
  void field;
  return value;
}

function assertOperationKey(key: string, field: string): void {
  if (!OPERATION_KEY.test(key))
    throw new AppError("INVALID_INPUT", { errorId: "gm-exploration-operation-key-invalid" });
  void field;
}

function isUniqueViolation(error: unknown): boolean {
  return (
    typeof error === "object" &&
    error !== null &&
    "code" in error &&
    (error as { code?: unknown }).code === "P2002"
  );
}
