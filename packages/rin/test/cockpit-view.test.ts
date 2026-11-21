// What Rin's page shows, without React: what waits for the owner, what she told him, her charter, the tile.

import { expect, test } from "bun:test";

import { attentionGroups, charterRows, ledAgents, tileText, whyText } from "../src/cockpit/view.ts";
import type { AttentionView, RuleView } from "../src/cockpit/actions.ts";

const item = (n: number, status: AttentionView["status"], extra: Partial<AttentionView> = {}): AttentionView => ({
  item: `att-00000000${n.toString().padStart(2, "0")}`,
  text: `item ${n}`,
  status,
  at: n * 1000,
  ...extra,
});

test("what waits comes first, then what she told him, then what is closed, newest first in each", () => {
  const groups = attentionGroups([item(1, "said"), item(2, "held", { why: "next-contact" }), item(3, "dropped"), item(4, "sending"), item(5, "held", { why: "quiet-hours" }), item(6, "brought"), item(7, "dismissed")]);
  expect(groups.waiting.map((one) => one.text)).toEqual(["item 5", "item 4", "item 2"]);
  expect(groups.told.map((one) => one.text)).toEqual(["item 6", "item 1"]);
  expect(groups.closed.map((one) => one.text)).toEqual(["item 7", "item 3"]);
});

test("each item says why it waits and how often its occasion came up", () => {
  expect(whyText(item(1, "held", { why: "next-contact" }))).toBe("for your next contact");
  expect(whyText(item(1, "held", { why: "quiet-hours" }))).toBe("after your quiet hours");
  expect(whyText(item(1, "held", { why: "ceiling", count: 3 }))).toBe("past the safety ceiling · came up 3 times");
  expect(whyText(item(1, "held", { why: "undelivered" }))).toBe("could not reach you");
  expect(whyText(item(1, "sending"))).toBe("on its way");
  expect(whyText(item(1, "said", { count: 1 }))).toBe("told you");
});

test("the tile counts what waits for him", () => {
  expect(tileText([])).toBe("Nothing waits for you");
  expect(tileText([item(1, "held"), item(2, "said")])).toBe("1 thing waits for you");
  expect(tileText([item(1, "held"), item(2, "sending"), item(3, "held")])).toBe("3 things wait for you");
});

test("the charter shows what waits for his word first, then the rules, then the rest", () => {
  const rule = (n: number, status: RuleView["status"]): RuleView => ({ rule: `rule-00000000${n}0`, about: "tone", text: `rule ${n}`, status, corrections: Array.from({ length: n }, (_, i) => `cor-000000000${i}`) });
  const rows = charterRows([rule(1, "ruled"), rule(2, "declined"), rule(3, "proposed"), rule(4, "retired")]);
  expect(rows.map((row) => [row.text, row.label, row.corrections])).toEqual([
    ["rule 3", "waits for your word", 3],
    ["rule 1", "in force", 1],
    ["rule 2", "declined", 2],
    ["rule 4", "retired", 4],
  ]);
});

test("the agents she leads are every agent but herself", () => {
  const agents = [
    { name: "rin", status: "asleep" as const, source: "config" as const },
    { name: "lead", status: "working" as const, source: "runtime" as const },
  ];
  expect(ledAgents(agents).map((one) => one.name)).toEqual(["lead"]);
});
