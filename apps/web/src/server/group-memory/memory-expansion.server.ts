import type { PrismaClient } from "../../../generated/client";
import {
  PUBLIC_EXPANSION_EDGE_CLASSES,
  assertDiscoveryAnchor,
  assertPublicExpansionClasses,
  isRetiredFromMemoryDiscovery,
} from "./memory-discovery-eligibility";

/**
 * Provenance-edge neighborhood expansion (ADR 0052-I, Q160-B).
 *
 * One hop from each anchor along the requested edge classes. Episode and
 * Insight are retired from public expansion: they cannot be an anchor, and
 * they are never emitted as nodes. Explicit `episodeInsight` or
 * `interactions` requests are refused. Historical provenance rows stay in
 * their native tables for audit; this function does not read them into a
 * new public neighborhood.
 *
 * Public edge classes:
 *  - similar        trigram neighborhood over active, current SkillRevisions;
 *  - skillGrounding accepted, but it no longer walks to episode/insight
 *                   evidence (those kinds are not public targets);
 *  - skillLineage   the supersedes chain within one skill lineage.
 */

export type MemoryCitationKind = "episode" | "insight" | "skill";

export type MemoryExpansionEdgeClass =
  | "similar"
  | "interactions"
  | "episodeInsight"
  | "skillGrounding"
  | "skillLineage";

export const MEMORY_EXPANSION_EDGE_CLASSES: MemoryExpansionEdgeClass[] = [
  ...PUBLIC_EXPANSION_EDGE_CLASSES,
];

export type ExpansionSeed = { kind: MemoryCitationKind; id: string };

export type ExpansionNode = {
  kind: MemoryCitationKind;
  id: string;
  snippet: string;
  via: MemoryExpansionEdgeClass;
};

const MIN_SIMILARITY = 0.2;

export async function expandMemoryNeighborhood(
  db: PrismaClient,
  input: {
    workspaceId: string;
    seeds: ExpansionSeed[];
    limit?: number;
    edgeClasses?: MemoryExpansionEdgeClass[];
  },
): Promise<ExpansionNode[]> {
  for (const seed of input.seeds) assertDiscoveryAnchor(seed.kind);
  const requested = input.edgeClasses ?? MEMORY_EXPANSION_EDGE_CLASSES;
  assertPublicExpansionClasses(requested);
  const classes = new Set<string>(requested);
  const limit = Math.min(Math.max(input.limit ?? 20, 1), 20);
  const seen = new Set(input.seeds.map((seed) => `${seed.kind}:${seed.id}`));
  const collected: ExpansionNode[] = [];
  const push = (node: ExpansionNode) => {
    if (isRetiredFromMemoryDiscovery(node.kind)) return;
    const key = `${node.kind}:${node.id}`;
    if (seen.has(key)) return;
    seen.add(key);
    collected.push(node);
  };

  const skillIds = input.seeds.filter((s) => s.kind === "skill").map((s) => s.id);

  // skillGrounding remains a public class so existing callers can name it.
  // Its only historical targets were episode/insight evidence, which this
  // path must not emit. Skill-to-skill hops are skillLineage and similar.

  if (classes.has("skillLineage") && skillIds.length) {
    const rows = await db.$queryRaw<ExpansionNode[]>`
      SELECT 'skill' AS kind, r.id AS id, s.name || ' v' || r.version AS snippet, 'skillLineage' AS via
      FROM learned_skill_revisions anchor
      JOIN learned_skills s ON s.id = anchor."skillId"
      JOIN learned_skill_revisions r ON r."skillId" = anchor."skillId" AND r.id <> anchor.id
      WHERE anchor.id = ANY(${skillIds}::uuid[])
    `;
    rows.forEach(push);
  }

  if (classes.has("similar") && skillIds.length) {
    const anchors = await loadAnchorTexts(db, input.workspaceId, skillIds);
    for (const anchor of anchors) {
      if (collected.length >= limit) break;
      const rows = await db.$queryRaw<ExpansionNode[]>`
        SELECT 'skill' AS kind, r.id AS id, s.name || ' v' || r.version AS snippet,
               'similar' AS via
        FROM learned_skill_revisions r
        JOIN learned_skills s ON s.id = r."skillId" AND s."currentRevisionId" = r.id
        WHERE r."workspaceId" = ${input.workspaceId}::uuid
          AND r.state = 'active'
          AND word_similarity(${anchor.text}, r."searchText") >= ${MIN_SIMILARITY}
        ORDER BY word_similarity(${anchor.text}, r."searchText") DESC
        LIMIT ${limit}
      `;
      rows.forEach(push);
    }
  }

  return collected.filter((node) => !isRetiredFromMemoryDiscovery(node.kind)).slice(0, limit);
}

async function loadAnchorTexts(
  db: PrismaClient,
  workspaceId: string,
  skillIds: string[],
): Promise<Array<{ text: string }>> {
  if (!skillIds.length) return [];
  return db.$queryRaw<Array<{ text: string }>>`
    SELECT "searchText" AS text FROM learned_skill_revisions
    WHERE "workspaceId" = ${workspaceId}::uuid AND id = ANY(${skillIds}::uuid[])`;
}
