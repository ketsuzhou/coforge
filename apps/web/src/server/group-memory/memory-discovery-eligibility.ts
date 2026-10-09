import { AppError } from "../../lib/app-error";

/**
 * Q160-B: Coforge Episode and Insight leave new memory discovery.
 * Native records stay; this module only decides what a new public
 * discovery, expansion, or offer may still name.
 */

export const RETIRED_FROM_MEMORY_DISCOVERY = "retired_from_memory_discovery";

export type DiscoveryObjectKind = "episode" | "insight" | "skill";

export type DiscoveryDisposition =
  | { disposition: typeof RETIRED_FROM_MEMORY_DISCOVERY }
  | { disposition: "eligible_candidate" };

const RETIRED_KINDS = new Set<DiscoveryObjectKind>(["episode", "insight"]);

export function discoveryDisposition(kind: DiscoveryObjectKind): DiscoveryDisposition {
  if (kind === "skill") return { disposition: "eligible_candidate" };
  if (RETIRED_KINDS.has(kind)) return { disposition: RETIRED_FROM_MEMORY_DISCOVERY };
  return { disposition: RETIRED_FROM_MEMORY_DISCOVERY };
}

export function isRetiredFromMemoryDiscovery(kind: string): boolean {
  return kind === "episode" || kind === "insight";
}

export function assertDiscoveryAnchor(kind: string): void {
  if (isRetiredFromMemoryDiscovery(kind)) {
    throw new AppError("INVALID_INPUT", { errorId: RETIRED_FROM_MEMORY_DISCOVERY });
  }
}

export function assertOfferTargets(kinds: readonly string[]): void {
  if (kinds.some((kind) => isRetiredFromMemoryDiscovery(kind))) {
    throw new AppError("INVALID_INPUT", { errorId: RETIRED_FROM_MEMORY_DISCOVERY });
  }
}

/** Public expansion relations after Episode/Insight retirement. */
export const PUBLIC_EXPANSION_EDGE_CLASSES = ["similar", "skillGrounding", "skillLineage"] as const;

export type PublicExpansionEdgeClass = (typeof PUBLIC_EXPANSION_EDGE_CLASSES)[number];

const RETIRED_EDGE_CLASSES = new Set(["episodeInsight", "interactions"]);

export function assertPublicExpansionClasses(classes: readonly string[]): void {
  if (classes.some((name) => RETIRED_EDGE_CLASSES.has(name))) {
    throw new AppError("INVALID_INPUT", { errorId: RETIRED_FROM_MEMORY_DISCOVERY });
  }
}
