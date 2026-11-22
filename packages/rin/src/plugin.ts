/**
 * The Rin plugin: her definition, her attention, the corrections she learns from and her charter, on a host.
 *
 * Rin is an agent of the agents module (`agent:rin`); this plugin offers her definition and adds what makes her
 * Rin. Something that happened reaches her as an occasion (`rin.notice`, and the occasions she follows herself:
 * a stuck agent, a run she started that finished); she decides in her main session what to do about it
 * (`rin.attend`), and the plugin carries the decision out: it holds what waits for the owner's next contact or
 * for the end of his quiet hours, tells him now through the configured delivery action, and brings up
 * what waits when he writes to her or attaches a session.
 *
 * His corrections are written down (`rin.corrected`), whether he says them, she writes them from his words, or he
 * acts them out: changes a note of hers, cancels what she promised or decided, turns down or leaves unanswered
 * what she asked, waves away what she told him. Corrections about one thing that repeat ask her for a rule; the
 * rules she proposes require his yes. In auto mode she can also learn communication preferences from his feedback.
 *
 * What she does reaches nobody with the rights of whoever told her something: the plugin's handlers carry her
 * decisions out, and her own actions check that it is she, or the owner, who calls them.
 */

import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { isAbsolute } from "node:path";
import { fileURLToPath } from "node:url";

import { CORE_TYPES, OptionIdSchema, RecordRefused, action, actionName, agent as agentAddress, owner, recordId, seq } from "@niwa-labs/core";
import type { Address, Caller, JournalReader, Outcome, RecordType, Step, StoredRecord } from "@niwa-labs/core";
import { AGENT, COCKPIT_MODULE, plugin, trigger } from "@niwa-labs/plugin";
import type { CallerBinding, Plugin, PluginApi } from "@niwa-labs/plugin";
import { AGENT_BRIEFING, AGENT_PROMPT_SECTION, AgentAttached, AgentTurnDelivered, AgentTurnFailed, AgentTurnQueued, AgentTurnReplied, agentNotify, agentReply, agentTell } from "@niwa-labs/agent/records";
import type { TurnAuthor } from "@niwa-labs/agent/records";
import { CommitmentCancelled, CommitmentMade } from "@niwa-labs/commitments/records";
import { DecisionMade, DecisionRevoked } from "@niwa-labs/delegate/records";
import { NoteCorrected, NoteErased, NoteRetracted, NoteWritten, memoryConsolidate } from "@niwa-labs/memory/records";
import { Message as MessageEnvelope, MessageReceived, MessageSent, contentText } from "@niwa-labs/messages/records";
import type { Message } from "@niwa-labs/messages/records";
import { RequestAnswered, RequestCancelled, RequestCancelledRecord, RequestCreated, RequestExpired, RequestExpiredRecord, answeredBy, question, requestAsk } from "@niwa-labs/requests/records";
import { timer } from "@niwa-labs/timer";
import { RunFinished, RunRequested } from "@niwa-labs/workflow/records";

import {
  DEFAULT_CEILING,
  DEFAULT_QUIET,
  briefingText,
  ceilingLeft,
  foldAttention,
  heldItems,
  inQuietHours,
  insistRefusal,
  itemView,
  noticeOf,
  openOccasions,
  pendingAbout,
  repeatRefusal,
  quietEnds,
  routeOf,
  sayNow,
  ATTACHED,
} from "./attention.ts";
import type { AttentionState, Ceiling, Item, QuietHours, Row } from "./attention.ts";
import { DEFAULT_RULE_AFTER, charterText, correctionView, dueFor, foldCharter, learnedRules, ruleView, ruledRules } from "./charter.ts";
import type { CharterState, Correction } from "./charter.ts";
import { RIN_AGENT, rinDefinition } from "./character.ts";
import type { Core } from "./character.ts";
import { PRESENCE_TYPES, workingNow } from "./presence.ts";
import {
  AttentionBrought,
  AttentionDecided,
  AttentionDismissed,
  AttentionDropped,
  AttentionHeld,
  AttentionSaid,
  AttentionSending,
  AttentionUnsure,
  CharterDeclined,
  CharterDue,
  CharterLearned,
  CharterMode,
  CharterProposed,
  CharterRetired,
  CharterRuled,
  Corrected,
  OccasionClaimed,
  OccasionEnded,
  OccasionIgnored,
  OccasionNotified,
  OccasionOpened,
  OccasionRepeated,
  RIN_TYPES,
  SelfEditClaimed,
  SelfEditMode,
  SelfEditProposed,
  SelfEditSettled,
  pluginInstall,
  rinAttend,
  rinAttention,
  rinBriefing,
  rinCharter,
  rinCharterLearn,
  rinCharterPropose,
  rinCharterRetire,
  rinContext,
  rinConversation,
  rinCorrect,
  rinDismiss,
  rinInbox,
  rinNotice,
  rinPromptCharter,
  rinSelfHistory,
  rinSelfInstall,
} from "./records.ts";
import type { Contact, Delivery, NoteChange, OccasionId, Subject, Topic } from "./records.ts";

/** What the Rin plugin is made with. */
export interface RinOptions {
  /**
   * The address a caller speaks as: the binding the composition gives the messages module, so a session of Rin
   * speaks as `agent:rin` and the owner's client as the owner.
   */
  readonly bind: CallerBinding;
  /** The harness installation her sessions run on, or the role the composition maps to one: exactly one. */
  readonly harness?: string;
  readonly role?: string;
  /** Whether Rin can apply communication preferences from feedback. Default: ask. */
  readonly charterMode?: CharterMode;
  /** Policy for module installs proposed by Rin. Default: off. */
  readonly selfEdit?: SelfEditMode;
  /** The core of her character; the one of this package unless the owner gives his own. */
  readonly core?: Core;
  /** The owner's quiet hours, local time. Default 23:00 to 08:00. */
  readonly quietHours?: QuietHours;
  /** The safety ceiling on what she says now. Default: twelve in any 24 hours. */
  readonly ceiling?: Ceiling;
  /** Enable Telegram delivery and require telegram.send at host startup. */
  readonly telegram?: boolean;
  /** Action for proactive messages, given `{ text }`. Uses Telegram when enabled. */
  readonly say?: string;
  /** How many corrections about one thing, not covered by a rule, ask her for one. Default: two. */
  readonly ruleAfter?: number;
}

/** A refusal of Rin's: a caller that is neither she nor the owner, or a decision that does not hold. */
export class RinRefusal extends Error {
  override name = "RinRefusal";
  constructor(
    readonly code: "not-rin" | "not-owner" | "unknown" | "no-text" | "already-said" | "insist" | "open-proposal" | "not-his-words" | "charter-ask" | "charter-evidence" | "self-edit-off" | "not-her-group" | "unreachable",
    message: string,
  ) {
    super(message);
  }
}

/** An id of a kind, cut from what makes it unique, so a repeat makes the same id. */
function idOf<P extends string>(prefix: P, seed: string): `${P}-${string}` {
  return `${prefix}-${createHash("sha256").update(seed).digest("hex").slice(0, 10)}`;
}

/** The first line of a text, cut to fit a line of a list. */
function firstLine(text: string, max = 160): string {
  const line = text.split(/\r?\n/, 1)[0]?.trim() ?? "";
  return line.length <= max ? line : `${line.slice(0, max - 1).trimEnd()}…`;
}

/** The record types her attention is folded from. */
const ATTENTION_TYPES = [OccasionOpened, OccasionRepeated, OccasionEnded, AttentionDecided, AttentionHeld, AttentionSending, AttentionSaid, AttentionUnsure, AttentionBrought, AttentionDropped, AttentionDismissed].map((type) => type.name as string);
const CHARTER_TYPES = [Corrected, CharterDue, CharterProposed, CharterRuled, CharterLearned, CharterDeclined, CharterRetired].map((type) => type.name as string);

/** The choices of a question to the owner that only his yes settles. */
const CONFIRM = OptionIdSchema.parse("confirm");
const DECLINE = OptionIdSchema.parse("decline");
function confirmQuestion(name: string, title: string) {
  return question(name, {
    kind: "choice",
    title,
    options: [
      { id: CONFIRM, label: "confirm", flavor: "plain" },
      { id: DECLINE, label: "decline", flavor: "plain" },
    ],
  });
}
/** The question that puts a rule of the charter to the owner. */
const ruleQuestion = (text: string, about: string) => confirmQuestion("rin.charter.confirm", `Rin proposes a rule for her charter (${about}): ${text}`);

/** How a question that only the owner's yes settles ended. */
type Verdict = "confirmed" | "declined" | "cancelled" | "expired";

/** Recover this handler's exact install without running module code again. */
function recordedInstall(log: JournalReader, actor: Extract<Caller, { kind: "handler" }>, input: { plugin: string; module: string; hash: string }): Outcome<unknown> | undefined {
  const own = (row: StoredRecord) => row.actor.kind === "handler" && row.actor.handler === actor.handler && row.actor.invocation === actor.invocation;
  const intents = log.find({ type: CORE_TYPES.stepIntent, field: "invocation", equals: actor.invocation });
  const intent = intents.findLast((row) => own(row) && (row.data as { key: string }).key === "install");
  if (intent === undefined) return undefined;
  const call = intent.data as { action: string; operationId: string; input: typeof input };
  if (call.action !== pluginInstall.name || call.input.plugin !== input.plugin || call.input.module !== input.module || call.input.hash !== input.hash) {
    return { status: "unknown" };
  }
  const receipt = log.get(recordId(`${call.operationId}/installed`));
  if (receipt?.type === CORE_TYPES.pluginInstalled && own(receipt)) {
    const saved = receipt.data as typeof input;
    if (saved.plugin === input.plugin && saved.module === input.module && saved.hash === input.hash) return { status: "completed", value: undefined };
    return { status: "unknown" };
  }
  const ended = log.find({ type: CORE_TYPES.stepOutcome, field: "invocation", equals: actor.invocation })
    .findLast((row) => own(row) && row.seq > intent.seq && (row.data as { key: string }).key === "install");
  const result = (ended?.data as { outcome: Outcome<unknown> } | undefined)?.outcome;
  return result === undefined || result.status === "completed" ? { status: "unknown" } : result;
}

/** A message the owner wrote to Rin: a contact, and his own words. */
const ToRin = { "to.kind": "agent", "to.id": RIN_AGENT, "from.kind": "owner" } as const;
const OwnerWroteToRin = trigger(MessageSent, { name: "message.sent:owner-to-rin", filter: ToRin });
const OwnerWroteInToRin = trigger(MessageReceived, { name: "message.received:owner-to-rin", filter: ToRin });

/** The Rin plugin. Install it after the agents module, which serves her, and with the plugins whose records she follows. */
export function rinPlugin(options: RinOptions): Plugin {
  const selfEdit = SelfEditMode.parse(options.selfEdit ?? "off");
  const charterMode = CharterMode.parse(options.charterMode ?? "ask");
  const definition = rinDefinition({
    ...(options.harness === undefined ? {} : { harness: options.harness }),
    ...(options.role === undefined ? {} : { role: options.role }),
    selfEdit,
    charterMode,
    ...(options.core === undefined ? {} : { core: options.core }),
  });
  const quiet = options.quietHours ?? DEFAULT_QUIET;
  const ceiling = options.ceiling ?? DEFAULT_CEILING;
  const sendAction = options.say ?? (options.telegram ? "telegram.send" : undefined);
  const say = sendAction === undefined ? undefined : actionName(sendAction);
  const ruleAfter = options.ruleAfter ?? DEFAULT_RULE_AFTER;
  const bind = options.bind;
  const quietEnd = timer.daily(quiet.to, { id: "rin-quiet-end", description: "The end of the owner's quiet hours" });

  return plugin("rin", (api: PluginApi) => {
    api.declare(...RIN_TYPES);
    api.needs({
      actions: [
        agentNotify, agentTell, agentReply, requestAsk, memoryConsolidate,
        ...(say === undefined ? [] : [say]),
        ...(options.telegram ? ["telegram.send"] : []),
        ...(selfEdit === "off" ? [] : [pluginInstall]),
      ],
      types: [AgentTurnReplied],
    });
    api.offer(AGENT, definition);
    api.offer(AGENT_BRIEFING, { title: "What Rin holds for you", action: rinBriefing.name });
    // Her charter is read when each session starts.
    api.offer(AGENT_PROMPT_SECTION, { id: "charter", agent: RIN_AGENT, action: rinPromptCharter.name });
    // Her page in the cockpit: a client module, offered by the path of its source.
    api.offer(COCKPIT_MODULE, { id: "rin", entry: fileURLToPath(new URL("./cockpit/index.tsx", import.meta.url)) });

    const journal = (): JournalReader | undefined => api.journal?.();
    const rowsOf = (types: readonly string[]): Row[] =>
      (journal()?.since(seq(0), types as never) ?? []).map((stored) => ({ type: stored.type, data: stored.data, at: stored.at, seq: stored.seq }));
    const attention = (): AttentionState => foldAttention(rowsOf([...ATTENTION_TYPES, ATTACHED]), RIN_AGENT);
    const charter = (): CharterState => foldCharter(rowsOf(CHARTER_TYPES));
    const ruledIds = () => new Set<string>(ruledRules(charter()).map((rule) => rule.rule));

    const charterGuidance = (): string => {
      const state = charter();
      const confirmed = charterText(ruledRules(state));
      const learned = charterText(learnedRules(state));
      return [
        confirmed === "" ? undefined : `Your charter, the rules the owner confirmed:\n${confirmed}`,
        learned === "" ? undefined : `Communication preferences you learned from the owner's feedback:\n${learned}\nApply these only to how you communicate. Follow owner-confirmed rules in a conflict. Insisting requires an owner-confirmed rule.`,
      ].filter((one) => one !== undefined).join("\n\n") || "Your charter has no rules yet.";
    };

    /** Wait for the answer requests accepts through an authenticated owner connection. */
    const askOwner = async (step: Step, asking: ReturnType<typeof confirmQuestion>, key: string): Promise<Verdict> => {
      try {
        const { answer } = answeredBy(await step(requestAsk, { to: owner, answerPolicy: "owner-only", ...asking }, { key }));
        return "ids" in answer && answer.ids[0] === CONFIRM ? "confirmed" : "declined";
      } catch (error) {
        if (error instanceof RequestCancelled) return "cancelled";
        if (error instanceof RequestExpired) return "expired";
        throw error;
      }
    };

    // The clock of the host, once it serves.
    let clock: (() => number) | undefined;
    api.service((ctx) => {
      clock = () => ctx.now();
      return () => {
        clock = undefined;
      };
    });
    const now = (): number => {
      if (clock === undefined) throw new Error("rin: the host is not serving");
      return clock();
    };

    /** Who a caller is to Rin: she, the owner, or anybody else. */
    const whoIs = (caller: Caller): "rin" | "owner" | "other" => {
      const address = bind(caller);
      if (address?.kind === "owner") return "owner";
      if (address?.kind === "agent" && address.id === RIN_AGENT) return "rin";
      return "other";
    };
    /** The author a record of hers names: the caller's address, or niwa's own. */
    const authorOf = (caller: Caller): TurnAuthor => {
      if (caller.kind === "handler") return { kind: "niwa", by: String(caller.handler) };
      if (caller.kind === "host") return { kind: "niwa", by: "host" };
      return bind(caller) ?? { kind: "niwa", by: String(caller.id) };
    };

    /** What she weighs before she speaks, as text that goes with every occasion she is told. */
    const contextText = (at: number): string => {
      const lines: string[] = [];
      const working = workingNow(rowsOf(PRESENCE_TYPES));
      lines.push(
        working.length === 0
          ? "The owner is not working in an attached session now."
          : `The owner is working now: ${working.map((one) => `${one.session} in ${one.cwd}`).join("; ")}.`,
      );
      const ends = quietEnds(at, quiet);
      if (ends !== undefined) lines.push(`These are his quiet hours, until ${quiet.to}: what you say now waits until then.`);
      const left = ceilingLeft(attention().said, at, ceiling);
      if (left === 0) lines.push("The safety ceiling is reached: what you say now waits for his next contact.");
      lines.push(charterGuidance());
      return lines.join("\n");
    };

    // Serialize attention routing for the shared ceiling and for items brought at owner contact.
    // Occasion and charter transitions are admitted by the journal.
    let tail: Promise<unknown> = Promise.resolve();
    const serially = <T>(work: () => Promise<T>): Promise<T> => {
      const run = tail.then(work, work);
      tail = run.catch(() => undefined);
      return run;
    };

    // ---- occasions -----------------------------------------------------------------------------------------

    /** Write a notice against the open occurrence of its key. On replay it keeps its first outcome. */
    const notice = async (
      emit: <T>(type: RecordType<T>, data: T, key: string) => Promise<StoredRecord>,
      input: { key: string; kind: string; text: string; ends?: boolean },
      from: TurnAuthor,
      seed: string,
    ): Promise<{ occasion?: OccasionId; status: "opened" | "repeated" | "ended" | "none" }> => {
      const committed = [
        [OccasionOpened, "opened"], [OccasionRepeated, "repeated"],
        [OccasionEnded, "ended"], [OccasionIgnored, "none"],
      ] as const;
      for (const [type, status] of committed) {
        const row = journal()?.find({ type: type.name, field: "notice", equals: seed })[0];
        if (row === undefined) continue;
        const data = type.schema.parse(row.data);
        return { status, ...("occasion" in data && typeof data.occasion === "string" ? { occasion: data.occasion } : {}) };
      }

      const found = noticeOf(attention(), input);
      const data = { key: input.key, notice: seed, text: input.text, from };
      switch (found.kind) {
        case "open": {
          const occasion = idOf("occ", seed);
          await emit(OccasionOpened, { ...data, occasion, kind: input.kind }, `open-${occasion}`);
          return { occasion, status: "opened" };
        }
        case "repeat":
          await emit(OccasionRepeated, { ...data, occasion: found.occasion }, `repeat-${found.occasion}`);
          return { occasion: found.occasion, status: "repeated" };
        case "end":
          await emit(OccasionEnded, { ...data, occasion: found.occasion }, `end-${found.occasion}`);
          return { occasion: found.occasion, status: "ended" };
        case "none":
          await emit(OccasionIgnored, { key: input.key, notice: seed }, "ignore");
          return { status: "none" };
      }
    };

    api.action(
      action(rinNotice, {
        // The occasion's id is cut from the operation, and each record it writes follows the operation.
        recovery: "repeat",
        effect: "record",
        world: "niwa",
        run: (input, ctx) => notice((type, data) => ctx.emit(type, data), input, authorOf(ctx.caller), String(ctx.operationId)),
      }),
    );

    // A new occasion reaches her inbox as a fact, with what she weighs before she decides. The plugin tells her,
    // not whoever noticed it: telling an agent is no right of theirs.
    api.on(OccasionOpened, { concurrency: { by: (data) => data.key } }, async (data, step, stored) => {
      const occurrence = { key: data.key, occasion: data.occasion };
      const previous = journal()?.find({ type: OccasionClaimed.name, field: "occasion", equals: data.occasion })[0];
      const text = previous === undefined ? [
        `Something happened (occasion ${data.occasion}, ${data.kind}): ${data.text}`,
        "",
        contextText(stored.at),
        "",
        `Decide with rin.attend on { kind: "occasion", occasion: "${data.occasion}" }.`,
      ].join("\n") : OccasionClaimed.schema.parse(previous.data).text;
      try {
        await step.emit(OccasionClaimed, { ...occurrence, text }, { key: "claim" });
      } catch (error) {
        if (error instanceof RecordRefused && (error.code === "occasion-changed" || error.code === "occasion-already-claimed")) return;
        throw error;
      }
      await step(agentNotify, { agent: RIN_AGENT, text }, { key: "notify" });
      await step.emit(OccasionNotified, occurrence, { key: "notified" });
    });

    // An agent she leads that cannot be reached is an occasion; it ends when a turn reaches it again.
    api.on(AgentTurnFailed, { id: "stuck-agent" }, async (data, step, stored) => {
      if (data.agent === RIN_AGENT) return;
      const text = `A turn did not reach agent ${data.agent} (${data.status}): ${firstLine(data.reason)}`;
      await notice((type, value, key) => step.emit(type, value, { key }), { key: `agent:${data.agent}:unreachable`, kind: "agent", text }, { kind: "niwa", by: "agents" }, String(stored.id));
    });
    api.on(AgentTurnDelivered, { id: "agent-reachable" }, async (data, step, stored) => {
      if (data.agent === RIN_AGENT) return;
      const text = `A turn reached agent ${data.agent} again.`;
      await notice((type, value, key) => step.emit(type, value, { key }), { key: `agent:${data.agent}:unreachable`, kind: "agent", text, ends: true }, { kind: "niwa", by: "agents" }, String(stored.id));
    });

    // A workflow run she started that finished is an occasion: she learns its outcome without asking. Who started it
    // is who asked for it (the record of the request); the run's own start is written by the workflow module.
    api.on(RunFinished, { id: "run-finished", requires: [RunFinished] }, async (data, step, stored) => {
      const requested = journal()?.find({ type: RunRequested.name, field: "run", equals: data.run })[0];
      if (requested === undefined || whoIs(requested.actor) !== "rin") return;
      const asked = RunRequested.schema.safeParse(requested.data);
      if (!asked.success) return;
      const label = asked.data.label ?? asked.data.file;
      const how = data.outcome.status === "failed" ? `failed: ${firstLine(data.outcome.error.message)}` : data.outcome.status;
      const text = `The workflow run ${data.run}${label === "" ? "" : ` (${label})`} you started ended: ${how}.`;
      await notice((type, value, key) => step.emit(type, value, { key }), { key: `run:${data.run}`, kind: "workflow", text }, { kind: "niwa", by: "workflow" }, String(stored.id));
    });

    // ---- her decisions --------------------------------------------------------------------------------------

    /** Is the subject one she can decide about: an occasion of hers that still holds, or a turn of her inbox? */
    const known = (subject: Subject, state: AttentionState): boolean => {
      if (subject.kind === "occasion") {
        const occasion = state.occasions.get(subject.occasion);
        return occasion !== undefined && state.open.get(occasion.key) === occasion.occasion;
      }
      return (journal()?.find({ type: AgentTurnQueued.name, field: "turn", equals: subject.turn }) ?? []).some((stored) => {
        const turn = stored.data as { agent?: unknown; turn?: unknown };
        return turn.agent === RIN_AGENT && turn.turn === subject.turn;
      });
    };

    api.action(
      action(rinAttend, {
        // Every record follows the operation: a repeat finds what the first call wrote.
        recovery: "repeat",
        effect: "record",
        world: "niwa",
        run: (input, ctx) =>
          serially(async () => {
            if (whoIs(ctx.caller) !== "rin") throw new RinRefusal("not-rin", "only Rin decides what to do about what reaches her");
            const state = attention();
            if (!known(input.subject, state)) throw new RinRefusal("unknown", "there is no such occasion that holds, or turn of hers");
            const telling = input.decision === "next-contact" || input.decision === "now" || input.decision === "insist";
            if (telling && input.text === undefined) throw new RinRefusal("no-text", `"${input.decision}" needs the text the owner is to read`);
            if ((input.decision === "now" || input.decision === "insist") && say === undefined) throw new RinRefusal("unreachable", "No channel is configured for proactive messages; hold it for the owner’s next contact");
            if (input.decision === "now" || input.decision === "next-contact") {
              const refused = repeatRefusal(state, input.subject);
              if (refused !== undefined) throw new RinRefusal("already-said", refused);
            }
            if (input.decision === "insist") {
              const refused = insistRefusal(state, input.subject, input.rule, ruledIds());
              if (refused !== undefined) throw new RinRefusal("insist", refused);
            }
            const decided = await ctx.emit(AttentionDecided, {
              subject: input.subject,
              decision: input.decision,
              ...(input.text === undefined ? {} : { text: input.text }),
              ...(input.rule === undefined ? {} : { rule: input.rule }),
            });
            const route = routeOf(input.decision, { at: decided.at, quiet, ceiling, said: state.said });
            if (route.kind === "keep" || input.text === undefined) return { decision: input.decision, outcome: "kept" as const };
            // A decision about what already waits takes the place of the one that waits: one thing, one message.
            const item = pendingAbout(state, input.subject)?.item ?? idOf("att", String(ctx.operationId));
            const rule = input.decision === "insist" && input.rule !== undefined ? { rule: input.rule } : {};
            if (route.kind === "say") {
              await ctx.emit(AttentionSending, { item, subject: input.subject, text: input.text, ...rule });
              return { decision: input.decision, outcome: "sending" as const, item };
            }
            await ctx.emit(AttentionHeld, { item, subject: input.subject, text: input.text, until: route.until, why: route.why, ...rule });
            return { decision: input.decision, outcome: "held" as const, item, why: route.why, ...(route.until === "quiet-end" ? { until: route.at } : {}) };
          }),
      }),
    );

    // What she says now goes out through the action of the composition, called by this plugin. What cannot reach
    // the owner waits for his next contact, and she is told.
    api.on(AttentionSending, { id: "say" }, async (data, step) => {
      if (say === undefined) {
        await step.emit(AttentionHeld, { ...data, until: "contact", why: "undelivered" }, { key: "hold" });
        return;
      }
      const sent = await step.outcome<{ text: string }, unknown>(say, { text: data.text }, { key: "say" });
      const rule = data.rule === undefined ? {} : { rule: data.rule };
      if (sent.status === "completed") {
        await step.emit(AttentionSaid, { item: data.item, subject: data.subject, text: data.text, channel: String(say), ...rule });
        return;
      }
      // Only what surely did not go waits for the next contact; what may have gone is not sent again.
      const nothingSent = sent.status === "denied" || (sent.status === "failed" && !sent.effectPossible);
      const why = sent.status === "failed" ? sent.error : sent.status === "denied" || sent.status === "cancelled" ? sent.reason : "the outcome is not known";
      if (!nothingSent) {
        await step.emit(AttentionUnsure, { item: data.item, subject: data.subject, text: data.text, why, ...rule });
        await step(agentNotify, { agent: RIN_AGENT, text: `What you meant to tell the owner now may or may not have reached him (${firstLine(why)}); it is not sent again, and does not wait: ask him if it matters: ${firstLine(data.text)}` });
        return;
      }
      const state = attention();
      const occasion = data.subject.kind === "occasion" ? state.occasions.get(data.subject.occasion) : undefined;
      if (occasion !== undefined && state.open.get(occasion.key) !== occasion.occasion) {
        // Its occasion ended meanwhile: there is nothing left to tell him.
        await step.emit(AttentionDropped, { item: data.item, occasion: occasion.occasion });
        return;
      }
      await step.emit(AttentionHeld, { item: data.item, subject: data.subject, text: data.text, until: "contact", why: "undelivered", ...rule });
      await step(agentNotify, { agent: RIN_AGENT, text: `What you meant to tell the owner now did not reach him (${firstLine(why)}); it waits for his next contact: ${firstLine(data.text)}` });
    });

    // At the end of his quiet hours what waited for it is said, as far as the ceiling allows.
    api.on(quietEnd, { id: "quiet-end" }, (_firing, step, stored) =>
      serially(async () => {
        const state = attention();
        const said = [...state.said];
        for (const item of heldItems(state, "quiet-end")) {
          const route = say === undefined ? { kind: "hold", why: "undelivered" } as const : sayNow({ at: stored.at, quiet, ceiling, said });
          const rule = item.rule === undefined ? {} : { rule: item.rule };
          if (route.kind === "say") {
            said.push(stored.at);
            await step.emit(AttentionSending, { item: item.item, subject: item.subject, text: item.text, ...rule }, { key: `send-${item.item}` });
          } else {
            await step.emit(AttentionHeld, { item: item.item, subject: item.subject, text: item.text, until: "contact", why: route.kind === "hold" ? route.why : "ceiling", ...rule }, { key: `hold-${item.item}` });
          }
        }
      }),
    );

    // Rin's nightly quiet period ends at this firing. The durable step makes one consolidation per firing.
    api.on(quietEnd, { id: "wake-memory" }, async (_firing, step) => {
      await step(memoryConsolidate, { memory: RIN_AGENT }, { key: "consolidate" });
    });

    // ---- the owner in touch ---------------------------------------------------------------------------------

    /** What waits is brought up at a contact: what was held before it. */
    const bring = (step: Step, contact: Contact, before: number): Promise<void> =>
      serially(async () => {
        const items = heldItems(attention()).filter((item) => item.seq < before);
        if (items.length > 0) await step.emit(AttentionBrought, { items: items.map((item) => item.item), contact });
      });

    for (const source of [OwnerWroteToRin, OwnerWroteInToRin]) {
      api.on(source, { requires: [source.type] }, async (message: Message, step, stored) => {
        await bring(step, { kind: "message", message: message.id }, stored.seq);
      });
    }

    // She is told what was brought up when he wrote to her, from the record that says so: a restart between that
    // record and her being told finds the record. An attach needs no telling: it answers with the briefing.
    api.on(AttentionBrought, { id: "brought-told" }, async (data, step) => {
      if (data.contact.kind !== "message") return;
      const state = attention();
      const lines = data.items.flatMap((id) => {
        const item = state.items.get(id);
        return item === undefined ? [] : [`- ${item.text}${countText(state, item)}`];
      });
      if (lines.length === 0) return;
      await step(agentNotify, { agent: RIN_AGENT, text: ["The owner is in touch now. What you held for him, to bring up as it fits:", ...lines].join("\n") });
    });

    // An attach of his session to her answers with her briefing, which shows what waited: it is brought up.
    api.on(AgentAttached, { id: "attached", filter: { agent: RIN_AGENT } }, async (data, step, stored) => {
      await bring(step, { kind: "attach", session: data.session }, stored.seq);
    });

    // ---- reading --------------------------------------------------------------------------------------------

    api.action(
      action(rinInbox, {
        recovery: "repeat",
        effect: "read",
        world: "niwa",
        run: async (input) => {
          const decided = new Set((journal()?.since(seq(0), [AttentionDecided.name]) ?? []).flatMap((stored) => {
            const parsed = AttentionDecided.schema.safeParse(stored.data);
            return parsed.success && parsed.data.subject.kind === "turn" ? [parsed.data.subject.turn] : [];
          }));
          const turns = (journal()?.find({ type: AgentTurnQueued.name, field: "agent", equals: RIN_AGENT }) ?? []).flatMap((stored) => {
            const turn = AgentTurnQueued.schema.safeParse(stored.data);
            return turn.success ? [{ turn: turn.data.turn, kind: turn.data.kind, from: turn.data.author, text: firstLine(turn.data.text, 300), decided: decided.has(turn.data.turn) }] : [];
          });
          return { turns: turns.filter((one) => input.decided === undefined ? !one.decided : one.decided === input.decided).reverse().slice(0, input.limit) };
        },
      }),
    );

    api.action(
      action(rinConversation, {
        recovery: "repeat",
        effect: "read",
        world: "niwa",
        run: async (input, ctx) => {
          if (whoIs(ctx.caller) !== "owner") throw new RinRefusal("not-owner", "Only the owner can read this conversation");
          const rows = journal()?.since(seq(0), [MessageSent.name, AgentTurnDelivered.name, AgentTurnFailed.name, AgentTurnReplied.name]) ?? [];
          type Entry = { id: string; turn: string; from: "owner" | "rin"; text: string; at: number; delivery?: Delivery };
          const messages: Entry[] = [];
          const incoming = new Map<string, Entry>();
          for (const stored of rows) {
            if (stored.type === MessageSent.name) {
              const data = MessageEnvelope.parse(stored.data);
              if (data.from.kind !== "owner" || data.to.kind !== "agent" || data.to.id !== RIN_AGENT ||
                  data.replyTo?.channel !== "cockpit" || data.replyTo.conversation !== input.conversation) continue;
              const message: Entry = { id: data.id, turn: data.id, from: "owner", text: contentText(data), at: stored.at, delivery: "waiting" };
              incoming.set(data.id, message);
              messages.push(message);
            } else if (stored.type === AgentTurnReplied.name) {
              const data = AgentTurnReplied.schema.parse(stored.data);
              if (data.agent !== RIN_AGENT || data.replyTo.channel !== "cockpit" ||
                  data.replyTo.conversation !== input.conversation || !incoming.has(data.turn)) continue;
              messages.push({ id: String(stored.id), turn: data.turn, from: "rin", text: data.text, at: stored.at });
            } else if (stored.type === AgentTurnDelivered.name) {
              const data = AgentTurnDelivered.schema.parse(stored.data);
              const entry = data.agent === RIN_AGENT ? incoming.get(data.turn) : undefined;
              if (entry !== undefined) entry.delivery = "delivered";
            } else {
              const data = AgentTurnFailed.schema.parse(stored.data);
              const entry = data.agent === RIN_AGENT ? incoming.get(data.turn) : undefined;
              if (entry !== undefined && entry.delivery !== "delivered") entry.delivery = data.status;
            }
          }
          return { messages: messages.slice(-input.limit) };
        },
      }),
    );

    api.action(
      action(rinContext, {
        recovery: "repeat",
        effect: "read",
        world: "niwa",
        run: async () => {
          const at = now();
          const state = attention();
          const ends = quietEnds(at, quiet);
          return {
            at,
            working: workingNow(rowsOf(PRESENCE_TYPES)),
            quiet: { now: inQuietHours(at, quiet), from: quiet.from, to: quiet.to, ...(ends === undefined ? {} : { ends }) },
            ceiling: { count: ceiling.count, windowMs: ceiling.windowMs, left: ceilingLeft(state.said, at, ceiling) },
            charter: [...charter().rules.values()].filter((rule) => rule.status === "ruled" || rule.status === "learned" || rule.status === "proposed").map(ruleView),
            occasions: openOccasions(state),
            held: heldItems(state).map((item) => itemView(state, item)),
          };
        },
      }),
    );

    api.action(
      action(rinAttention, {
        recovery: "repeat",
        effect: "read",
        world: "niwa",
        run: async (input) => {
          const state = attention();
          const items = [...state.items.values()]
            .filter((item) => input.status === undefined || item.status === input.status)
            .sort((a, b) => b.at - a.at || b.seq - a.seq)
            .map((item) => itemView(state, item));
          return { items, occasions: openOccasions(state) };
        },
      }),
    );

    api.action(
      action(rinBriefing, {
        recovery: "repeat",
        effect: "read",
        world: "niwa",
        run: async (input) => {
          if (input.agent !== RIN_AGENT) return { text: "" };
          const sections: string[] = [];
          const held = briefingText(attention());
          if (held !== "") sections.push(held);
          const waiting = [...charter().rules.values()].filter((rule) => rule.status === "proposed");
          if (waiting.length > 0) sections.push(["Rules of her charter that wait for your word:", ...waiting.map((rule) => `- ${rule.text}`)].join("\n"));
          return { text: sections.join("\n\n") };
        },
      }),
    );

    api.action(
      action(rinPromptCharter, {
        recovery: "repeat",
        effect: "read",
        world: "niwa",
        run: async (input) => {
          if (input.agent !== RIN_AGENT) return { text: "" };
          return { text: charterGuidance() };
        },
      }),
    );

    api.action(
      action(rinCharter, {
        recovery: "repeat",
        effect: "read",
        world: "niwa",
        run: async () => {
          const state = charter();
          return { rules: [...state.rules.values()].map(ruleView), corrections: state.corrections.map((one) => correctionView(one, whatOf(one))) };
        },
      }),
    );

    // ---- corrections ----------------------------------------------------------------------------------------

    /** Read the same message ID from its envelope or the inbox turn that carries it. */
    const ownerMessageId = (stored: StoredRecord): string | undefined => {
      if (stored.type === MessageSent.name || stored.type === MessageReceived.name) {
        const message = MessageEnvelope.safeParse(stored.data);
        if (message.success && message.data.from.kind === "owner" && message.data.body.text.trim() !== "") return message.data.id;
      }
      if (stored.type === AgentTurnQueued.name) {
        const turn = AgentTurnQueued.schema.safeParse(stored.data);
        if (turn.success && turn.data.kind === "message" && turn.data.author.kind === "owner" && turn.data.text.trim() !== "") return turn.data.turn;
      }
    };

    const byRecordId = (id: string): StoredRecord | undefined => {
      try {
        return journal()?.get(recordId(id));
      } catch {
        return undefined;
      }
    };

    /** The source may be a journal record ID or the corresponding owner message ID. */
    const ownerWords = (id: string): { key: string; record: string } | undefined => {
      const direct = byRecordId(id);
      const candidates = direct === undefined ? [
        ...(journal()?.find({ type: MessageSent.name, field: "id", equals: id }) ?? []),
        ...(journal()?.find({ type: MessageReceived.name, field: "id", equals: id }) ?? []),
        ...(journal()?.find({ type: AgentTurnQueued.name, field: "turn", equals: id }) ?? []),
      ] : [direct];
      for (const row of candidates) {
        const key = ownerMessageId(row);
        if (key !== undefined) return { key, record: String(row.id) };
      }
    };

    api.action(
      action(rinCorrect, {
        recovery: "repeat",
        effect: "record",
        world: "niwa",
        run: async (input, ctx) => {
          const who = whoIs(ctx.caller);
          if (who === "other") throw new RinRefusal("not-owner", "a correction is the owner's: only he, or Rin from his words, writes one");
          if (who === "rin" && (input.source === undefined || ownerWords(input.source) === undefined)) {
            throw new RinRefusal("not-his-words", "Rin writes a correction only from the owner's own words: give the id of the record that holds them");
          }
          const correction = idOf("cor", String(ctx.operationId));
          await ctx.emit(Corrected, {
            correction,
            about: input.about,
            what: input.what,
            by: who === "owner" ? owner : agentAddress(RIN_AGENT),
            ...(input.source === undefined ? {} : { source: input.source }),
          });
          return { correction };
        },
      }),
    );

    api.action(
      action(rinDismiss, {
        recovery: "repeat",
        effect: "record",
        world: "niwa",
        run: async (input, ctx) => {
          if (whoIs(ctx.caller) !== "owner") throw new RinRefusal("not-owner", "only the owner waves away what Rin tells him");
          const state = attention();
          const item = state.items.get(input.item);
          if (item === undefined) throw new RinRefusal("unknown", `there is no item "${input.item}"`);
          const dismissed = await ctx.emit(AttentionDismissed, { item: input.item, ...(input.reason === undefined ? {} : { reason: input.reason }) });
          const kind = item.subject.kind === "occasion" ? state.occasions.get(item.subject.occasion)?.kind : undefined;
          const correction = idOf("cor", String(ctx.operationId));
          await ctx.emit(Corrected, {
            correction,
            about: kind === undefined ? "attention" : `attention.${kind}`,
            what: `The owner waved away what you told him: "${firstLine(item.text)}"${input.reason === undefined ? "" : `, saying: ${input.reason}`}`,
            by: { kind: "niwa", by: "rin.attention.dismiss" },
            source: String(dismissed.id),
          });
          return { item: input.item, correction };
        },
      }),
    );

    /** Write a correction the owner acted out, from the record of what he did. */
    const actedOut = (step: Step, stored: StoredRecord, about: Topic, what: string, note?: NoteChange) =>
      step.emit(Corrected, { correction: idOf("cor", String(stored.id)), about, what, by: { kind: "niwa", by: "rin" }, source: String(stored.id), ...(note === undefined ? {} : { note }) });

    /** Did Rin write this note of her memory? */
    const herNote = (memory: string, note: string) =>
      memory === RIN_AGENT &&
      (journal()?.find({ type: NoteWritten.name, field: "note", equals: note }) ?? []).some((stored) => {
        const written = stored.data as { memory?: unknown; by?: Address | TurnAuthor };
        return written.memory === memory && written.by?.kind === "agent" && written.by.id === RIN_AGENT;
      });

    /** The words of a note as they stood before a position of the journal: its text when written, or as last corrected. */
    const noteBefore = (memory: string, note: string, before: number): string | undefined => {
      const rows = [...(journal()?.find({ type: NoteWritten.name, field: "note", equals: note }) ?? []), ...(journal()?.find({ type: NoteCorrected.name, field: "note", equals: note }) ?? [])]
        .filter((stored) => stored.seq < before && (stored.data as { memory?: unknown }).memory === memory)
        .sort((a, b) => a.seq - b.seq);
      return (rows.at(-1)?.data as { text?: string } | undefined)?.text;
    };
    const noteErasedSince = (memory: string, note: string): boolean =>
      (journal()?.find({ type: NoteErased.name, field: "note", equals: note }) ?? []).some((stored) => (stored.data as { memory?: unknown }).memory === memory);

    /**
     * What a correction says as it is shown. A correction about a note of hers keeps no words of the note: they are
     * read from memory's records now, and left out once the note was erased, so erasing it leaves no copy here.
     */
    const whatOf = (correction: Correction): string => {
      const note = correction.note;
      if (note === undefined || note.change === "erased" || noteErasedSince(note.memory, note.note)) return correction.what;
      const source = correction.source === undefined ? undefined : journal()?.get(recordId(correction.source));
      const data = source?.data as { text?: string; reason?: string } | undefined;
      const was = source === undefined ? undefined : noteBefore(note.memory, note.note, source.seq);
      if (note.change === "corrected") return data?.text === undefined || was === undefined ? correction.what : `${correction.what}: "${firstLine(was)}" became "${firstLine(data.text)}"`;
      return `${correction.what}${was === undefined ? "" : `: "${firstLine(was)}"`}${data?.reason === undefined ? "" : `, saying: ${firstLine(data.reason)}`}`;
    };

    api.on(NoteCorrected, { id: "note-corrected", filter: { "by.kind": "owner" } }, async (data, step, stored) => {
      if (!herNote(data.memory, data.note)) return;
      await actedOut(step, stored, "memory", "The owner changed a note of yours", { memory: data.memory, note: data.note, change: "corrected" });
    });
    api.on(NoteRetracted, { id: "note-retracted", filter: { "by.kind": "owner" } }, async (data, step, stored) => {
      if (!herNote(data.memory, data.note)) return;
      await actedOut(step, stored, "memory", "The owner took back a note of yours", { memory: data.memory, note: data.note, change: "retracted" });
    });
    api.on(NoteErased, { id: "note-erased", filter: { "by.kind": "owner" } }, async (data, step, stored) => {
      if (!herNote(data.memory, data.note)) return;
      await actedOut(step, stored, "memory", "The owner erased a note of yours: what it held should not have been kept", { memory: data.memory, note: data.note, change: "erased" });
    });

    api.on(CommitmentCancelled, { id: "commitment-cancelled", filter: { "by.kind": "owner" } }, async (data, step, stored) => {
      const made = journal()?.find({ type: CommitmentMade.name, field: "id", equals: data.id })[0];
      const by = (made?.data as { by?: Address; text?: string } | undefined)?.by;
      if (by?.kind !== "agent" || by.id !== RIN_AGENT) return;
      const text = (made?.data as { text?: string }).text ?? data.id;
      await actedOut(step, stored, "commitments", `The owner cancelled your promise "${firstLine(text)}"${data.reason === undefined ? "" : `: ${data.reason}`}`);
    });

    api.on(DecisionRevoked, { id: "decision-revoked", filter: { "by.kind": "owner" } }, async (data, step, stored) => {
      const made = journal()?.find({ type: DecisionMade.name, field: "id", equals: data.decision })[0];
      const decided = made?.data as { by?: Address; description?: string; area?: string } | undefined;
      if (decided?.by?.kind !== "agent" || decided.by.id !== RIN_AGENT) return;
      await actedOut(step, stored, "decisions", `The owner revoked your decision on "${firstLine(decided.description ?? data.decision)}" in ${decided.area ?? "its area"}${data.reason === undefined ? "" : `: ${data.reason}`}`);
    });

    /** What she asked the owner, when it was she who asked. */
    const herQuestion = (request: string): string | undefined => {
      const created = journal()?.find({ type: RequestCreated.name, field: "id", equals: request })[0];
      const data = created?.data as { from?: Address; to?: Address; input?: { title?: string } } | undefined;
      if (data?.to?.kind !== "owner" || data.from?.kind !== "agent" || data.from.id !== RIN_AGENT) return undefined;
      return data.input?.title ?? request;
    };
    // What the owner answered reaches her as a fact that names the request: she asked, and learns the answer
    // without polling. An answer that was not his (a resolver's) is told as such.
    api.on(RequestAnswered, { id: "question-answered" }, async (data, step) => {
      const title = herQuestion(data.id);
      if (title === undefined) return;
      const answer = "ids" in data.answer ? `chose ${data.answer.ids.join(", ")}` : "text" in data.answer ? `said: ${data.answer.text}` : "form" in data.answer ? `filled in: ${JSON.stringify(data.answer.form)}` : "withdrew the question";
      const who = data.by?.kind === "owner" ? "The owner" : `Not the owner but a resolver${data.how === undefined ? "" : ` (${data.how})`}`;
      await step(agentNotify, { agent: RIN_AGENT, text: `Request ${data.id}, your question "${firstLine(title)}": ${who} ${answer}.` });
    });
    api.on(RequestCancelledRecord, { id: "question-turned-down", filter: { "by.kind": "owner" } }, async (data, step, stored) => {
      const title = herQuestion(data.id);
      if (title === undefined) return;
      await actedOut(step, stored, "questions", `The owner turned down your question "${firstLine(title)}"${data.reason === undefined ? "" : `: ${data.reason}`}`);
    });
    api.on(RequestExpiredRecord, { id: "question-unanswered" }, async (data, step, stored) => {
      const title = herQuestion(data.id);
      if (title === undefined) return;
      await actedOut(step, stored, "questions", `The owner left your question "${firstLine(title)}" unanswered until it expired`);
    });

    // ---- the charter ----------------------------------------------------------------------------------------

    // Corrections about one thing that repeat make a rule due; the record, not this handler, tells her.
    api.on(Corrected, { id: "consolidate", concurrency: { by: (data) => data.about } }, async (data, step) => {
      const due = dueFor(charter(), data.about, ruleAfter);
      if (due === undefined) return;
      try {
        await step.emit(CharterDue, { about: data.about, corrections: due, ...(charterMode === "auto" ? { mode: charterMode } : {}) });
      } catch (error) {
        if (!(error instanceof RecordRefused) || error.code !== "corrections-changed") throw error;
      }
    });

    // She is asked for a rule from the record of what is due, so that a restart between the two does not lose the ask.
    api.on(CharterDue, { id: "rule-due" }, async (data, step) => {
      const lines = charter().corrections.filter((one) => data.corrections.includes(one.correction)).map((one) => `- ${one.correction}: ${one.what}${one.note === undefined ? "" : " (what he changed is in rin.charter)"}`);
      await step(agentNotify, {
        agent: RIN_AGENT,
        text: [
          `The owner's corrections about ${data.about} repeat:`,
          ...lines,
          "",
          data.mode === "auto"
            ? "If these separate reactions support a communication preference, use rin.charter.learn with basis pattern and the correction IDs. For an owner-confirmed rule, use rin.charter.propose. Leave the charter alone if the corrections support neither."
            : "If one rule covers them, word it in one sentence and propose it with rin.charter.propose, naming these corrections. If none does, leave it.",
        ].join("\n"),
      });
    });

    api.action(
      action(rinCharterPropose, {
        recovery: "repeat",
        effect: "record",
        world: "niwa",
        run: async (input, ctx) => {
          const who = whoIs(ctx.caller);
          if (who === "other") throw new RinRefusal("not-owner", "only Rin or the owner proposes a rule of her charter");
          const rule = idOf("rule", String(ctx.operationId));
          const proposal = { rule, about: input.about, text: input.text, corrections: input.corrections, by: who === "owner" ? owner : agentAddress(RIN_AGENT) };
          if (who === "owner") {
            await ctx.emitAll([
              { type: CharterProposed, data: proposal },
              { type: CharterRuled, data: { rule, about: input.about, by: owner } },
            ]);
            return { rule, status: "ruled" as const };
          }
          await ctx.emit(CharterProposed, proposal);
          return { rule, status: "proposed" as const };
        },
      }),
    );

    api.action(action(rinCharterLearn, {
      recovery: "repeat",
      effect: "record",
      world: "niwa",
      run: async (input, ctx) => {
        if (whoIs(ctx.caller) !== "rin") throw new RinRefusal("not-rin", "only Rin learns communication preferences");
        const rule = idOf("rule", String(ctx.operationId));
        if (journal()?.find({ type: CharterLearned.name, field: "rule", equals: rule })[0] !== undefined) {
          return { rule, status: "learned" as const };
        }
        if (charterMode !== "auto") throw new RinRefusal("charter-ask", "learning communication preferences requires auto charter mode");

        const evidence = new Map<string, { correction: string; record: string; source: string }>();
        for (const id of new Set(input.corrections)) {
          const row = journal()?.find({ type: Corrected.name, field: "correction", equals: id })[0];
          const correction = row === undefined ? undefined : Corrected.schema.parse(row.data);
          if (row === undefined || correction?.about !== input.about) {
            throw new RinRefusal("charter-evidence", `Correction ${id} does not support topic ${input.about}`);
          }
          let proof = correction.source === undefined ? undefined : ownerWords(correction.source);
          if (proof === undefined && correction.by.kind === "owner") proof = { key: String(row.id), record: String(row.id) };
          if (proof === undefined && correction.by.kind === "niwa" && input.basis === "pattern" && correction.source !== undefined) {
            const fact = byRecordId(correction.source);
            if (fact !== undefined) proof = { key: String(fact.id), record: String(fact.id) };
          }
          if (proof === undefined) throw new RinRefusal("charter-evidence", `Correction ${id} needs a record of the owner's feedback`);
          if (!evidence.has(proof.key)) evidence.set(proof.key, { correction: id, record: proof.record, source: proof.key });
        }
        const needed = input.basis === "explicit" ? 1 : Math.max(2, ruleAfter);
        if (evidence.size < needed) throw new RinRefusal("charter-evidence", `Learning requires ${needed} distinct records of owner feedback`);

        const existingPreference = () => learnedRules(charter()).find((one) => one.about === input.about && one.learning?.preference === input.preference);
        const existing = existingPreference();
        if (existing !== undefined) return { rule: existing.rule, status: "learned" as const };
        try {
          await ctx.emit(CharterLearned, {
            rule, about: input.about, preference: input.preference, basis: input.basis, evidence: [...evidence.values()], by: { kind: "agent", id: RIN_AGENT },
          });
        } catch (error) {
          if (!(error instanceof RecordRefused) || error.code !== "learned-exists") throw error;
          const winner = existingPreference();
          if (winner === undefined) throw error;
          return { rule: winner.rule, status: "learned" as const };
        }
        return { rule, status: "learned" as const };
      },
    }));

    // A rule she proposed is put to the owner, and only his yes makes it part of the charter. She is told either way.
    api.on(CharterProposed, { id: "confirm-rule", filter: { "by.kind": "agent" }, concurrency: Number.POSITIVE_INFINITY }, async (data, step) => {
      const verdict = await askOwner(step, ruleQuestion(data.text, data.about), "ask");
      try {
        if (verdict === "confirmed") await step.emit(CharterRuled, { rule: data.rule, about: data.about, by: owner }, { key: "ruled" });
        else await step.emit(CharterDeclined, { rule: data.rule, about: data.about, why: verdict }, { key: "declined" });
      } catch (error) {
        if (error instanceof RecordRefused && error.code === "rule-closed") return;
        throw error;
      }
      const told: Record<Verdict, string> = {
        confirmed: `The owner confirmed a rule of your charter, ${data.rule}: ${data.text}`,
        declined: `The owner declined the rule you proposed: ${data.text}`,
        cancelled: `The rule you proposed was not confirmed (the question was cancelled): ${data.text}`,
        expired: `The rule you proposed was not confirmed (the question was left to expire): ${data.text}`,
      };
      await step(agentNotify, { agent: RIN_AGENT, text: told[verdict] }, { key: "told" });
    });

    // ---- changing herself -----------------------------------------------------------------------------------

    api.action(
      action(rinSelfInstall, {
        // The edit is cut from the operation: a repeat finds the proposal the first call wrote.
        recovery: "repeat",
        effect: "record",
        world: "niwa",
        run: async (input, ctx) => {
          if (whoIs(ctx.caller) !== "rin") throw new RinRefusal("not-rin", "only Rin proposes to change herself");
          if (selfEdit === "off") throw new RinRefusal("self-edit-off", "changing herself by code is turned off");
          if (!input.plugin.startsWith("rin/")) throw new RinRefusal("not-her-group", `a plugin of hers has a name that begins with rin/, not "${input.plugin}"`);
          if (!isAbsolute(input.module)) throw new RinRefusal("unknown", "give the module as an absolute path");
          const edit = idOf("edit", String(ctx.operationId));
          const existing = journal()?.find({ type: SelfEditProposed.name, field: "edit", equals: edit })[0];
          if (existing !== undefined) return { edit, hash: SelfEditProposed.schema.parse(existing.data).hash };
          const bytes = await readFile(input.module).catch(() => undefined);
          if (bytes === undefined) throw new RinRefusal("unknown", `cannot read the module ${input.module}`);
          const hash = createHash("sha256").update(bytes).digest("hex");
          await ctx.emit(SelfEditProposed, { edit, plugin: input.plugin, module: input.module, hash, why: input.why, mode: selfEdit });
          return { edit, hash };
        },
      }),
    );

    api.on(SelfEditProposed, { id: "confirm-self-edit", concurrency: { by: (data) => data.plugin } }, async (data, step, proposal) => {
      const { edit, plugin: name, module, hash } = data;
      const log = journal();
      if (log === undefined) throw new Error("Self-edit recovery needs the host journal");
      const ownRecord = (row: StoredRecord) => row.cause === proposal.id && row.actor.kind === "handler" && row.actor.handler === "rin/confirm-self-edit";
      const previous = log.find({ type: SelfEditSettled.name, field: "edit", equals: edit }).find(ownRecord);
      if (previous !== undefined) {
        const saved = SelfEditSettled.schema.parse(previous.data);
        return tellEdit(step, { name, hash, ...saved });
      }
      const claim = log.find({ type: SelfEditClaimed.name, field: "edit", equals: edit }).find(ownRecord);
      let installed = claim?.actor.kind === "handler" ? recordedInstall(log, claim.actor, { plugin: name, module, hash }) : undefined;
      const settle = async (outcome: Exclude<Verdict, "confirmed"> | "installed" | "failed" | "unknown", detail?: string) => {
        await step.emit(SelfEditSettled, { edit, plugin: name, outcome, ...(detail === undefined ? {} : { detail }) }, { key: "settled" });
        await tellEdit(step, { name, hash, outcome, detail });
      };
      if (installed === undefined) {
        if (selfEdit === "off") return settle("cancelled", "Self-editing is disabled on this host");
        if (data.mode === "ask" || selfEdit === "ask") {
          const title = `Rin asks to install ${name} from ${module} (sha256 ${hash}): ${data.why}`;
          const verdict = await askOwner(step, confirmQuestion("rin.self-edit.confirm", title), "ask");
          if (verdict !== "confirmed") return settle(verdict);
        }
        await step.emit(SelfEditClaimed, { edit, plugin: name, hash }, { key: "claim" });
        installed = await step.outcome(pluginInstall, { plugin: name, module, hash }, { key: "install" });
      }
      switch (installed.status) {
        case "completed": return settle("installed");
        case "failed": return settle(installed.effectPossible ? "unknown" : "failed", installed.error);
        case "denied":
        case "cancelled": return settle("failed", installed.reason);
        case "unknown": return settle("unknown", "The outcome is not known");
      }
    });

    async function tellEdit(step: Step, edit: { name: string; hash: string; outcome: string; detail?: string | undefined }) {
      await step(agentNotify, {
        agent: RIN_AGENT,
        text: `Installation of ${edit.name} (${edit.hash}): ${edit.outcome}${edit.detail === undefined ? "." : `. ${firstLine(edit.detail)}`}`,
      }, { key: "told" });
    }

    api.action(action(rinSelfHistory, {
      recovery: "repeat",
      effect: "read",
      world: "niwa",
      run: async (_input, ctx) => {
        if (whoIs(ctx.caller) !== "owner") throw new RinRefusal("not-owner", "Only the owner can read the self-edit history");
        const rows = journal()?.since(seq(0), [
          SelfEditProposed.name, SelfEditClaimed.name, SelfEditSettled.name, CORE_TYPES.pluginInstalled, CORE_TYPES.pluginUninstalled,
        ]) ?? [];
        type Result = ReturnType<typeof rinSelfHistory.output.parse>;
        const edits = new Map<string, Result["edits"][number]>();
        const installed = new Map<string, Result["installed"][number]>();
        const proposed = new Set<string>();
        for (const row of rows) {
          if (row.type === SelfEditProposed.name) {
            const data = SelfEditProposed.schema.parse(row.data);
            edits.set(data.edit, { ...data, at: row.at, status: "pending" });
            proposed.add(`${data.plugin}:${data.hash}`);
          } else if (row.type === SelfEditClaimed.name) {
            const edit = edits.get(SelfEditClaimed.schema.parse(row.data).edit);
            if (edit !== undefined) edit.status = "installing";
          } else if (row.type === SelfEditSettled.name) {
            const data = SelfEditSettled.schema.parse(row.data);
            const edit = edits.get(data.edit);
            if (edit !== undefined) {
              edit.status = data.outcome;
              if (data.detail !== undefined) edit.detail = data.detail;
            }
          } else if (row.type === CORE_TYPES.pluginInstalled) {
            const data = pluginInstall.output.parse(row.data);
            if (proposed.has(`${data.plugin}:${data.hash}`)) installed.set(data.plugin, data);
            else installed.delete(data.plugin);
          } else {
            const data = row.data as { plugin: string };
            installed.delete(data.plugin);
          }
        }
        return { mode: selfEdit, edits: [...edits.values()].reverse(), installed: [...installed.values()] };
      },
    }));

    api.action(
      action(rinCharterRetire, {
        recovery: "repeat",
        effect: "record",
        world: "niwa",
        run: async (input, ctx) => {
          if (whoIs(ctx.caller) !== "owner") throw new RinRefusal("not-owner", "only the owner takes a rule out of Rin's charter");
          const rule = charter().rules.get(input.rule);
          if (rule === undefined) throw new RinRefusal("unknown", `"${input.rule}" is not a rule of the charter`);
          await ctx.emit(CharterRetired, { rule: input.rule, about: rule.about, ...(input.reason === undefined ? {} : { reason: input.reason }) });
          return { rule: input.rule };
        },
      }),
    );

    api.summarize(() => {
      const state = attention();
      return { held: heldItems(state).length, occasions: state.open.size, rules: ruledRules(charter()).length };
    });

    /** How often the occasion of an item came up, as a few words after it. */
    function countText(state: AttentionState, item: Item): string {
      const count = item.subject.kind === "occasion" ? state.occasions.get(item.subject.occasion)?.count : undefined;
      return count !== undefined && count > 1 ? ` (came up ${count} times)` : "";
    }
  });
}
