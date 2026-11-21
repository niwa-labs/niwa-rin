// Rin's attention without a host: when a decision reaches the owner, what an occasion is, what waits for him.

import { describe, expect, test } from "bun:test";

import {
  DEFAULT_CEILING,
  briefingText,
  ceilingLeft,
  foldAttention,
  inQuietHours,
  insistRefusal,
  pendingAbout,
  noticeOf,
  quietEnds,
  repeatRefusal,
  routeOf,
  type Row,
} from "../src/attention.ts";
import type { Decision, Subject } from "../src/records.ts";

const HOUR = 3_600_000;
/** A moment in the local time of the machine, as the quiet hours are read. */
const local = (day: number, hour: number, minute = 0) => new Date(2026, 10, day, hour, minute).getTime();
const QUIET = { from: "23:00", to: "08:00" };

describe("quiet hours", () => {
  test("hours that cross midnight hold on both sides of it", () => {
    expect(inQuietHours(local(20, 23, 30), QUIET)).toBe(true);
    expect(inQuietHours(local(21, 2), QUIET)).toBe(true);
    expect(inQuietHours(local(21, 7, 59), QUIET)).toBe(true);
    expect(inQuietHours(local(21, 8), QUIET)).toBe(false);
    expect(inQuietHours(local(21, 22, 59), QUIET)).toBe(false);
  });

  test("hours within one day hold only between their ends", () => {
    const lunch = { from: "13:00", to: "14:00" };
    expect(inQuietHours(local(21, 13, 30), lunch)).toBe(true);
    expect(inQuietHours(local(21, 12, 59), lunch)).toBe(false);
    expect(inQuietHours(local(21, 14), lunch)).toBe(false);
  });

  test("they end at the next 'to' on either side of midnight", () => {
    expect(quietEnds(local(20, 23, 30), QUIET)).toBe(local(21, 8));
    expect(quietEnds(local(21, 6), QUIET)).toBe(local(21, 8));
    expect(quietEnds(local(21, 9), QUIET)).toBeUndefined();
  });

  test("a time of day that is not one is refused", () => {
    expect(() => inQuietHours(local(21, 1), { from: "25:00", to: "08:00" })).toThrow();
    expect(() => inQuietHours(local(21, 1), { from: "7", to: "08:00" })).toThrow();
  });
});

describe("the safety ceiling", () => {
  test("counts what was said now within its window only", () => {
    const at = local(21, 12);
    const said = [at - 25 * HOUR, at - 23 * HOUR, at - HOUR];
    expect(ceilingLeft(said, at, { count: 3, windowMs: 24 * HOUR })).toBe(1);
    expect(ceilingLeft(said, at, { count: 2, windowMs: 24 * HOUR })).toBe(0);
  });

  test("is data with a default window of a day", () => {
    expect(DEFAULT_CEILING.count).toBeGreaterThan(6);
    expect(DEFAULT_CEILING.windowMs).toBe(24 * HOUR);
  });
});

describe("routing a decision", () => {
  const day = local(21, 12);
  const base = { at: day, quiet: QUIET, ceiling: { count: 2, windowMs: 24 * HOUR }, said: [] as number[] };

  test("silence and a note reach nobody", () => {
    expect(routeOf("silent", base)).toEqual({ kind: "keep" });
    expect(routeOf("note", base)).toEqual({ kind: "keep" });
  });

  test("the next contact holds until the owner is in touch", () => {
    expect(routeOf("next-contact", base)).toEqual({ kind: "hold", until: "contact", why: "next-contact" });
  });

  test("now is said, unless it is his quiet hours or the ceiling is reached", () => {
    expect(routeOf("now", base)).toEqual({ kind: "say" });
    expect(routeOf("insist", base)).toEqual({ kind: "say" });
    const night = { ...base, at: local(21, 1) };
    expect(routeOf("now", night)).toEqual({ kind: "hold", until: "quiet-end", why: "quiet-hours", at: local(21, 8) });
    const full = { ...base, said: [day - HOUR, day - 2 * HOUR] };
    expect(routeOf("now", full)).toEqual({ kind: "hold", until: "contact", why: "ceiling" });
  });
});

/** The rows of a journal, numbered in order. */
function rows(...given: Array<[string, unknown, number?]>): Row[] {
  return given.map(([type, data, at], index) => ({ type, data, at: at ?? index * 1000, seq: index + 1 }));
}

const rin = { kind: "niwa" as const, by: "test" };
const occ = "occ-00000000a1";
const item = "att-00000000b1";
const ci: Subject = { kind: "occasion", occasion: occ };

describe("occasions", () => {
  test("a key that holds is one occasion: a repeat is counted, not opened again", () => {
    const state = foldAttention(
      rows(
        ["rin.occasion.opened", { occasion: occ, key: "ci:pr-101", kind: "ci", text: "CI is red on PR 101", from: rin }],
        ["rin.occasion.repeated", { occasion: occ, text: "CI is red on PR 101 again", from: rin }],
        ["rin.occasion.repeated", { occasion: occ, text: "CI is red on PR 101 again", from: rin }],
      ),
    );
    expect(state.occasions.get(occ)?.count).toBe(3);
    expect(noticeOf(state, { key: "ci:pr-101" })).toEqual({ kind: "repeat", occasion: occ });
    expect(noticeOf(state, { key: "ci:pr-102" })).toEqual({ kind: "open" });
    expect(noticeOf(state, { key: "ci:pr-101", ends: true })).toEqual({ kind: "end", occasion: occ });
    expect(noticeOf(state, { key: "ci:pr-102", ends: true })).toEqual({ kind: "none" });
  });

  test("once it ended, the same key opens a new occasion", () => {
    const state = foldAttention(
      rows(
        ["rin.occasion.opened", { occasion: occ, key: "ci:pr-101", kind: "ci", text: "red", from: rin }],
        ["rin.occasion.ended", { occasion: occ, from: rin }],
      ),
    );
    expect(noticeOf(state, { key: "ci:pr-101" })).toEqual({ kind: "open" });
  });

  test("what she held about an occasion that ended is dropped by the end record alone, not brought up", () => {
    const state = foldAttention(
      rows(
        ["rin.occasion.opened", { occasion: occ, key: "ci:pr-101", kind: "ci", text: "red", from: rin }],
        ["rin.attention.held", { item, subject: ci, text: "PR 101 is red", until: "contact", why: "next-contact" }],
        ["rin.occasion.ended", { occasion: occ, from: rin }],
      ),
    );
    expect(state.items.get(item)?.status).toBe("dropped");
    expect(briefingText(state)).toBe("");
  });

  test("what is held after its occasion ended is dropped at once", () => {
    const state = foldAttention(
      rows(
        ["rin.occasion.opened", { occasion: occ, key: "ci:pr-101", kind: "ci", text: "red", from: rin }],
        ["rin.occasion.ended", { occasion: occ, from: rin }],
        ["rin.attention.held", { item, subject: ci, text: "PR 101 is red", until: "contact", why: "undelivered" }],
      ),
    );
    expect(state.items.get(item)?.status).toBe("dropped");
    expect(briefingText(state)).toBe("");
  });

  test("what was on its way when its occasion ended is dropped by an explicit drop", () => {
    const state = foldAttention(
      rows(
        ["rin.occasion.opened", { occasion: occ, key: "ci:pr-101", kind: "ci", text: "red", from: rin }],
        ["rin.attention.sending", { item, subject: ci, text: "PR 101 is red" }],
        ["rin.occasion.ended", { occasion: occ, from: rin }],
        ["rin.attention.dropped", { item, occasion: occ }],
      ),
    );
    expect(state.items.get(item)?.status).toBe("dropped");
  });
});

describe("raising something again", () => {
  const said = foldAttention(
    rows(
      ["rin.occasion.opened", { occasion: occ, key: "ci:pr-101", kind: "ci", text: "red", from: rin }],
      ["rin.attention.said", { item, subject: ci, text: "PR 101 is red", channel: "telegram.send" }],
    ),
  );

  test("saying again what was said now is refused: it is insisting", () => {
    expect(repeatRefusal(said, ci)).toContain("insist");
    expect(repeatRefusal(foldAttention([]), ci)).toBeUndefined();
  });

  const held = ["rin.attention.held", { item, subject: ci, text: "PR 101 is red", until: "contact", why: "next-contact" }] as [string, unknown];

  test("what only waits was not told yet: a new decision takes its place, and there is nothing to insist on", () => {
    const waiting = foldAttention(rows(held));
    expect(repeatRefusal(waiting, ci)).toBeUndefined();
    expect(pendingAbout(waiting, ci)?.item).toBe(item);
    const rule = "rule-00000000c1";
    expect(insistRefusal(waiting, ci, rule, new Set([rule]))).toContain("not told");
  });

  test("what was brought up, or is on its way, counts as told, also after he waved it away", () => {
    const rule = "rule-00000000c1";
    const brought = foldAttention(rows(held, ["rin.attention.brought", { items: [item], contact: { kind: "message", message: "msg-000001" } }]));
    expect(repeatRefusal(brought, ci)).toContain("insist");
    expect(insistRefusal(brought, ci, rule, new Set([rule]))).toBeUndefined();
    expect(pendingAbout(brought, ci)).toBeUndefined();
    const dismissed = foldAttention(rows(held, ["rin.attention.brought", { items: [item], contact: { kind: "message", message: "msg-000001" } }], ["rin.attention.dismissed", { item }]));
    expect(repeatRefusal(dismissed, ci)).toContain("insist");
    const sending = foldAttention(rows(["rin.attention.sending", { item, subject: ci, text: "PR 101 is red" }]));
    expect(repeatRefusal(sending, ci)).toContain("insist");
    const unsure = foldAttention(rows(["rin.attention.sending", { item, subject: ci, text: "x" }], ["rin.attention.unsure", { item, subject: ci, text: "x", why: "cut off" }]));
    expect(unsure.items.get(item)?.status).toBe("unsure");
    expect(repeatRefusal(unsure, ci)).toContain("insist");
  });

  test("what was not sent is not told: held again, it can be said", () => {
    const back = foldAttention(rows(["rin.attention.sending", { item, subject: ci, text: "x" }], held));
    expect(repeatRefusal(back, ci)).toBeUndefined();
  });

  test("insisting needs a confirmed rule of the charter and something told before", () => {
    const rule = "rule-00000000c1";
    expect(insistRefusal(said, ci, rule, new Set([rule]))).toBeUndefined();
    expect(insistRefusal(said, ci, undefined, new Set([rule]))).toContain("rule");
    expect(insistRefusal(said, ci, rule, new Set())).toContain("confirmed");
    const other: Subject = { kind: "occasion", occasion: "occ-00000000a2" };
    expect(insistRefusal(said, other, rule, new Set([rule]))).toContain("not told");
  });
});

describe("the briefing", () => {
  test("lists what waits for the next contact, with how often its occasion came up", () => {
    const state = foldAttention(
      rows(
        ["rin.occasion.opened", { occasion: occ, key: "ci:pr-101", kind: "ci", text: "red", from: rin }],
        ["rin.occasion.repeated", { occasion: occ, text: "red", from: rin }],
        ["rin.attention.held", { item, subject: ci, text: "PR 101 has been red all night", until: "contact", why: "next-contact" }],
        ["rin.attention.held", { item: "att-00000000b2", subject: { kind: "turn", turn: "fact-abcdef" }, text: "The review task is done", until: "quiet-end", why: "quiet-hours" }],
      ),
    );
    expect(briefingText(state)).toBe(["- PR 101 has been red all night (came up 2 times)", "- The review task is done"].join("\n"));
  });

  test("what an attach brought up stays in the briefing of that attach", () => {
    const state = foldAttention(
      rows(
        ["rin.attention.held", { item, subject: ci, text: "PR 101 is red", until: "contact", why: "next-contact" }],
        ["agent.attached", { agent: "rin", session: "claude s1", cwd: "/w" }],
        ["rin.attention.brought", { items: [item], contact: { kind: "attach", session: "claude s1" } }],
      ),
    );
    expect(briefingText(state)).toBe("- PR 101 is red");
    const later = foldAttention([
      ...rows(
        ["rin.attention.held", { item, subject: ci, text: "PR 101 is red", until: "contact", why: "next-contact" }],
        ["agent.attached", { agent: "rin", session: "claude s1", cwd: "/w" }],
        ["rin.attention.brought", { items: [item], contact: { kind: "attach", session: "claude s1" } }],
        ["agent.attached", { agent: "rin", session: "claude s2", cwd: "/w" }],
      ),
    ]);
    expect(briefingText(later)).toBe("");
  });
});

describe("a stub model decides, the mechanics route", () => {
  /** A model that stays quiet about CI at night, saves task outcomes for later, and speaks up about a stuck agent. */
  const stub = (kind: string): Decision => (kind === "agent" ? "now" : kind === "task" ? "next-contact" : "silent");

  test("each decision lands where the owner's hours and the ceiling allow", () => {
    const ctx = { quiet: QUIET, ceiling: { count: 1, windowMs: 24 * HOUR }, said: [] as number[] };
    const day = local(21, 15);
    const outcomes = ["ci", "task", "agent", "agent"].map((kind) => {
      const route = routeOf(stub(kind), { ...ctx, at: day });
      if (route.kind === "say") ctx.said.push(day);
      return route.kind === "hold" ? `${kind}:hold:${route.why}` : `${kind}:${route.kind}`;
    });
    expect(outcomes).toEqual(["ci:keep", "task:hold:next-contact", "agent:say", "agent:hold:ceiling"]);
  });
});
