/** What Rin's page shows, as plain data: the page renders it, and the tests read it without React. */

import type { AgentView, AttentionView, RuleView } from "./actions.ts";

/** The items of her attention, as the page groups them. */
export interface AttentionGroups {
  /** What waits for him, or is on its way. */
  readonly waiting: AttentionView[];
  /** What she told him, now or at a contact. */
  readonly told: AttentionView[];
  /** What was dropped with its occasion or waved away. */
  readonly closed: AttentionView[];
}

const newestFirst = (a: AttentionView, b: AttentionView) => b.at - a.at;

export function attentionGroups(items: readonly AttentionView[]): AttentionGroups {
  const of = (statuses: readonly AttentionView["status"][]) => items.filter((item) => statuses.includes(item.status)).sort(newestFirst);
  return { waiting: of(["held", "sending"]), told: of(["said", "unsure", "brought"]), closed: of(["dropped", "dismissed"]) };
}

const WHY: Record<NonNullable<AttentionView["why"]>, string> = {
  "next-contact": "for your next contact",
  "quiet-hours": "after your quiet hours",
  ceiling: "past the safety ceiling",
  undelivered: "could not reach you",
};

const STATUS: Record<AttentionView["status"], string> = {
  held: "waits",
  sending: "on its way",
  unsure: "may have reached you",
  said: "told you",
  brought: "brought up when you came",
  dropped: "no longer holds",
  dismissed: "waved away",
};

/** Why an item stands where it does, and how often its occasion came up. */
export function whyText(item: AttentionView): string {
  const why = item.status === "held" && item.why !== undefined ? WHY[item.why] : STATUS[item.status];
  return item.count !== undefined && item.count > 1 ? `${why} · came up ${item.count} times` : why;
}

/** The tile on the home page. */
export function tileText(items: readonly AttentionView[]): string {
  const waiting = attentionGroups(items).waiting.length;
  if (waiting === 0) return "Nothing waits for you";
  return waiting === 1 ? "1 thing waits for you" : `${waiting} things wait for you`;
}

/** One rule as the page lists it. */
export interface CharterRow {
  readonly rule: string;
  readonly about: string;
  readonly text: string;
  readonly status: RuleView["status"];
  readonly label: string;
  readonly corrections: number;
}

const RULE_ORDER: Record<RuleView["status"], number> = { proposed: 0, ruled: 1, declined: 2, retired: 3 };
const RULE_LABEL: Record<RuleView["status"], string> = { proposed: "waits for your word", ruled: "in force", declined: "declined", retired: "retired" };

/** Her charter: what waits for his word first, then the rules in force, then the rest. */
export function charterRows(rules: readonly RuleView[]): CharterRow[] {
  return rules
    .map((rule, index) => ({ rule, index }))
    .sort((a, b) => RULE_ORDER[a.rule.status] - RULE_ORDER[b.rule.status] || a.index - b.index)
    .map(({ rule }) => ({
      rule: rule.rule,
      about: rule.about,
      text: rule.text,
      status: rule.status,
      label: RULE_LABEL[rule.status],
      corrections: rule.corrections.length,
    }));
}

/** The agents she leads: every agent of the host but herself. */
export function ledAgents<T extends Pick<AgentView, "name">>(agents: readonly T[], self = "rin"): T[] {
  return agents.filter((agent) => agent.name !== self);
}
