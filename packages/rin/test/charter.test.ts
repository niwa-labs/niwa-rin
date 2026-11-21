// Rin's charter without a host: corrections that repeat ask for a rule, and only the owner's word makes one.

import { describe, expect, test } from "bun:test";

import type { Row } from "../src/attention.ts";
import { charterText, dueFor, foldCharter, ruledRules } from "../src/charter.ts";

const owner = { kind: "owner" as const };
const niwa = { kind: "niwa" as const, by: "rin" };

function rows(...given: Array<[string, unknown]>): Row[] {
  return given.map(([type, data], index) => ({ type, data, at: (index + 1) * 1000, seq: index + 1 }));
}

const corrected = (n: number, about: string, what: string) => [
  "rin.corrected",
  { correction: `cor-00000000${n.toString(16).padStart(2, "0")}`, about, what, by: owner },
] as [string, unknown];

describe("consolidation", () => {
  test("one correction is not yet a pattern; a second one about the same thing is", () => {
    const one = foldCharter(rows(corrected(1, "attention.ci", "Do not wake me for CI on drafts")));
    expect(dueFor(one, "attention.ci", 2)).toBeUndefined();
    const two = foldCharter(
      rows(corrected(1, "attention.ci", "Do not wake me for CI on drafts"), corrected(2, "tone", "Shorter"), corrected(3, "attention.ci", "Draft PRs can wait")),
    );
    expect(dueFor(two, "attention.ci", 2)).toEqual(["cor-0000000001", "cor-0000000003"]);
    expect(dueFor(two, "tone", 2)).toBeUndefined();
  });

  test("corrections already put to her do not count again; the ones after them start a new count", () => {
    const before = rows(
      corrected(1, "attention.ci", "a"),
      corrected(2, "attention.ci", "b"),
      ["rin.charter.due", { about: "attention.ci", corrections: ["cor-0000000001", "cor-0000000002"] }],
      corrected(3, "attention.ci", "c"),
    );
    expect(dueFor(foldCharter(before), "attention.ci", 2)).toBeUndefined();
    const [fourth] = rows(corrected(4, "attention.ci", "d"));
    const after = [...before, { ...fourth!, seq: before.length + 1, at: 9000 }];
    expect(dueFor(foldCharter(after), "attention.ci", 2)).toEqual(["cor-0000000003", "cor-0000000004"]);
  });

  test("while a rule about it waits for the owner, nothing more is due", () => {
    const state = foldCharter(
      rows(
        corrected(1, "attention.ci", "a"),
        ["rin.charter.proposed", { rule: "rule-0000000001", about: "attention.ci", text: "CI on drafts waits for the morning", corrections: ["cor-0000000001"], by: niwa }],
        corrected(2, "attention.ci", "b"),
        corrected(3, "attention.ci", "c"),
      ),
    );
    expect(dueFor(state, "attention.ci", 2)).toBeUndefined();
  });
});

describe("the charter", () => {
  const proposal = (rule: string, text: string) =>
    ["rin.charter.proposed", { rule, about: "attention.ci", text, corrections: [], by: niwa }] as [string, unknown];

  test("holds only the rules the owner confirmed and has not retired", () => {
    const state = foldCharter(
      rows(
        proposal("rule-0000000001", "CI on drafts waits for the morning"),
        proposal("rule-0000000002", "Never mention CI"),
        proposal("rule-0000000003", "Say a red main branch at once"),
        ["rin.charter.ruled", { rule: "rule-0000000001", by: owner }],
        ["rin.charter.declined", { rule: "rule-0000000002", why: "declined" }],
        ["rin.charter.ruled", { rule: "rule-0000000003", by: owner }],
        ["rin.charter.retired", { rule: "rule-0000000003" }],
      ),
    );
    expect(ruledRules(state).map((rule) => rule.rule)).toEqual(["rule-0000000001"]);
    expect(state.rules.get("rule-0000000002")?.status).toBe("declined");
    expect(charterText(ruledRules(state))).toBe("- rule-0000000001 (attention.ci): CI on drafts waits for the morning");
  });

  test("a rule's corrections are marked covered by it", () => {
    const state = foldCharter(
      rows(corrected(1, "tone", "Shorter"), ["rin.charter.proposed", { rule: "rule-0000000001", about: "tone", text: "Three lines on Telegram", corrections: ["cor-0000000001"], by: niwa }]),
    );
    expect(state.corrections[0]?.rule).toBe("rule-0000000001");
  });
});
