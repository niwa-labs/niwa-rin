// Whether the owner is working now: the native sessions he attached, as their watch last saw them.

import { expect, test } from "bun:test";

import type { Row } from "../src/attention.ts";
import { workingNow } from "../src/presence.ts";

function rows(...given: Array<[string, unknown]>): Row[] {
  return given.map(([type, data], index) => ({ type, data, at: (index + 1) * 1000, seq: index + 1 }));
}

const s1 = { harness: "claude", native: "s1" };
const s2 = { harness: "codex", native: "s2" };

test("an attached session works until it pauses, ends or is let go of", () => {
  const attached = rows(
    ["agent.attached", { agent: "rin", session: "claude s1", cwd: "/work/a" }],
    ["agent.attached", { agent: "lead", session: "codex s2", cwd: "/work/b" }],
  );
  expect(workingNow(attached).map((one) => one.session)).toEqual(["claude s1", "codex s2"]);
  expect(workingNow([...attached, ...rows(["history.session.paused", { session: s1, upto: "l1", why: "idle" }])].map(renumber)).map((one) => one.session)).toEqual(["codex s2"]);
  expect(workingNow([...attached, ...rows(["history.session.ended", { session: s2, certainty: "guessed", why: "idle" }])].map(renumber)).map((one) => one.session)).toEqual(["claude s1"]);
  expect(workingNow([...attached, ...rows(["agent.detached", { agent: "rin", session: "claude s1" }])].map(renumber)).map((one) => one.session)).toEqual(["codex s2"]);
});

test("progress after a pause says he is back", () => {
  const back = rows(
    ["agent.attached", { agent: "rin", session: "claude s1", cwd: "/work/a" }],
    ["history.session.paused", { session: s1, upto: "l1", why: "idle" }],
    ["session.progress", { session: s1, done: 2, total: 5 }],
  );
  expect(workingNow(back)).toEqual([{ session: "claude s1", cwd: "/work/a", agent: "rin" }]);
});

/** Rows put together from two lists, numbered again in order. */
function renumber(row: Row, index: number): Row {
  return { ...row, seq: index + 1, at: (index + 1) * 1000 };
}
