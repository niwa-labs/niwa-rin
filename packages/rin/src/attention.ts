/**
 * Rin's attention, without a host: when what she decides reaches the owner, what an occasion is, and what
 * waits for him.
 *
 * She decides in her main session what to do about something that happened. The mechanics around that decision
 * live here: an occasion is one while it holds, so a repeat is counted on it and not brought to her again; what
 * she says now waits during the owner's quiet hours, and past a safety ceiling; what she holds for his next
 * contact is brought up when he is next in touch, unless its occasion stopped holding first.
 */

import {
  AttentionBrought,
  AttentionDecided,
  AttentionDismissed,
  AttentionDropped,
  AttentionHeld,
  AttentionSaid,
  AttentionSending,
  OccasionEnded,
  OccasionOpened,
  OccasionRepeated,
} from "./records.ts";
import type { AttentionItem, Contact, Decision, HoldReason, ItemId, ItemStatus, OccasionId, OccasionItem, RuleId, Subject } from "./records.ts";

const MINUTE = 60_000;
const DAY = 24 * 60 * MINUTE;

/** The owner's quiet hours, as times of day ("HH:MM") in the local time of the host. `from` after `to` crosses midnight. */
export interface QuietHours {
  readonly from: string;
  readonly to: string;
}

/** Quiet hours when the owner says nothing else. */
export const DEFAULT_QUIET: QuietHours = { from: "23:00", to: "08:00" };

/**
 * The safety ceiling: at most `count` things said now within any `windowMs`. It is a guard against a runaway, not
 * a budget she plans with: past it, what she says now waits for his next contact.
 */
export interface Ceiling {
  readonly count: number;
  readonly windowMs: number;
}

export const DEFAULT_CEILING: Ceiling = { count: 12, windowMs: DAY };

/** The minutes after midnight of a time of day. */
export function minutesOf(clock: string): number {
  const match = /^([01]\d|2[0-3]):([0-5]\d)$/.exec(clock);
  if (match === null) throw new TypeError(`"${clock}" is not a time of day (HH:MM)`);
  return Number(match[1]) * 60 + Number(match[2]);
}

/** The local moment of a time of day on the day of `at`. */
function onDayOf(at: number, minutes: number): number {
  const day = new Date(at);
  return new Date(day.getFullYear(), day.getMonth(), day.getDate(), Math.floor(minutes / 60), minutes % 60).getTime();
}

/** Is `at` within the quiet hours? */
export function inQuietHours(at: number, quiet: QuietHours): boolean {
  const from = minutesOf(quiet.from);
  const to = minutesOf(quiet.to);
  const date = new Date(at);
  const now = date.getHours() * 60 + date.getMinutes();
  if (from === to) return false;
  return from < to ? now >= from && now < to : now >= from || now < to;
}

/** The moment the quiet hours that hold at `at` end; undefined when they do not hold. */
export function quietEnds(at: number, quiet: QuietHours): number | undefined {
  if (!inQuietHours(at, quiet)) return undefined;
  const to = minutesOf(quiet.to);
  const today = onDayOf(at, to);
  if (today > at) return today;
  const tomorrow = new Date(at);
  tomorrow.setDate(tomorrow.getDate() + 1);
  return onDayOf(tomorrow.getTime(), to);
}

/** How many more things may be said now: the ceiling less what was said within its window before `at`. */
export function ceilingLeft(said: readonly number[], at: number, ceiling: Ceiling): number {
  const within = said.filter((moment) => moment <= at && moment > at - ceiling.windowMs).length;
  return Math.max(0, ceiling.count - within);
}

/** Where a decision goes. */
export type Route =
  | { readonly kind: "keep" }
  | { readonly kind: "hold"; readonly until: "contact"; readonly why: Extract<HoldReason, "next-contact" | "ceiling"> }
  | { readonly kind: "hold"; readonly until: "quiet-end"; readonly why: "quiet-hours"; readonly at: number }
  | { readonly kind: "say" };

/** What a decision is routed by: the moment, his quiet hours, the ceiling and the moments things were said now. */
export interface RouteContext {
  readonly at: number;
  readonly quiet: QuietHours;
  readonly ceiling: Ceiling;
  readonly said: readonly number[];
}

/** Where a decision goes: nowhere, to the next contact, to the end of his quiet hours, or to him now. */
export function routeOf(decision: Decision, ctx: RouteContext): Route {
  if (decision === "silent" || decision === "note") return { kind: "keep" };
  if (decision === "next-contact") return { kind: "hold", until: "contact", why: "next-contact" };
  return sayNow(ctx);
}

/** Something to be said now: said, or held for the end of his quiet hours, or for his next contact past the ceiling. */
export function sayNow(ctx: RouteContext): Route {
  const ends = quietEnds(ctx.at, ctx.quiet);
  if (ends !== undefined) return { kind: "hold", until: "quiet-end", why: "quiet-hours", at: ends };
  if (ceilingLeft(ctx.said, ctx.at, ctx.ceiling) === 0) return { kind: "hold", until: "contact", why: "ceiling" };
  return { kind: "say" };
}

// ---- the state of her attention, folded from the journal -------------------------------------------------------

/** A record as the fold reads it. */
export interface Row {
  readonly type: string;
  readonly data: unknown;
  readonly at: number;
  readonly seq: number;
}

/** An occasion, from its first notice. */
export interface Occasion {
  readonly occasion: OccasionId;
  readonly key: string;
  readonly kind: string;
  text: string;
  count: number;
  readonly at: number;
  ended?: number;
  decision?: Decision;
}

/** One thing she meant to tell him. */
export interface Item {
  readonly item: ItemId;
  readonly subject: Subject;
  readonly text: string;
  status: ItemStatus;
  until?: "contact" | "quiet-end";
  why?: HoldReason;
  readonly rule?: RuleId;
  readonly at: number;
  /** The position of the record that last put it where it is: what waits is held from there. */
  readonly seq: number;
  brought?: { readonly contact: Contact; readonly seq: number };
}

export interface AttentionState {
  readonly occasions: Map<OccasionId, Occasion>;
  /** The occasion that holds for a key. */
  readonly open: Map<string, OccasionId>;
  readonly items: Map<ItemId, Item>;
  /** The moments something was said now, for the ceiling. */
  readonly said: number[];
  /** The latest attach of a session to Rin: what its briefing showed is what it brought. */
  lastAttach?: { readonly session: string; readonly seq: number };
}

/** The agent whose attachments are contacts with the owner. */
export const ATTACHED = "agent.attached";

/** Folds the records of her attention, and her attachments, in the order they were written. */
export function foldAttention(rows: readonly Row[], agent = "rin"): AttentionState {
  const state: AttentionState = { occasions: new Map(), open: new Map(), items: new Map(), said: [] };
  for (const row of rows) {
    switch (row.type) {
      case OccasionOpened.name: {
        const data = OccasionOpened.schema.parse(row.data);
        state.occasions.set(data.occasion, { occasion: data.occasion, key: data.key, kind: data.kind, text: data.text, count: 1, at: row.at });
        state.open.set(data.key, data.occasion);
        break;
      }
      case OccasionRepeated.name: {
        const data = OccasionRepeated.schema.parse(row.data);
        const occasion = state.occasions.get(data.occasion);
        if (occasion !== undefined) {
          occasion.count += 1;
          occasion.text = data.text;
        }
        break;
      }
      case OccasionEnded.name: {
        const data = OccasionEnded.schema.parse(row.data);
        const occasion = state.occasions.get(data.occasion);
        if (occasion !== undefined) {
          occasion.ended = row.at;
          if (state.open.get(occasion.key) === occasion.occasion) state.open.delete(occasion.key);
        }
        break;
      }
      case AttentionDecided.name: {
        const data = AttentionDecided.schema.parse(row.data);
        if (data.subject.kind === "occasion") {
          const occasion = state.occasions.get(data.subject.occasion);
          if (occasion !== undefined) occasion.decision = data.decision;
        }
        break;
      }
      case AttentionHeld.name: {
        const data = AttentionHeld.schema.parse(row.data);
        state.items.set(data.item, {
          item: data.item,
          subject: data.subject,
          text: data.text,
          status: "held",
          until: data.until,
          why: data.why,
          ...(data.rule === undefined ? {} : { rule: data.rule }),
          at: state.items.get(data.item)?.at ?? row.at,
          seq: row.seq,
        });
        break;
      }
      case AttentionSending.name: {
        const data = AttentionSending.schema.parse(row.data);
        const held = state.items.get(data.item);
        state.items.set(data.item, {
          item: data.item,
          subject: data.subject,
          text: data.text,
          status: "sending",
          ...(data.rule === undefined ? {} : { rule: data.rule }),
          at: held?.at ?? row.at,
          seq: row.seq,
        });
        state.said.push(row.at);
        break;
      }
      case AttentionSaid.name: {
        const data = AttentionSaid.schema.parse(row.data);
        const sent = state.items.get(data.item);
        state.items.set(data.item, {
          item: data.item,
          subject: data.subject,
          text: data.text,
          status: "said",
          ...(data.rule === undefined ? {} : { rule: data.rule }),
          at: sent?.at ?? row.at,
          seq: sent?.seq ?? row.seq,
        });
        if (sent?.status !== "sending") state.said.push(row.at);
        break;
      }
      case AttentionBrought.name: {
        const data = AttentionBrought.schema.parse(row.data);
        for (const id of data.items) {
          const item = state.items.get(id);
          if (item?.status !== "held") continue;
          item.status = "brought";
          item.brought = { contact: data.contact, seq: row.seq };
          delete item.until;
        }
        break;
      }
      case AttentionDropped.name: {
        const item = state.items.get(AttentionDropped.schema.parse(row.data).item);
        if (item?.status === "held") {
          item.status = "dropped";
          delete item.until;
        }
        break;
      }
      case AttentionDismissed.name: {
        const item = state.items.get(AttentionDismissed.schema.parse(row.data).item);
        if (item !== undefined) {
          item.status = "dismissed";
          delete item.until;
        }
        break;
      }
      case ATTACHED: {
        const data = row.data as { agent?: unknown; session?: unknown };
        if (data.agent === agent && typeof data.session === "string") state.lastAttach = { session: data.session, seq: row.seq };
        break;
      }
    }
  }
  return state;
}

/** What a notice does: open a new occasion, count a repeat on the one that holds, end it, or nothing. */
export type Notice =
  | { readonly kind: "open" }
  | { readonly kind: "repeat"; readonly occasion: OccasionId }
  | { readonly kind: "end"; readonly occasion: OccasionId }
  | { readonly kind: "none" };

export function noticeOf(state: AttentionState, input: { readonly key: string; readonly ends?: boolean }): Notice {
  const holds = state.open.get(input.key);
  if (input.ends === true) return holds === undefined ? { kind: "none" } : { kind: "end", occasion: holds };
  return holds === undefined ? { kind: "open" } : { kind: "repeat", occasion: holds };
}

/** Is it the same subject? */
function same(a: Subject, b: Subject): boolean {
  return a.kind === "occasion" ? b.kind === "occasion" && a.occasion === b.occasion : b.kind === "turn" && a.turn === b.turn;
}

/** What she told him, or holds for him, about a subject. */
function toldAbout(state: AttentionState, subject: Subject): Item[] {
  return [...state.items.values()].filter((item) => same(item.subject, subject) && item.status !== "dropped");
}

/** Why saying now is refused: she already said it, and saying it again is insisting. */
export function nowRefusal(state: AttentionState, subject: Subject): string | undefined {
  if (toldAbout(state, subject).some((item) => item.status === "said" || item.status === "sending")) {
    return "this was already said to the owner: to raise it again, insist by a confirmed rule of the charter";
  }
  return undefined;
}

/** Why insisting is refused: it names no confirmed rule, or there is nothing told before to raise again. */
export function insistRefusal(state: AttentionState, subject: Subject, rule: RuleId | undefined, ruled: ReadonlySet<string>): string | undefined {
  if (rule === undefined) return "insisting names the rule of the charter it rests on";
  if (!ruled.has(rule)) return `"${rule}" is not a confirmed rule of the charter`;
  if (toldAbout(state, subject).length === 0) return "the owner was not told this before: say it, do not insist";
  return undefined;
}

/** What waits: held, for the next contact or the end of his quiet hours. */
export function heldItems(state: AttentionState, until?: "contact" | "quiet-end"): Item[] {
  return [...state.items.values()].filter((item) => item.status === "held" && (until === undefined || item.until === until));
}

/** What waits about an occasion. */
export function heldAbout(state: AttentionState, occasion: OccasionId): Item[] {
  return heldItems(state).filter((item) => item.subject.kind === "occasion" && item.subject.occasion === occasion);
}

/** How often the occasion of an item came up, when it is about one. */
function countOf(state: AttentionState, item: Item): number | undefined {
  return item.subject.kind === "occasion" ? state.occasions.get(item.subject.occasion)?.count : undefined;
}

/**
 * What a briefing shows: what waits, and what the latest attach brought up — the attach and the briefing it
 * answers with may be seen in either order, and the briefing shows the same.
 */
export function briefingItems(state: AttentionState): Item[] {
  const attach = state.lastAttach;
  return [...state.items.values()].filter(
    (item) =>
      item.status === "held" ||
      (item.status === "brought" &&
        attach !== undefined &&
        item.brought?.contact.kind === "attach" &&
        item.brought.contact.session === attach.session &&
        item.brought.seq > attach.seq),
  );
}

/** One line of an item as he reads it. */
export function itemLine(state: AttentionState, item: Item): string {
  const count = countOf(state, item);
  return `- ${item.text}${count !== undefined && count > 1 ? ` (came up ${count} times)` : ""}`;
}

/** The lines of what a briefing shows; empty when nothing waits. */
export function briefingText(state: AttentionState): string {
  return briefingItems(state)
    .map((item) => itemLine(state, item))
    .join("\n");
}

/** An item as it is read. */
export function itemView(state: AttentionState, item: Item): AttentionItem {
  const kind = item.subject.kind === "occasion" ? state.occasions.get(item.subject.occasion)?.kind : undefined;
  const count = countOf(state, item);
  return {
    item: item.item,
    subject: item.subject,
    text: item.text,
    status: item.status,
    ...(item.until === undefined ? {} : { until: item.until }),
    ...(item.why === undefined ? {} : { why: item.why }),
    ...(kind === undefined ? {} : { kind }),
    ...(count === undefined ? {} : { count }),
    ...(item.rule === undefined ? {} : { rule: item.rule }),
    at: item.at,
  };
}

/** The occasions that hold, as they are read. */
export function openOccasions(state: AttentionState): OccasionItem[] {
  return [...state.open.values()].flatMap((id) => {
    const occasion = state.occasions.get(id);
    if (occasion === undefined) return [];
    return [
      {
        occasion: occasion.occasion,
        key: occasion.key,
        kind: occasion.kind,
        text: occasion.text,
        count: occasion.count,
        ...(occasion.decision === undefined ? {} : { decision: occasion.decision }),
        at: occasion.at,
      },
    ];
  });
}
