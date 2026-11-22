/**
 * What Rin writes and the actions she serves: her attention (occasions, her decisions on them, what she holds for
 * the owner and what she says to him), the corrections she learns from, and her charter.
 *
 * Nothing here runs; the plugin (`plugin.ts`) serves the actions and folds the records.
 */

import { z } from "zod";

import { Address, actionRef, record } from "@niwa-labs/core";
import { AgentName, PromptSectionInput, PromptSectionOutput, TurnAuthor, TurnId } from "@niwa-labs/agent/records";

import { charterGuard, correctionStatus, editGuard, hasProposal, occasionGuard, ruleStatus } from "./admission.ts";

/** An occasion: something that happened and may matter to the owner, kept as one while it holds. */
export const OccasionId = z.string().regex(/^occ-[0-9a-f]{10}$/);
export type OccasionId = z.output<typeof OccasionId>;

/** One thing Rin means to tell the owner: held for later, said, or brought up at a contact. */
export const ItemId = z.string().regex(/^att-[0-9a-f]{10}$/);
export type ItemId = z.output<typeof ItemId>;

/** What the owner did to a note of hers: changed its words, took it back, or erased it. */
export const NoteChange = z.object({ memory: z.string().min(1), note: z.string().min(1), change: z.enum(["corrected", "retracted", "erased"]) });
export type NoteChange = z.output<typeof NoteChange>;

/** One correction of the owner's. */
export const CorrectionId = z.string().regex(/^cor-[0-9a-f]{10}$/);
export type CorrectionId = z.output<typeof CorrectionId>;

/** One change of herself she asked the owner to approve. */
export const EditId = z.string().regex(/^edit-[0-9a-f]{10}$/);
export type EditId = z.output<typeof EditId>;

/** One rule of her charter, from the moment it is proposed. */
export const RuleId = z.string().regex(/^rule-[0-9a-f]{10}$/);
export type RuleId = z.output<typeof RuleId>;

/** Whether Rin may apply communication preferences she learns from the owner's feedback. */
export const CharterMode = z.enum(["ask", "auto"]);
export type CharterMode = z.output<typeof CharterMode>;

/** Communication choices with fixed meaning. None carries authority to act or insist. */
export const CommunicationPreference = z.enum([
  "concise", "more-context", "bullet-list", "plain-language", "no-humor", "action-first", "next-contact",
]);
export type CommunicationPreference = z.output<typeof CommunicationPreference>;

const LearningBasis = z.enum(["explicit", "pattern"]);
const CorrectionEvidence = z.object({ correction: CorrectionId, record: z.string().min(1), source: z.string().min(1) });

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

const OccasionRevision = z.object({ occasion: OccasionId, key: OccasionKey });
const Notice = z.object({ key: OccasionKey, notice: z.string() });
const ActiveOccasion = OccasionRevision.extend({ notice: z.string(), text: Text, from: TurnAuthor });

const openChanged = { code: "occasion-changed", reason: "The open occasion changed" };
/** Something happened that may matter to the owner: a new occasion. */
export const OccasionOpened = record(
  "rin.occasion.opened",
  ActiveOccasion.extend({ kind: OccasionKind }),
  occasionGuard(
    (state) => state.open === null ? undefined : openChanged,
    (state, data) => ({ ...state, open: data.occasion }),
  ),
);

/** The same thing happened again while its occasion holds. */
export const OccasionRepeated = record(
  "rin.occasion.repeated",
  ActiveOccasion,
  occasionGuard(
    (state, data) => state.open === data.occasion ? undefined : openChanged,
    (state) => state,
  ),
);

/** An occasion no longer holds. What waits about it is dropped. */
export const OccasionEnded = record(
  "rin.occasion.ended",
  ActiveOccasion.partial({ text: true }),
  occasionGuard(
    (state, data) => state.open === data.occasion ? undefined : openChanged,
    (state) => ({ ...state, open: null }),
  ),
);

/** An end notice reached an occasion key with no open occasion. */
export const OccasionIgnored = record(
  "rin.occasion.ignored",
  Notice,
  occasionGuard(
    (state) => state.open === null ? undefined : openChanged,
    (state) => state,
  ),
);

/** Claim delivery of the fact for this occasion before calling the agent. */
export const OccasionClaimed = record(
  "rin.occasion.claimed",
  OccasionRevision.extend({ text: z.string() }),
  occasionGuard(
    (state, data) => state.open !== data.occasion ? openChanged : state.notifications.has(data.occasion)
      ? { code: "occasion-already-claimed", reason: "Delivery of this occasion was already claimed" } : undefined,
    (state, data) => ({ ...state, notifications: new Map(state.notifications).set(data.occasion, "claimed") }),
  ),
);

export const OccasionNotified = record(
  "rin.occasion.notified",
  OccasionRevision,
  occasionGuard(
    (state, data) => state.notifications.get(data.occasion) === "claimed"
      ? undefined : { code: "occasion-unclaimed", reason: "There is no outstanding delivery claim for this occasion" },
    (state, data) => ({ ...state, notifications: new Map(state.notifications).set(data.occasion, "notified") }),
  ),
);

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

/** She tried to tell him now and cannot tell whether it reached him: it is not said again, and it does not wait. */
export const AttentionUnsure = record(
  "rin.attention.unsure",
  z.object({ item: ItemId, subject: Subject, text: Text, why: z.string().min(1), rule: RuleId.optional() }),
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
    /**
     * The note of her memory it is about, and what he did to it. The note's words are not copied here: they are
     * read from memory's records when the correction is shown, and not shown for a note erased since.
     */
    note: NoteChange.optional(),
  }),
  charterGuard(
    (state, data) => state.corrections.has(data.correction) ? { code: "correction-known", reason: "This correction already exists" } : undefined,
    (state, data) => ({ ...state, corrections: new Map(state.corrections).set(data.correction, "new") }),
  ),
);

/** Corrections about one thing repeat: Rin is asked whether a rule of her charter should cover them. */
export const CharterDue = record(
  "rin.charter.due",
  z.object({ about: Topic, corrections: z.array(CorrectionId).min(1), mode: CharterMode.optional() }),
  charterGuard(
    (state, data) => hasProposal(state) || data.corrections.some((id) => state.corrections.get(id) !== "new")
      ? { code: "corrections-changed", reason: "These corrections can no longer make a rule due" } : undefined,
    (state, data) => correctionStatus(state, data.corrections, "asked"),
  ),
);

/** A rule of the charter was proposed to the owner, with the corrections it covers. */
export const CharterProposed = record(
  "rin.charter.proposed",
  z.object({ rule: RuleId, about: Topic, text: Text, corrections: z.array(CorrectionId), by: TurnAuthor }),
  charterGuard(
    (state, data) => {
      if (state.rules.has(data.rule)) return { code: "rule-known", reason: "This rule already exists" };
      if (data.by.kind === "agent" && hasProposal(state)) return { code: "open-proposal", reason: `A rule about ${data.about} already waits for the owner's word` };
      if (data.corrections.some((id) => !state.corrections.has(id) || state.corrections.get(id) === "covered")) {
        return { code: "corrections-changed", reason: "Only uncovered corrections about this topic can be attached" };
      }
    },
    (state, data) => ({
      ...correctionStatus(state, data.corrections, "covered"),
      rules: new Map(state.rules).set(data.rule, "proposed"),
    }),
  ),
);

/** The owner confirmed a rule: it is part of the charter from now on. */
export const CharterRuled = record("rin.charter.ruled", z.object({ rule: RuleId, about: Topic, by: Address }), ruleStatus("ruled"));

/** Rin applied a communication preference supported by the owner's feedback. */
export const CharterLearned = record(
  "rin.charter.learned",
  z.object({
    rule: RuleId,
    about: Topic,
    preference: CommunicationPreference,
    basis: LearningBasis,
    evidence: z.array(CorrectionEvidence).min(1),
    by: z.object({ kind: z.literal("agent"), id: z.literal("rin") }),
  }),
  {
    providerOnly: "rin",
    ...charterGuard(
      (state, data) => {
        if (state.rules.has(data.rule)) return { code: "rule-known", reason: "This rule already exists" };
        if ([...state.rules.values()].includes("learned")) {
          return { code: "learned-exists", reason: `A learned preference about ${data.about} is already active` };
        }
        if (hasProposal(state)) return { code: "open-proposal", reason: `A rule about ${data.about} already waits for the owner's word` };
        if (data.evidence.some(({ source }) => state.learnedSources.has(source))) {
          return { code: "feedback-used", reason: "This owner feedback already supported a learned preference" };
        }
        if (data.evidence.some(({ correction }) => !state.corrections.has(correction) || state.corrections.get(correction) === "covered")) {
          return { code: "corrections-changed", reason: "Only uncovered corrections about this topic can support a preference" };
        }
      },
      (state, data) => ({
        ...correctionStatus(state, data.evidence.map(({ correction }) => correction), "covered"),
        learnedSources: new Set([...state.learnedSources, ...data.evidence.map(({ source }) => source)]),
        rules: new Map(state.rules).set(data.rule, "learned"),
      }),
    ),
  },
);

/** A proposed rule did not become part of the charter: the owner said no, the question was dropped, or something else than he answered it. */
export const CharterDeclined = record(
  "rin.charter.declined",
  z.object({ rule: RuleId, about: Topic, why: z.enum(["declined", "cancelled", "expired", "not-his"]) }),
  ruleStatus("declined"),
);

/** The owner took a rule out of the charter. */
export const CharterRetired = record("rin.charter.retired", z.object({ rule: RuleId, about: Topic, reason: z.string().min(1).optional() }), ruleStatus("retired"));

// ---- changing herself -----------------------------------------------------------------------------------------

/**
 * Rin asked to install a plugin of her own group: the module, and the hash of the file as it was when she asked.
 * The install is pinned to that hash, so what the owner approves is the file that is installed.
 */
export const SelfEditMode = z.enum(["off", "ask", "free"]);
export type SelfEditMode = z.output<typeof SelfEditMode>;
const Hash = z.string().regex(/^[a-f0-9]{64}$/);
const RinModule = z.string().regex(/^rin(?:\/[a-z][a-z0-9-]*)+$/);
const EditProposal = z.object({ edit: EditId, plugin: RinModule, module: z.string().min(1), hash: Hash, why: Text, mode: z.enum(["ask", "free"]) });
const EditOutcome = z.enum(["installed", "declined", "cancelled", "expired", "not-his", "failed", "unknown"]);

export const SelfEditProposed = record(
  "rin.self-edit.proposed",
  EditProposal,
);

/** The approved installation now owns the right to try the effect for this plugin. */
export const SelfEditClaimed = record(
  "rin.self-edit.claimed",
  z.object({ plugin: z.string(), edit: EditId, hash: Hash }),
  editGuard(
    (current) => current === null ? undefined : { code: "edit-in-progress", reason: "An installation is already in progress" },
    (_current, data) => data.edit,
  ),
);

/** How a change of herself ended: installed, or why it was not. */
export const SelfEditSettled = record(
  "rin.self-edit.settled",
  z.object({ edit: EditId, plugin: z.string(), outcome: EditOutcome, detail: z.string().optional() }),
  editGuard(
    (current, data) => current === data.edit || (current === null && data.outcome !== "installed" && data.outcome !== "unknown")
      ? undefined : { code: "edit-unclaimed", reason: "This installation holds no claim" },
    (current, data) => current === data.edit ? null : current,
  ),
);

/** The record types Rin declares. */
export const RIN_TYPES = [
  OccasionOpened,
  OccasionRepeated,
  OccasionEnded,
  OccasionIgnored,
  OccasionClaimed,
  OccasionNotified,
  AttentionDecided,
  AttentionHeld,
  AttentionSending,
  AttentionUnsure,
  AttentionSaid,
  AttentionBrought,
  AttentionDropped,
  AttentionDismissed,
  Corrected,
  CharterDue,
  CharterProposed,
  CharterRuled,
  CharterLearned,
  CharterDeclined,
  CharterRetired,
  SelfEditProposed,
  SelfEditClaimed,
  SelfEditSettled,
] as const;

// ---- actions --------------------------------------------------------------------------------------------------

/** One rule of the charter as it is read. */
export const RuleItem = z.object({
  rule: RuleId,
  about: Topic,
  text: Text,
  status: z.enum(["proposed", "ruled", "learned", "declined", "retired"]),
  corrections: z.array(CorrectionId),
  by: TurnAuthor.optional(),
  learning: z.object({ preference: CommunicationPreference, basis: LearningBasis, evidence: z.array(CorrectionEvidence) }).optional(),
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
export const ItemStatus = z.enum(["held", "sending", "unsure", "said", "brought", "dropped", "dismissed"]);
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

export const rinCharterLearn = actionRef("rin.charter.learn", {
  description: "In auto charter mode, Rin applies a communication preference. Give a correction with the owner's explicit words, or separate corrections for a recurring pattern. There can be one active learned preference per topic.",
  input: z.object({ about: Topic, preference: CommunicationPreference, basis: LearningBasis, corrections: z.array(CorrectionId).min(1) }),
  output: z.object({ rule: RuleId, status: z.literal("learned") }),
});

export const rinCharterRetire = actionRef("rin.charter.retire", {
  description: "The owner takes a rule out of Rin's charter.",
  input: z.object({ rule: RuleId, reason: z.string().min(1).optional() }),
  output: z.object({ rule: RuleId }),
});

export const rinCharter = actionRef("rin.charter", {
  description: "Rin's charter: owner-confirmed and proposed rules, communication preferences Rin learned, and their evidence.",
  input: z.object({}),
  output: z.object({ rules: z.array(RuleItem), corrections: z.array(CorrectionItem) }),
});

export const rinSelfInstall = actionRef("rin.self.install", {
  description:
    "Proposes installing a plugin of Rin’s group (rin/*) from a module file. Say what the plugin does and why. The host’s selfEdit setting controls whether the owner must approve the specific file hash.",
  input: z.object({ plugin: z.string().min(1), module: z.string().min(1), why: Text }),
  output: z.object({ edit: EditId, hash: z.string() }),
});

/** The core action that installs a plugin from a file, as the handler that carries out an approved change calls it. */
export const pluginInstall = actionRef("plugin.install", {
  description: "Installs a plugin from a module file, or replaces the installed plugin of that name; the hash pins the file.",
  input: z.object({ plugin: z.string().min(1), module: z.string().min(1), hash: z.string().min(1).optional() }),
  output: z.object({ plugin: z.string(), version: z.string(), hash: z.string() }),
  target: (input) => input.plugin,
});

export const rinSelfHistory = actionRef("rin.self.history", {
  description: "Rin's proposed and completed module installations and their current status.",
  input: z.object({}),
  output: z.object({
    mode: SelfEditMode,
    edits: z.array(EditProposal.extend({ at: z.number(), status: z.union([EditOutcome, z.enum(["pending", "installing"])]), detail: z.string().optional() })),
    installed: z.array(z.object({ plugin: z.string(), hash: Hash, version: z.string() })),
  }),
});

export const rinInbox = actionRef("rin.inbox", {
  description:
    "What reached Rin's inbox, newest first, with the id of each turn: a task's outcome, a promise falling due, the digest of an attached session, a message. `rin.attend` on a turn names it by that id. By default only the turns she has not decided about.",
  input: z.object({ decided: z.boolean().optional(), limit: z.number().int().positive().max(100).default(20) }),
  output: z.object({
    turns: z.array(
      z.object({
        turn: TurnId,
        kind: z.enum(["message", "fact"]),
        from: TurnAuthor,
        /** The first lines of what it says. */
        text: z.string(),
        decided: z.boolean(),
      }),
    ),
  }),
});

/** Where a message of the owner's to Rin stands: waiting in her inbox, in her session, or not delivered. */
export const Delivery = z.enum(["waiting", "delivered", "unsent", "possibly-sent"]);
export type Delivery = z.output<typeof Delivery>;

export const rinConversation = actionRef("rin.conversation", {
  description:
    "The conversation between the owner and Rin, oldest first, the last of it: what he wrote to her, with where each message stands (waiting in her inbox, delivered to her session, not delivered), and what she wrote to him.",
  input: z.object({ conversation: z.string().min(1).default("rin"), limit: z.number().int().positive().max(200).default(50) }),
  output: z.object({
    messages: z.array(
      z.object({
        id: z.string(),
        turn: TurnId.optional(),
        from: z.enum(["owner", "rin"]),
        text: z.string(),
        at: z.number(),
        /** For what he wrote: where it stands. */
        delivery: Delivery.optional(),
      }),
    ),
  }),
});

export const rinBriefing = actionRef("rin.briefing", {
  description: "Rin's section of a briefing: what she held for the owner's next contact, and the rules of her charter that wait for his word.",
  input: z.object({ agent: AgentName }),
  output: z.object({ text: z.string() }),
});

export const rinPromptCharter = actionRef("rin.prompt.charter", {
  description: "Rin's charter as a section of the prompt of her sessions: the rules the owner confirmed, as they stand when a session starts.",
  input: PromptSectionInput,
  output: PromptSectionOutput,
});

/** The actions of Rin's attention and charter, for her hands. */
export const RIN_ACTIONS = [rinNotice, rinAttend, rinInbox, rinConversation, rinContext, rinAttention, rinCorrect, rinCharterPropose, rinCharterLearn, rinCharter, rinSelfInstall] as const;
