import { expect, test } from "bun:test";
import { isAppError } from "../src/lib/app-error";
import {
  PUBLIC_EXPANSION_EDGE_CLASSES,
  RETIRED_FROM_MEMORY_DISCOVERY,
  assertDiscoveryAnchor,
  assertOfferTargets,
  assertPublicExpansionClasses,
  discoveryDisposition,
} from "../src/server/group-memory/memory-discovery-eligibility";

test("episode and insight are retired before use-class, skill stays a candidate", () => {
  expect(discoveryDisposition("episode")).toEqual({
    disposition: RETIRED_FROM_MEMORY_DISCOVERY,
  });
  expect(discoveryDisposition("insight")).toEqual({
    disposition: RETIRED_FROM_MEMORY_DISCOVERY,
  });
  expect(discoveryDisposition("skill")).toEqual({ disposition: "eligible_candidate" });
  expect(PUBLIC_EXPANSION_EDGE_CLASSES).not.toContain("episodeInsight");
  expect(PUBLIC_EXPANSION_EDGE_CLASSES).toContain("skillLineage");
});

test("a new anchor, offer, or expansion that names a retired object is refused", () => {
  expect(() => assertDiscoveryAnchor("episode")).toThrow(RETIRED_FROM_MEMORY_DISCOVERY);
  expect(() => assertOfferTargets(["skill", "insight"])).toThrow(RETIRED_FROM_MEMORY_DISCOVERY);
  expect(() => assertPublicExpansionClasses(["episodeInsight"])).toThrow(
    RETIRED_FROM_MEMORY_DISCOVERY,
  );
  expect(() => assertDiscoveryAnchor("skill")).not.toThrow();
  expect(() => assertOfferTargets(["skill"])).not.toThrow();
  try {
    assertDiscoveryAnchor("insight");
  } catch (error) {
    expect(isAppError(error) && error.errorId).toBe(RETIRED_FROM_MEMORY_DISCOVERY);
  }
});
