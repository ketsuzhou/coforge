import { expect, test } from "bun:test";
import { clockLabel, fullLabel } from "../src/features/conversations/message-row";

/**
 * Guards the hover tooltip on a chat timestamp (#459: "聊天区时间hover的时候显示全部时间").
 *
 * The row prints `clockLabel` — hour and minute only — so a message from another day shows a time
 * with no day, and the day divider is the only thing carrying the date. The tooltip has to supply
 * what the row hides: the day, and enough of the clock to identify the moment. `fullLabel` is that
 * text, and it deliberately mirrors `clockLabel`'s four arguments so a call site forwards
 * `timeFormat` and `timeZone` rather than dropping them.
 *
 * The zone and the 12/24-hour choice are the parts a reader would miss: `dayLabel`/`clockLabel` are
 * documented in the feature's AGENTS.md as taking the viewer's zone, and a `fullLabel` that ignored
 * the argument handed to it would render the tooltip in the wrong zone while looking correct.
 */
const INSTANT = "2026-10-06T13:56:34.000Z";

test("fullLabel carries the day, which the row's clockLabel omits", () => {
  // 24h here so the case isolates the day; the 12/24 choice has its own test.
  const full = fullLabel(INSTANT, "en-US", "24h", "UTC");
  const clock = clockLabel(INSTANT, "en-US", "24h", "UTC");

  expect(full).toContain("2026");
  expect(full).toContain("Oct");
  expect(full).toContain("13:56");
  expect(clock).not.toContain("2026");
});

test("fullLabel shows seconds, so two messages in the same minute stay distinguishable", () => {
  expect(fullLabel(INSTANT, "en-US", "24h", "UTC")).toContain("34");
  expect(clockLabel(INSTANT, "en-US", "24h", "UTC")).not.toContain("34");
});

test("fullLabel formats in the zone it is given, not the host's", () => {
  // 13:56 UTC is 21:56 in Shanghai and 06:56 in Los Angeles (the same day, in this case).
  // 24h so a 12-hour default cannot hide a zone mismatch behind an AM/PM suffix.
  expect(fullLabel(INSTANT, "en-US", "24h", "Asia/Shanghai")).toContain("21:56");
  expect(fullLabel(INSTANT, "en-US", "24h", "America/Los_Angeles")).toContain("06:56");
  expect(fullLabel(INSTANT, "en-US", "24h", "Asia/Shanghai")).toBe(
    fullLabel(INSTANT, "en-US", "24h", "Asia/Shanghai"),
  );
});

test("fullLabel honours the viewer's 12/24-hour choice", () => {
  // The pair is the assertion: a 12-hour label is not the 24-hour one for the same instant.
  const twelve = fullLabel(INSTANT, "en-US", "12h", "UTC");
  const twentyFour = fullLabel(INSTANT, "en-US", "24h", "UTC");
  expect(twentyFour).toContain("13:56");
  expect(twelve).not.toBe(twentyFour);
  expect(twelve).toContain("01:56");
  expect(twelve).toMatch(/PM/i);
});

test("fullLabel is empty without a locale, matching clockLabel", () => {
  // The chat is client-rendered, but both labels keep the no-locale branch so a caller that
  // forgets the locale degrades the same way in either one.
  expect(fullLabel(INSTANT)).toBe("");
  expect(clockLabel(INSTANT)).toBe("");
});
