/** What Rin's page shows, as plain data: the page renders it, and the tests read it without React. */

import type { AgentView, AttentionView, ConversationMessage, RuleView } from "./actions.ts";

/** The items of her attention, as the page groups them. */
export interface AttentionGroups {
  /** What waits for him, or is Отправляется. */
  readonly waiting: AttentionView[];
  /** What she told him, now or at a contact. */
  readonly told: AttentionView[];
  /** What was dropped with its occasion or Скрыто. */
  readonly closed: AttentionView[];
}

const newestFirst = (a: AttentionView, b: AttentionView) => b.at - a.at;

export function attentionGroups(items: readonly AttentionView[]): AttentionGroups {
  const of = (statuses: readonly AttentionView["status"][]) => items.filter((item) => statuses.includes(item.status)).sort(newestFirst);
  return { waiting: of(["held", "sending"]), told: of(["said", "unsure", "brought"]), closed: of(["dropped", "dismissed"]) };
}

const WHY: Record<NonNullable<AttentionView["why"]>, string> = {
  "next-contact": "При следующем разговоре",
  "quiet-hours": "После тихих часов",
  ceiling: "Достигнут лимит уведомлений",
  undelivered: "Доставка не удалась",
};

const STATUS: Record<AttentionView["status"], string> = {
  held: "Отложено",
  sending: "Отправляется",
  unsure: "Доставка не подтверждена",
  said: "Доставлено",
  brought: "Обсуждено при разговоре",
  dropped: "Потеряло актуальность",
  dismissed: "Скрыто",
};

/** Why an item stands where it does, and how often its occasion came up. */
export function whyText(item: AttentionView): string {
  const why = item.status === "held" && item.why !== undefined ? WHY[item.why] : STATUS[item.status];
  return item.count !== undefined && item.count > 1 ? `${why} · повторов: ${item.count}` : why;
}

/** The tile on the home page. */
export function tileText(items: readonly AttentionView[]): string {
  const waiting = attentionGroups(items).waiting.length;
  if (waiting === 0) return "Нет отложенных сообщений";
  return waiting === 1 ? "Одно отложенное сообщение" : `Отложенные сообщения: ${waiting}`;
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
const RULE_LABEL: Record<RuleView["status"], string> = { proposed: "Ждёт подтверждения", ruled: "Действует", declined: "Отклонено", retired: "Снято" };

/** Her charter: what waits for his word first, then the rules Действует, then the rest. */
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

const DELIVERY: Record<NonNullable<ConversationMessage["delivery"]>, string> = {
  waiting: "Ждёт обработки",
  delivered: "Доставлено Рин",
  unsent: "Не доставлено",
  "possibly-sent": "Доставка не подтверждена",
};

/** One line of the conversation: who spoke, what, and for what he wrote, where it stands. */
export interface ConversationRow {
  readonly turn?: string;
  readonly id: string;
  readonly who: string;
  readonly text: string;
  readonly at: number;
  readonly state?: string;
}

/** The conversation, oldest first as it was written. */
export function conversationRows(messages: readonly ConversationMessage[]): ConversationRow[] {
  return [...messages]
    .sort((a, b) => a.at - b.at)
    .map((message) => ({
      id: message.id,
      ...(message.turn === undefined ? {} : { turn: message.turn }),
      who: message.from === "owner" ? "Вы" : "Рин",
      text: message.text,
      at: message.at,
      ...(message.delivery === undefined ? {} : { state: DELIVERY[message.delivery] }),
    }));
}
