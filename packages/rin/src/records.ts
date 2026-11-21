/**
 * What Rin writes and the actions she serves: her attention (occasions, her decisions on them, what she holds for
 * the owner and what she says to him), the corrections she learns from, and her charter.
 *
 * Nothing here runs; the plugin (`plugin.ts`) serves the actions and folds the records.
 */

import { z } from "zod";

import { Address, actionRef, record } from "@niwa-labs/core";
import { AgentName, TurnAuthor, TurnId } from "@niwa-labs/agent/records";

/** An occasion: something that happened and may matter to the owner, kept as one while it holds. */
export const OccasionId = z.string().regex(/^occ-[0-9a-f]{10}$/);
export type OccasionId = z.output<typeof OccasionId>;

/** One thing Rin means to tell the owner: held for later, said, or brought up at a contact. */
export const ItemId = z.string().regex(/^att-[0-9a-f]{10}$/);
export type ItemId = z.output<typeof ItemId>;

/** One correction of the owner's. */
export const CorrectionId = z.string().regex(/^cor-[0-9a-f]{10}$/);
export type CorrectionId = z.output<typeof CorrectionId>;

/** One rule of her charter, from the moment it is proposed. */
export const RuleId = z.string().regex(/^rule-[0-9a-f]{10}$/);
export type RuleId = z.output<typeof RuleId>;

/**
 * What an occasion is known by: the same key while it holds is the same occasion (`ci:pr-101`, `task:t-7`).
 * Lowercase words, digits and `:./_-`.
 */
export const OccasionKey = z.string().regex(/^[a-z0-9][a-z0-9:./_-]{0,127}$/, "an occasion key is lowercase letters, digits and ':./_-', at most 128");

/** The kind of an occasion, as a person reads it in a list: `ci`, `task`, `agent`, `question`. */
export const OccasionKind = z.string().regex(/^[a-z][a-z0-9-]{0,31}$/, "an occasion kind is one lowercase word, at most 32");

/** What a correction or a rule is about: a word or a dotted path (`attention.ci`, `tone`, `memory`). */
export const Topic = z.string().regex(/^[a-z][a-z0-9.-]{0,63}$/, "a topic is lowercase letters, digits, '.' and '-', at most 64");
export type Topic = z.output<typeof Topic>;

/**
 * What Rin may decide about something that happened:
 *
 * - `silent` — nothing, and that is a decision;
 * - `note` — keep it, for herself;
 * - `next-contact` — tell him the next time he is in touch;
 * - `now` — tell him now;
 * - `insist` — raise again what she already told him, by a rule of her charter.
 */
export const Decision = z.enum(["silent", "note", "next-contact", "now", "insist"]);
export type Decision = z.output<typeof Decision>;

/** What a decision is about: an occasion of her attention, or a turn of her inbox (a task's outcome, a digest). */
export const Subject = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("occasion"), occasion: OccasionId }),
  z.object({ kind: z.literal("turn"), turn: TurnId }),
]);
export type Subject = z.output<typeof Subject>;

/** Why something waits instead of being said. */
export const HoldReason = z.enum(["next-contact", "quiet-hours", "ceiling", "undelivered"]);
export type HoldReason = z.output<typeof HoldReason>;

/** How the owner came in touch: he wrote to her, or attached a session of his. */
export const Contact = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("message"), message: z.string().min(1) }),
  z.object({ kind: z.literal("attach"), session: z.string().min(1) }),
]);
export type Contact = z.output<typeof Contact>;

const Text = z.string().min(1).max(2000);

// ---- attention ------------------------------------------------------------------------------------------------

/** Something happened that may matter to the owner: a new occasion. */
export const OccasionOpened = record(
  "rin.occasion.opened",
  z.object({ occasion: OccasionId, key: OccasionKey, kind: OccasionKind, text: Text, from: TurnAuthor }),
);

/** The same thing happened again while its occasion holds: counted on it, and not brought to her again. */
export const OccasionRepeated = record("rin.occasion.repeated", z.object({ occasion: OccasionId, text: Text, from: TurnAuthor }));

/** An occasion no longer holds: the build is green again, the agent answers again. What waits about it is dropped. */
export const OccasionEnded = record("rin.occasion.ended", z.object({ occasion: OccasionId, text: Text.optional(), from: TurnAuthor }));

/** Rin decided what to do about something, with what she would tell him and the rule she insists by. */
export const AttentionDecided = record(
  "rin.attention.decided",
  z.object({ subject: Subject, decision: Decision, text: Text.optional(), rule: RuleId.optional() }),
);

/** Something she means to tell him waits: for the next contact, or for the end of his quiet hours. */
export const AttentionHeld = record(
  "rin.attention.held",
  z.object({
    item: ItemId,
    subject: Subject,
    text: Text,
    until: z.enum(["contact", "quiet-end"]),
    why: HoldReason,
    rule: RuleId.optional(),
  }),
);

/** She is telling him now: what counts against the safety ceiling, from the moment it was decided. */
export const AttentionSending = record(
  "rin.attention.sending",
  z.object({ item: ItemId, subject: Subject, text: Text, rule: RuleId.optional() }),
);

/** She told him, now, on a channel. */
export const AttentionSaid = record(
  "rin.attention.said",
  z.object({ item: ItemId, subject: Subject, text: Text, channel: z.string().min(1), rule: RuleId.optional() }),
);

/** What waited was brought to him when he came in touch. */
export const AttentionBrought = record("rin.attention.brought", z.object({ items: z.array(ItemId).min(1), contact: Contact }));

/** What waited was dropped: the occasion it was about no longer holds. */
export const AttentionDropped = record("rin.attention.dropped", z.object({ item: ItemId, occasion: OccasionId }));

/** The owner waved away something she told him or held for him. */
export const AttentionDismissed = record("rin.attention.dismissed", z.object({ item: ItemId, reason: z.string().min(1).optional() }));

// ---- corrections and the charter ------------------------------------------------------------------------------

/**
 * The owner corrected her: he said "not like that", changed or took back a note of hers, cancelled what she
 * decided or promised, turned down or left unanswered what she asked, or waved away what she told him.
 */
export const Corrected = record(
  "rin.corrected",
  z.object({
    correction: CorrectionId,
    about: Topic,
    what: Text,
    /** Who wrote the correction down: the owner himself, Rin from his words, or niwa from what he did. */
    by: TurnAuthor,
    /** The record of his that it rests on: his message, or the record of what he did. */
    source: z.string().min(1).optional(),
  }),
);

/** Corrections about one thing repeat: Rin is asked whether a rule of her charter should cover them. */
export const CharterDue = record("rin.charter.due", z.object({ about: Topic, corrections: z.array(CorrectionId).min(1) }));

/** A rule of the charter was proposed to the owner, with the corrections it covers. */
export const CharterProposed = record(
  "rin.charter.proposed",
  z.object({ rule: RuleId, about: Topic, text: Text, corrections: z.array(CorrectionId), by: TurnAuthor }),
);

/** The owner confirmed a rule: it is part of the charter from now on. */
export const CharterRuled = record("rin.charter.ruled", z.object({ rule: RuleId, by: Address }));

/** A proposed rule did not become part of the charter: the owner said no, or the question was dropped. */
export const CharterDeclined = record("rin.charter.declined", z.object({ rule: RuleId, why: z.enum(["declined", "cancelled", "expired"]) }));

/** The owner took a rule out of the charter. */
export const CharterRetired = record("rin.charter.retired", z.object({ rule: RuleId, reason: z.string().min(1).optional() }));

/** The record types Rin declares. */
export const RIN_TYPES = [
  OccasionOpened,
  OccasionRepeated,
  OccasionEnded,
  AttentionDecided,
  AttentionHeld,
  AttentionSending,
  AttentionSaid,
  AttentionBrought,
  AttentionDropped,
  AttentionDismissed,
  Corrected,
  CharterDue,
  CharterProposed,
  CharterRuled,
  CharterDeclined,
  CharterRetired,
] as const;

// ---- actions --------------------------------------------------------------------------------------------------

/** One rule of the charter as it is read. */
export const RuleItem = z.object({
  rule: RuleId,
  about: Topic,
  text: Text,
  status: z.enum(["proposed", "ruled", "declined", "retired"]),
  corrections: z.array(CorrectionId),
});
export type RuleItem = z.output<typeof RuleItem>;

/** One correction as it is read. */
export const CorrectionItem = z.object({
  correction: CorrectionId,
  about: Topic,
  what: Text,
  by: TurnAuthor,
  at: z.number(),
  /** The rule that covers it, once one was proposed for it. */
  rule: RuleId.optional(),
});
export type CorrectionItem = z.output<typeof CorrectionItem>;

/** Where one thing she meant to tell him stands. */
export const ItemStatus = z.enum(["held", "sending", "said", "brought", "dropped", "dismissed"]);
export type ItemStatus = z.output<typeof ItemStatus>;

/** One thing she meant to tell him, as it is read. */
export const AttentionItem = z.object({
  item: ItemId,
  subject: Subject,
  text: Text,
  status: ItemStatus,
  /** What it waits for, while it is held. */
  until: z.enum(["contact", "quiet-end"]).optional(),
  why: HoldReason.optional(),
  /** The kind of the occasion it is about, and how many times the occasion came up. */
  kind: OccasionKind.optional(),
  count: z.number().int().positive().optional(),
  rule: RuleId.optional(),
  at: z.number(),
});
export type AttentionItem = z.output<typeof AttentionItem>;

/** An occasion that holds, as it is read. */
export const OccasionItem = z.object({
  occasion: OccasionId,
  key: OccasionKey,
  kind: OccasionKind,
  text: Text,
  count: z.number().int().positive(),
  decision: Decision.optional(),
  at: z.number(),
});
export type OccasionItem = z.output<typeof OccasionItem>;

export const rinNotice = actionRef("rin.notice", {
  description:
    "Tells Rin that something happened which may matter to the owner. The key names the occasion: while an occasion of the same key holds, a repeat is counted on it and does not reach her again. `ends: true` says the occasion no longer holds (the build is green again); what she held about it is dropped. A new occasion reaches her inbox as a fact, and she decides what to do about it.",
  input: z.object({ key: OccasionKey, kind: OccasionKind, text: Text, ends: z.boolean().optional() }),
  output: z.object({ occasion: OccasionId.optional(), status: z.enum(["opened", "repeated", "ended", "none"]) }),
});

export const rinAttend = actionRef("rin.attend", {
  description:
    "Rin's decision about something that happened: an occasion of her attention, or a turn of her inbox. `silent` does nothing; `note` keeps it for herself; `next-contact` holds what to tell the owner until he is next in touch; `now` tells him now; `insist` raises again what she already told him, and must name a confirmed rule of her charter. Give `text`, what he is to read, for anything she tells him. Something said now waits instead during his quiet hours, or when the safety ceiling is reached, and the answer says so.",
  input: z.object({ subject: Subject, decision: Decision, text: Text.optional(), rule: RuleId.optional() }),
  output: z.object({
    decision: Decision,
    /** `sending`: it is on its way to him; if it cannot reach him, it is held for his next contact and she is told. */
    outcome: z.enum(["kept", "held", "sending"]),
    item: ItemId.optional(),
    why: HoldReason.optional(),
    /** When it is held until the end of his quiet hours: that moment. */
    until: z.number().optional(),
  }),
});

export const rinContext = actionRef("rin.context", {
  description:
    "What Rin weighs before she speaks: whether the owner is working now (his attached sessions), whether these are his quiet hours, how much of the safety ceiling is left, her charter, the occasions that hold and what she holds for his next contact.",
  input: z.object({}),
  output: z.object({
    at: z.number(),
    working: z.array(z.object({ session: z.string(), cwd: z.string(), agent: AgentName })),
    quiet: z.object({ now: z.boolean(), from: z.string(), to: z.string(), ends: z.number().optional() }),
    ceiling: z.object({ count: z.number().int(), windowMs: z.number().int(), left: z.number().int() }),
    charter: z.array(RuleItem),
    occasions: z.array(OccasionItem),
    held: z.array(AttentionItem),
  }),
});

export const rinAttention = actionRef("rin.attention.list", {
  description: "What Rin meant to tell the owner, newest first: what she holds, what she said, what was brought up, dropped or waved away.",
  input: z.object({ status: ItemStatus.optional() }),
  output: z.object({ items: z.array(AttentionItem), occasions: z.array(OccasionItem) }),
});

export const rinDismiss = actionRef("rin.attention.dismiss", {
  description: "The owner waves away something Rin told him or holds for him: it is not brought up again, and she learns from it as from a correction.",
  input: z.object({ item: ItemId, reason: z.string().min(1).optional() }),
  output: z.object({ item: ItemId, correction: CorrectionId }),
});

export const rinCorrect = actionRef("rin.correct", {
  description:
    "Writes down a correction of the owner's: what she did that he did not want, and what he wants instead, as one plain sentence that still makes sense a month from now. `about` is what it concerns (`attention.ci`, `tone`, `memory`). The owner may write one himself; Rin writes one only from his own words and gives the id of the record that holds them as `source`.",
  input: z.object({ about: Topic, what: Text, source: z.string().min(1).optional() }),
  output: z.object({ correction: CorrectionId }),
});

export const rinCharterPropose = actionRef("rin.charter.propose", {
  description:
    "Proposes a rule of Rin's charter: how the owner wants her to act, in one sentence, with what it is about and the corrections it covers. It becomes part of the charter only once the owner confirms it; a rule the owner proposes himself stands at once.",
  input: z.object({ about: Topic, text: Text, corrections: z.array(CorrectionId).default([]) }),
  output: z.object({ rule: RuleId, status: z.enum(["proposed", "ruled"]) }),
});

export const rinCharterRetire = actionRef("rin.charter.retire", {
  description: "The owner takes a rule out of Rin's charter.",
  input: z.object({ rule: RuleId, reason: z.string().min(1).optional() }),
  output: z.object({ rule: RuleId }),
});

export const rinCharter = actionRef("rin.charter", {
  description: "Rin's charter: the rules the owner confirmed, the ones proposed to him, and the corrections they grew from.",
  input: z.object({}),
  output: z.object({ rules: z.array(RuleItem), corrections: z.array(CorrectionItem) }),
});

export const rinBriefing = actionRef("rin.briefing", {
  description: "Rin's section of a briefing: what she held for the owner's next contact, and the rules of her charter that wait for his word.",
  input: z.object({ agent: AgentName }),
  output: z.object({ text: z.string() }),
});

/** The actions of Rin's attention and charter, for her hands. */
export const RIN_ACTIONS = [rinNotice, rinAttend, rinContext, rinAttention, rinCorrect, rinCharterPropose, rinCharter] as const;
