import type { PrismaClient } from "../../../generated/client";
import { AppError } from "../../lib/app-error";
import { ACTIVE_AGENT_WHERE } from "../agents/active-agent.server";
import { assertOfferTargets } from "./memory-discovery-eligibility";
import { requireMemoryExplorer } from "./memory-exploration.server";

/**
 * Memory Offer publication (ADR 0052-E).
 *
 * The exploring Memory Agent composes an offer (body + provenance citations);
 * this module enforces the mechanical disciplines before anything becomes
 * visible:
 *
 * - sender fence: only the designated Memory Agent may publish;
 * - per-target cooldown: the same SkillRevision is not delivered to the same
 *   Agent within 7 days;
 * - an explicit @-ask bypasses the cooldown and the bypass is recorded;
 * - idempotent replay of a historical operation returns the recorded
 *   delivery before any new-publication check. A new offer that names an
 *   Insight is then refused with retired_from_memory_discovery, and
 *   explicitAsk does not revive it;
 * - all-or-none: the message, the structured mention row that routes it, the
 *   wake delivery, and the cooldown records commit in one transaction.
 *
 * @text in the body is display-only; routing is the mention row, never parsed
 * text. Suppressed targets never publish anything; if every candidate is
 * suppressed the Memory Agent stays silent for that message. Delivery rows
 * double as the shadow gate's signal substrate (ADR 0052-D, slice 5).
 */

export const MEMORY_OFFER_COOLDOWN_MS = 7 * 24 * 60 * 60_000;
const MAX_BODY_LENGTH = 4000;
const MAX_TARGETS_PER_OFFER = 10;

export type MemoryOfferTarget = { kind: "insight"; id: string } | { kind: "skill"; id: string };

export type MemoryOfferSuppression = { targetRef: string; reason: "cooldown" };

export type MemoryOfferResult =
  | { published: true; duplicate: boolean; messageId: string; targetRefs: string[] }
  | { published: false; suppressed: MemoryOfferSuppression[] };

export async function publishMemoryOffer(
  db: PrismaClient,
  input: {
    workspaceId: string;
    /** The designated Memory Agent publishing the offer. */
    memoryAgentId: string;
    /** The public channel the offer is posted in. */
    conversationId: string;
    /** The Agent the offer names (the mention target). */
    targetAgentId: string;
    /** Provenance targets backing every claim the body makes. */
    targets: MemoryOfferTarget[];
    body: string;
    /** Caller idempotency key; byte-replays map to the same offer. */
    operationKey: string;
    /** True when the target Agent explicitly @-asked: cooldown bypass. */
    explicitAsk?: boolean;
    now?: Date;
  },
): Promise<MemoryOfferResult> {
  await requireMemoryExplorer(db, { workspaceId: input.workspaceId, agentId: input.memoryAgentId });
  const body = input.body.trim();
  if (!body || body.length > MAX_BODY_LENGTH)
    throw new AppError("INVALID_INPUT", { errorId: "gm-offer-body-invalid" });
  const targets = dedupeTargets(input.targets);
  if (!targets.length || targets.length > MAX_TARGETS_PER_OFFER)
    throw new AppError("INVALID_INPUT", { errorId: "gm-offer-targets-invalid" });

  const replay = await replayPublishedOffer(db, input, targets);
  if (replay) return replay;
  assertOfferTargets(targets.map((target) => target.kind));

  const channel = await db.conversation.findFirst({
    where: { id: input.conversationId, workspaceId: input.workspaceId, channelName: { not: null } },
    select: { id: true, channelName: true },
  });
  if (!channel) throw new AppError("INVALID_INPUT", { errorId: "gm-offer-not-public-channel" });

  const senderMember = await db.conversationMember.findFirst({
    where: {
      conversationId: channel.id,
      workspaceId: input.workspaceId,
      agentId: input.memoryAgentId,
    },
    select: { id: true },
  });
  if (!senderMember) throw new AppError("INVALID_INPUT", { errorId: "gm-offer-sender-not-member" });

  const target = await db.agent.findFirst({
    where: {
      id: input.targetAgentId,
      workspaceId: input.workspaceId,
      ...ACTIVE_AGENT_WHERE,
    },
    select: { id: true, name: true },
  });
  if (!target) throw new AppError("NOT_FOUND", { errorId: "gm-offer-target-missing" });
  const targetMember = await db.conversationMember.findFirst({
    where: { conversationId: channel.id, workspaceId: input.workspaceId, agentId: target.id },
    select: { id: true },
  });
  if (!targetMember) throw new AppError("INVALID_INPUT", { errorId: "gm-offer-target-not-member" });

  await assertTargetsKnown(db, input.workspaceId, targets);

  const now = input.now ?? new Date();
  const suppressed: MemoryOfferSuppression[] = [];
  const fresh: MemoryOfferTarget[] = [];
  for (const candidate of targets) {
    if (!input.explicitAsk) {
      const cooldown = await db.memoryOfferDelivery.findFirst({
        where: {
          workspaceId: input.workspaceId,
          agentId: target.id,
          targetRef: refOf(candidate),
          deliveredAt: { gt: new Date(now.getTime() - MEMORY_OFFER_COOLDOWN_MS) },
        },
        select: { id: true },
      });
      if (cooldown) {
        suppressed.push({ targetRef: refOf(candidate), reason: "cooldown" });
        continue;
      }
    }
    fresh.push(candidate);
  }
  if (!fresh.length) return { published: false, suppressed };

  const messageId = await db.$transaction(async (tx) => {
    const latest = await tx.message.findFirst({
      where: { conversationId: channel.id },
      orderBy: { sequence: "desc" },
      select: { sequence: true },
    });
    const sequence = (latest?.sequence ?? 0) + 1;
    const message = await tx.message.create({
      data: {
        workspaceId: input.workspaceId,
        conversationId: channel.id,
        senderMemberId: senderMember.id,
        body,
        sequence,
      },
      select: { id: true },
    });
    // Structured routing: the mention row is the route; body @text is display.
    await tx.messageMention.create({
      data: {
        messageId: message.id,
        conversationId: channel.id,
        workspaceId: input.workspaceId,
        memberId: targetMember.id,
        kind: "agent",
        actorId: target.id,
        handle: target.name,
      },
      select: { messageId: true },
    });
    // A mention pierces mute and wakes exactly the named Agent (ADR 0048
    // directed delivery); the delivery row is the wake fact.
    await tx.agentMessageDelivery.create({
      data: {
        messageId: message.id,
        workspaceId: input.workspaceId,
        conversationId: channel.id,
        agentId: target.id,
        sequence,
      },
      select: { deliveryId: true },
    });
    await tx.memoryOfferDelivery.createMany({
      data: fresh.map((candidate) => ({
        workspaceId: input.workspaceId,
        agentId: target.id,
        targetKind: candidate.kind,
        targetRef: refOf(candidate),
        insightId: candidate.kind === "insight" ? candidate.id : null,
        skillRevisionId: candidate.kind === "skill" ? candidate.id : null,
        conversationId: channel.id,
        messageId: message.id,
        explicitAsk: input.explicitAsk === true,
        operationKey: input.operationKey,
        deliveredAt: now,
      })),
    });
    return message.id;
  });
  return { published: true, duplicate: false, messageId, targetRefs: fresh.map(refOf) };
}

function refOf(target: MemoryOfferTarget): string {
  return `${target.kind}:${target.id}`;
}

function dedupeTargets(targets: MemoryOfferTarget[]): MemoryOfferTarget[] {
  const seen = new Set<string>();
  return targets.filter((target) => {
    const key = refOf(target);
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

async function assertTargetsKnown(
  db: PrismaClient,
  workspaceId: string,
  targets: MemoryOfferTarget[],
): Promise<void> {
  const insightIds = targets.filter((t) => t.kind === "insight").map((t) => t.id);
  const skillIds = targets.filter((t) => t.kind === "skill").map((t) => t.id);
  if (insightIds.length) {
    const rows = await db.memoryInsight.findMany({
      where: { workspaceId, id: { in: insightIds } },
      select: { id: true },
    });
    if (rows.length !== insightIds.length)
      throw new AppError("NOT_FOUND", { errorId: "gm-offer-insight-missing" });
  }
  if (skillIds.length) {
    // Skill offers always carry the lineage head; retired or superseded
    // revisions are not offerable.
    const rows = await db.$queryRaw<Array<{ id: string }>>`
      SELECT r.id FROM learned_skill_revisions r
      JOIN learned_skills s ON s.id = r."skillId" AND s."currentRevisionId" = r.id
      WHERE r."workspaceId" = ${workspaceId}::uuid AND r.state = 'active'
        AND r.id = ANY(${skillIds}::uuid[])`;
    if (rows.length !== skillIds.length)
      throw new AppError("NOT_FOUND", { errorId: "gm-offer-skill-missing" });
  }
}

async function replayPublishedOffer(
  db: PrismaClient,
  input: {
    workspaceId: string;
    targetAgentId: string;
    conversationId: string;
    operationKey: string;
  },
  targets: MemoryOfferTarget[],
): Promise<MemoryOfferResult | undefined> {
  const rows = await db.memoryOfferDelivery.findMany({
    where: { workspaceId: input.workspaceId, operationKey: input.operationKey },
    orderBy: { targetRef: "asc" },
  });
  if (!rows.length) return undefined;
  const replayShape = {
    targetAgentId: input.targetAgentId,
    conversationId: input.conversationId,
    targetRefs: targets.map(refOf).sort(),
  };
  const recordedShape = {
    targetAgentId: rows[0]!.agentId,
    conversationId: rows[0]!.conversationId,
    targetRefs: rows.map((row) => row.targetRef),
  };
  if (JSON.stringify(replayShape) !== JSON.stringify(recordedShape))
    throw new AppError("CONFLICT", { errorId: "gm-offer-operation-drift" });
  return {
    published: true,
    duplicate: true,
    messageId: rows[0]!.messageId,
    targetRefs: rows.map((row) => row.targetRef),
  };
}
