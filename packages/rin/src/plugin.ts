/**
 * The Rin plugin: her definition, her attention, the corrections she learns from and her charter, on a host.
 *
 * Rin is an agent of the agents module (`agent:rin`); this plugin offers her definition and adds what makes her
 * Rin. Something that happened reaches her as an occasion (`rin.notice`, and the occasions she follows herself:
 * a stuck agent, a run she started that finished); she decides in her main session what to do about it
 * (`rin.attend`), and the plugin carries the decision out: it holds what waits for the owner's next contact or
 * for the end of his quiet hours, tells him now through the action of the composition (`telegram.send` by
 * default), and brings up what waits when he writes to her or attaches a session.
 *
 * His corrections are written down (`rin.corrected`), whether he says them, she writes them from his words, or he
 * acts them out: changes a note of hers, cancels what she promised or decided, turns down or leaves unanswered
 * what she asked, waves away what she told him. Corrections about one thing that repeat ask her for a rule; the
 * rule she words is put to him, and only his yes makes it part of her charter.
 *
 * What she does reaches nobody with the rights of whoever told her something: the plugin's handlers carry her
 * decisions out, and her own actions check that it is she, or the owner, who calls them.
 */

import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { isAbsolute } from "node:path";
import { fileURLToPath } from "node:url";

import { OptionIdSchema, action, actionName, agent as agentAddress, owner, recordId, seq } from "@niwa-labs/core";
import type { Address, Caller, JournalReader, RecordType, Step, StoredRecord } from "@niwa-labs/core";
import { AGENT, COCKPIT_MODULE, plugin, trigger } from "@niwa-labs/plugin";
import type { CallerBinding, Plugin, PluginApi } from "@niwa-labs/plugin";
import { AGENT_BRIEFING, AGENT_PROMPT_SECTION, AgentAttached, AgentTurnDelivered, AgentTurnFailed, AgentTurnQueued, agentNotify } from "@niwa-labs/agent/records";
import type { TurnAuthor } from "@niwa-labs/agent/records";
import { CommitmentCancelled, CommitmentMade } from "@niwa-labs/commitments/records";
import { DecisionMade, DecisionRevoked } from "@niwa-labs/delegate/records";
import { NoteCorrected, NoteErased, NoteRetracted, NoteWritten } from "@niwa-labs/memory/records";
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
import { DEFAULT_RULE_AFTER, charterText, correctionView, dueFor, foldCharter, ruleView, ruledRules } from "./charter.ts";
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
  CharterProposed,
  CharterRetired,
  CharterRuled,
  Corrected,
  OccasionEnded,
  OccasionOpened,
  OccasionRepeated,
  RIN_TYPES,
  SelfEditProposed,
  SelfEditSettled,
  pluginInstall,
  rinAttend,
  rinAttention,
  rinBriefing,
  rinCharter,
  rinCharterPropose,
  rinCharterRetire,
  rinContext,
  rinConversation,
  rinCorrect,
  rinDismiss,
  rinInbox,
  rinNotice,
  rinPromptCharter,
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
  /** Whether she may change herself by writing a plugin of her group and installing it; the owner is asked every time. */
  readonly selfEdit?: boolean;
  /** The core of her character; the one of this package unless the owner gives his own. */
  readonly core?: Core;
  /** The owner's quiet hours, local time. Default 23:00 to 08:00. */
  readonly quietHours?: QuietHours;
  /** The safety ceiling on what she says now. Default: twelve in any 24 hours. */
  readonly ceiling?: Ceiling;
  /** The action that tells the owner something now, given `{ text }`. Default: `telegram.send`. */
  readonly say?: string;
  /** How many corrections about one thing, not covered by a rule, ask her for one. Default: two. */
  readonly ruleAfter?: number;
}

/** A refusal of Rin's: a caller that is neither she nor the owner, or a decision that does not hold. */
export class RinRefusal extends Error {
  override name = "RinRefusal";
  constructor(
    readonly code: "not-rin" | "not-owner" | "unknown" | "no-text" | "already-said" | "insist" | "open-proposal" | "not-his-words" | "self-edit-off" | "not-her-group" | "unreachable",
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
const CHARTER_TYPES = [Corrected, CharterDue, CharterProposed, CharterRuled, CharterDeclined, CharterRetired].map((type) => type.name as string);

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

/** How a question that only the owner's yes settles ended. `not-his`: something else than he answered it. */
type Verdict = "confirmed" | "declined" | "cancelled" | "expired" | "not-his";

/** A message the owner wrote to Rin: a contact, and his own words. */
const ToRin = { "to.kind": "agent", "to.id": RIN_AGENT, "from.kind": "owner" } as const;
const OwnerWroteToRin = trigger(MessageSent, { name: "message.sent:owner-to-rin", filter: ToRin });
const OwnerWroteInToRin = trigger(MessageReceived, { name: "message.received:owner-to-rin", filter: ToRin });

/** The Rin plugin. Install it after the agents module, which serves her, and with the plugins whose records she follows. */
export function rinPlugin(options: RinOptions): Plugin {
  const definition = rinDefinition({
    ...(options.harness === undefined ? {} : { harness: options.harness }),
    ...(options.role === undefined ? {} : { role: options.role }),
    ...(options.selfEdit === undefined ? {} : { selfEdit: options.selfEdit }),
    ...(options.core === undefined ? {} : { core: options.core }),
  });
  const quiet = options.quietHours ?? DEFAULT_QUIET;
  const ceiling = options.ceiling ?? DEFAULT_CEILING;
  const say = actionName(options.say ?? "telegram.send");
  const ruleAfter = options.ruleAfter ?? DEFAULT_RULE_AFTER;
  const bind = options.bind;
  const quietEnd = timer.daily(quiet.to, { id: "rin-quiet-end", description: "The end of the owner's quiet hours" });

  return plugin("rin", (api: PluginApi) => {
    api.declare(...RIN_TYPES);
    api.offer(AGENT, definition);
    api.offer(AGENT_BRIEFING, { title: "What Rin holds for you", action: rinBriefing.name });
    // Her charter is part of the prompt of her sessions, read when each one starts: a rule confirmed since reaches the next.
    api.offer(AGENT_PROMPT_SECTION, { id: "charter", agent: RIN_AGENT, action: rinPromptCharter.name });
    // Her page in the cockpit: a client module, offered by the path of its source.
    api.offer(COCKPIT_MODULE, { id: "rin", entry: fileURLToPath(new URL("./cockpit/index.tsx", import.meta.url)) });

    const journal = (): JournalReader | undefined => api.journal?.();
    const rowsOf = (types: readonly string[]): Row[] =>
      (journal()?.since(seq(0), types as never) ?? []).map((stored) => ({ type: stored.type, data: stored.data, at: stored.at, seq: stored.seq }));
    const attention = (): AttentionState => foldAttention(rowsOf([...ATTENTION_TYPES, ATTACHED]), RIN_AGENT);
    const charter = (): CharterState => foldCharter(rowsOf(CHARTER_TYPES));
    const ruledIds = () => new Set<string>(ruledRules(charter()).map((rule) => rule.rule));

    /**
     * Put a question to the owner and wait. A yes counts only when the owner gave it: a resolver may answer a
     * request before it reaches him, and what a resolver recalls is not his word on a rule or on code.
     */
    const askOwner = async (step: Step, asking: ReturnType<typeof confirmQuestion>, key: string): Promise<Verdict> => {
      try {
        const { id, answer } = answeredBy(await step(requestAsk, { to: owner, ...asking }, { key }));
        const answers = journal()?.find({ type: RequestAnswered.name, field: "id", equals: id }) ?? [];
        if (!answers.some((stored) => (stored.data as { by?: { kind?: unknown } }).by?.kind === "owner")) return "not-his";
        return "ids" in answer && answer.ids[0] === CONFIRM ? "confirmed" : "declined";
      } catch (error) {
        if (error instanceof RequestCancelled) return "cancelled";
        if (error instanceof RequestExpired) return "expired";
        throw error;
      }
    };

    /** Does the host serve the action that tells the owner something now? */
    const sayServed = (): boolean => api.effectOf(String(say)) !== undefined;
    const sayMissing = (): string => `plugin "rin" tells the owner something now with the action "${String(say)}", which nothing on this host serves: install the plugin that serves it, or name another action in \`say\``;

    // The clock of the host, once it serves: what a read that has no record of its own tells the time by.
    let clock: (() => number) | undefined;
    api.service((ctx) => {
      // A plugin cannot make the host refuse to serve for an action it lacks, so say so at start; a decision to tell
      // him now is refused while nothing serves the action (`unreachable`).
      if (!sayServed()) console.error(`niwa: ${sayMissing()}`);
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
      const rules = charterText(ruledRules(charter()));
      lines.push(rules === "" ? "Your charter has no rules yet." : `Your charter:\n${rules}`);
      return lines.join("\n");
    };

    // What reads her attention and writes on it runs one at a time: two notices of one key that arrive at once are
    // one occasion and a repeat, and two decisions to say one thing now are one said and one refused. The host is the
    // journal's one writer, so this process is the only place they can meet.
    let tail: Promise<unknown> = Promise.resolve();
    const serially = <T>(work: () => Promise<T>): Promise<T> => {
      const run = tail.then(work, work);
      tail = run.catch(() => undefined);
      return run;
    };

    // ---- occasions -----------------------------------------------------------------------------------------

    /** Write a notice: open an occasion, count a repeat, or end one and drop what waits about it. */
    const notice = (
      emit: <T>(type: RecordType<T>, data: T) => Promise<StoredRecord>,
      input: { key: string; kind: string; text: string; ends?: boolean },
      from: TurnAuthor,
      seed: string,
    ): Promise<{ occasion?: OccasionId; status: "opened" | "repeated" | "ended" | "none" }> =>
      serially(async () => {
        const state = attention();
        const found = noticeOf(state, input);
        switch (found.kind) {
          case "open": {
            const occasion = idOf("occ", seed);
            await emit(OccasionOpened, { occasion, key: input.key, kind: input.kind, text: input.text, from });
            return { occasion, status: "opened" };
          }
          case "repeat":
            await emit(OccasionRepeated, { occasion: found.occasion, text: input.text, from });
            return { occasion: found.occasion, status: "repeated" };
          case "end":
            // The end record alone drops what waited about the occasion: nothing is left to finish after a restart.
            await emit(OccasionEnded, { occasion: found.occasion, text: input.text, from });
            return { occasion: found.occasion, status: "ended" };
          case "none":
            return { status: "none" };
        }
      });

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
    api.on(OccasionOpened, async (data, step, stored) => {
      const text = [
        `Something happened (occasion ${data.occasion}, ${data.kind}): ${data.text}`,
        "",
        contextText(stored.at),
        "",
        `Decide with rin.attend on { kind: "occasion", occasion: "${data.occasion}" }.`,
      ].join("\n");
      await step(agentNotify, { agent: RIN_AGENT, text });
    });

    // An agent she leads that cannot be reached is an occasion; it ends when a turn reaches it again.
    api.on(AgentTurnFailed, { id: "stuck-agent" }, async (data, step, stored) => {
      if (data.agent === RIN_AGENT) return;
      const text = `A turn did not reach agent ${data.agent} (${data.status}): ${firstLine(data.reason)}`;
      await notice((type, value) => step.emit(type, value), { key: `agent:${data.agent}:unreachable`, kind: "agent", text }, { kind: "niwa", by: "agents" }, String(stored.id));
    });
    api.on(AgentTurnDelivered, { id: "agent-reachable" }, async (data, step, stored) => {
      if (data.agent === RIN_AGENT || attention().open.get(`agent:${data.agent}:unreachable`) === undefined) return;
      const text = `A turn reached agent ${data.agent} again.`;
      await notice((type, value) => step.emit(type, value), { key: `agent:${data.agent}:unreachable`, kind: "agent", text, ends: true }, { kind: "niwa", by: "agents" }, String(stored.id));
    });

    // A workflow run she started that finished is an occasion: she learns its outcome without asking. Who started it
    // is who asked for it (the record of the request); the run's own start is written by the workflow module.
    api.on(RunFinished, { id: "run-finished", requires: [RunFinished] }, async (data, step, stored) => {
      const requested = journal()?.find({ type: RunRequested.name, field: "run", equals: data.run })[0];
      if (requested === undefined || whoIs(requested.actor) !== "rin") return;
      const asked = RunRequested.schema.parse(requested.data);
      const label = asked.label ?? asked.file;
      const how = data.outcome.status === "failed" ? `failed: ${firstLine(data.outcome.error.message)}` : data.outcome.status;
      const text = `The workflow run ${data.run}${label === "" ? "" : ` (${label})`} you started ended: ${how}.`;
      await notice((type, value) => step.emit(type, value), { key: `run:${data.run}`, kind: "workflow", text }, { kind: "niwa", by: "workflow" }, String(stored.id));
    });

    // ---- her decisions --------------------------------------------------------------------------------------

    /** Is the subject one she can decide about: an occasion of hers that still holds, or a turn of her inbox? */
    const known = (subject: Subject, state: AttentionState): boolean => {
      if (subject.kind === "occasion") {
        const occasion = state.occasions.get(subject.occasion);
        return occasion !== undefined && state.open.get(occasion.key) === occasion.occasion;
      }
      return (journal()?.since(seq(0), [AgentTurnQueued.name]) ?? []).some((stored) => {
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
            if ((input.decision === "now" || input.decision === "insist") && !sayServed()) throw new RinRefusal("unreachable", `${sayMissing()}; hold it for his next contact instead`);
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
          const route = sayNow({ at: stored.at, quiet, ceiling, said });
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
        run: async (input) => {
          const delivery = (turn: string): Delivery => {
            const at = (type: RecordType<unknown>) => journal()?.find({ type: type.name, field: "turn", equals: turn }).filter((stored) => (stored.data as { agent?: unknown }).agent === RIN_AGENT) ?? [];
            if (at(AgentTurnDelivered).length > 0) return "delivered";
            const failed = at(AgentTurnFailed).at(-1)?.data as { status?: Delivery } | undefined;
            return failed?.status ?? "waiting";
          };
          const messages = (journal()?.since(seq(0), [MessageSent.name]) ?? []).flatMap((stored): Array<{ id: string; from: "owner" | "rin"; text: string; at: number; delivery?: Delivery }> => {
            const parsed = MessageEnvelope.safeParse(stored.data);
            if (!parsed.success) return [];
            const { from, to } = parsed.data;
            if (from.kind === "owner" && to.kind === "agent" && to.id === RIN_AGENT) {
              return [{ id: parsed.data.id, from: "owner" as const, text: contentText(parsed.data), at: stored.at, delivery: delivery(parsed.data.id) }];
            }
            if (from.kind === "agent" && from.id === RIN_AGENT && to.kind === "owner") return [{ id: parsed.data.id, from: "rin" as const, text: contentText(parsed.data), at: stored.at }];
            return [];
          });
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
            charter: [...charter().rules.values()].filter((rule) => rule.status === "ruled" || rule.status === "proposed").map(ruleView),
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
          const rules = charterText(ruledRules(charter()));
          return { text: rules === "" ? "Your charter has no rules yet." : `Your charter, the rules the owner confirmed:\n${rules}` };
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

    /** Are these the owner's own words: a message he wrote, or a turn he wrote that holds a message? */
    const wordsOf = (stored: StoredRecord): boolean => {
      if (stored.type === MessageSent.name || stored.type === MessageReceived.name) {
        const message = MessageEnvelope.safeParse(stored.data);
        return message.success && message.data.from.kind === "owner" && message.data.body.text.trim() !== "";
      }
      if (stored.type === AgentTurnQueued.name) {
        const turn = AgentTurnQueued.schema.safeParse(stored.data);
        return turn.success && turn.data.kind === "message" && turn.data.author.kind === "owner" && turn.data.text.trim() !== "";
      }
      return false;
    };
    /**
     * Does this id name a record that holds words the owner wrote: a record of the journal by its id (an emitted
     * record's id has slashes in it), or a message by its own id (`msg-…`)? A record he merely wrote, an answer or a
     * correction, holds no words of his to rest a correction on.
     */
    const isHisWords = (id: string): boolean => {
      let byRecord: StoredRecord | undefined;
      try {
        byRecord = journal()?.get(recordId(id));
      } catch {
        byRecord = undefined; // not the shape of a record id
      }
      const byMessage = (journal()?.since(seq(0), [MessageSent.name, MessageReceived.name]) ?? []).filter((stored) => (stored.data as { id?: unknown }).id === id);
      return [...(byRecord === undefined ? [] : [byRecord]), ...byMessage].some(wordsOf);
    };

    api.action(
      action(rinCorrect, {
        recovery: "repeat",
        effect: "record",
        world: "niwa",
        run: async (input, ctx) => {
          const who = whoIs(ctx.caller);
          if (who === "other") throw new RinRefusal("not-owner", "a correction is the owner's: only he, or Rin from his words, writes one");
          if (who === "rin" && (input.source === undefined || !isHisWords(input.source))) {
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
      const made = (journal()?.since(seq(0), [CommitmentMade.name]) ?? []).find((one) => (one.data as { id?: unknown }).id === data.id);
      const by = (made?.data as { by?: Address; text?: string } | undefined)?.by;
      if (by?.kind !== "agent" || by.id !== RIN_AGENT) return;
      const text = (made?.data as { text?: string }).text ?? data.id;
      await actedOut(step, stored, "commitments", `The owner cancelled your promise "${firstLine(text)}"${data.reason === undefined ? "" : `: ${data.reason}`}`);
    });

    api.on(DecisionRevoked, { id: "decision-revoked", filter: { "by.kind": "owner" } }, async (data, step, stored) => {
      const made = (journal()?.since(seq(0), [DecisionMade.name]) ?? []).find((one) => (one.data as { id?: unknown }).id === data.decision);
      const decided = made?.data as { by?: Address; description?: string; area?: string } | undefined;
      if (decided?.by?.kind !== "agent" || decided.by.id !== RIN_AGENT) return;
      await actedOut(step, stored, "decisions", `The owner revoked your decision on "${firstLine(decided.description ?? data.decision)}" in ${decided.area ?? "its area"}${data.reason === undefined ? "" : `: ${data.reason}`}`);
    });

    /** What she asked the owner, when it was she who asked. */
    const herQuestion = (request: string): string | undefined => {
      const created = (journal()?.since(seq(0), [RequestCreated.name]) ?? []).find((one) => (one.data as { id?: unknown }).id === request);
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
    api.on(Corrected, { id: "consolidate" }, async (data, step) => {
      const due = dueFor(charter(), data.about, ruleAfter);
      if (due === undefined) return;
      await step.emit(CharterDue, { about: data.about, corrections: due });
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
          "If one rule covers them, word it in one sentence and propose it with rin.charter.propose, naming these corrections. If none does, leave it.",
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
          const state = charter();
          const known = new Set(state.corrections.map((one) => one.correction));
          const unknown = input.corrections.filter((id) => !known.has(id));
          if (unknown.length > 0) throw new RinRefusal("unknown", `there is no correction ${unknown.join(", ")}`);
          if (who === "rin" && [...state.rules.values()].some((rule) => rule.about === input.about && rule.status === "proposed")) {
            throw new RinRefusal("open-proposal", `a rule about ${input.about} already waits for the owner's word`);
          }
          const rule = idOf("rule", String(ctx.operationId));
          await ctx.emit(CharterProposed, { rule, about: input.about, text: input.text, corrections: input.corrections, by: who === "owner" ? owner : agentAddress(RIN_AGENT) });
          if (who === "owner") {
            await ctx.emit(CharterRuled, { rule, by: owner });
            return { rule, status: "ruled" as const };
          }
          return { rule, status: "proposed" as const };
        },
      }),
    );

    // A rule she proposed is put to the owner, and only his yes makes it part of the charter. She is told either way.
    api.on(CharterProposed, { id: "confirm-rule", filter: { "by.kind": "agent" }, concurrency: Number.POSITIVE_INFINITY }, async (data, step) => {
      const verdict = await askOwner(step, ruleQuestion(data.text, data.about), "ask");
      if (verdict === "confirmed") await step.emit(CharterRuled, { rule: data.rule, by: owner }, { key: "ruled" });
      else await step.emit(CharterDeclined, { rule: data.rule, why: verdict }, { key: "declined" });
      const told: Record<Verdict, string> = {
        confirmed: `The owner confirmed a rule of your charter, ${data.rule}: ${data.text}`,
        declined: `The owner declined the rule you proposed: ${data.text}`,
        cancelled: `The rule you proposed was not confirmed (the question was cancelled): ${data.text}`,
        expired: `The rule you proposed was not confirmed (the question was left to expire): ${data.text}`,
        "not-his": `The rule you proposed was not answered by the owner, so it is not part of your charter: ${data.text}`,
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
          if (options.selfEdit !== true) throw new RinRefusal("self-edit-off", "changing herself by code is turned off");
          if (!input.plugin.startsWith("rin/")) throw new RinRefusal("not-her-group", `a plugin of hers has a name that begins with rin/, not "${input.plugin}"`);
          if (!isAbsolute(input.module)) throw new RinRefusal("unknown", "give the module as an absolute path");
          const bytes = await readFile(input.module).catch(() => undefined);
          if (bytes === undefined) throw new RinRefusal("unknown", `cannot read the module ${input.module}`);
          const hash = createHash("sha256").update(bytes).digest("hex");
          const edit = idOf("edit", String(ctx.operationId));
          await ctx.emit(SelfEditProposed, { edit, plugin: input.plugin, module: input.module, hash, why: input.why });
          return { edit, hash };
        },
      }),
    );

    // The owner is asked about the file as it was when she asked, and only that file is installed, only on his yes.
    api.on(SelfEditProposed, { id: "confirm-self-edit", concurrency: Number.POSITIVE_INFINITY }, async (data, step) => {
      const title = `Rin asks to install the plugin ${data.plugin} from ${data.module} (sha256 ${data.hash}): ${data.why}`;
      const verdict = await askOwner(step, confirmQuestion("rin.self-edit.confirm", title), "ask");
      let detail: string | undefined;
      let outcome: Exclude<Verdict, "confirmed"> | "installed" | "failed";
      if (verdict !== "confirmed") outcome = verdict;
      else {
        const installed = await step.outcome(pluginInstall, { plugin: data.plugin, module: data.module, hash: data.hash }, { key: "install" });
        outcome = installed.status === "completed" ? "installed" : "failed";
        if (installed.status === "failed") detail = installed.error;
        else if (installed.status === "denied" || installed.status === "cancelled") detail = installed.reason;
        else if (installed.status === "unknown") detail = "the outcome is not known";
      }
      await step.emit(SelfEditSettled, { edit: data.edit, outcome, ...(detail === undefined ? {} : { detail }) }, { key: "settled" });
      const told: Record<typeof outcome, string> = {
        installed: `The owner approved and the plugin ${data.plugin} is installed.`,
        failed: `The owner approved the plugin ${data.plugin}, but it was not installed (${firstLine(detail ?? "")}).`,
        declined: `The owner declined the plugin ${data.plugin}; nothing was installed.`,
        cancelled: `The question about the plugin ${data.plugin} was cancelled; nothing was installed.`,
        expired: `The question about the plugin ${data.plugin} was left to expire; nothing was installed.`,
        "not-his": `The question about the plugin ${data.plugin} was not answered by the owner; nothing was installed.`,
      };
      await step(agentNotify, { agent: RIN_AGENT, text: told[outcome] }, { key: "told" });
    });

    api.action(
      action(rinCharterRetire, {
        recovery: "repeat",
        effect: "record",
        world: "niwa",
        run: async (input, ctx) => {
          if (whoIs(ctx.caller) !== "owner") throw new RinRefusal("not-owner", "only the owner takes a rule out of Rin's charter");
          const rule = charter().rules.get(input.rule);
          if (rule === undefined || (rule.status !== "ruled" && rule.status !== "proposed")) throw new RinRefusal("unknown", `"${input.rule}" is not a rule of the charter`);
          await ctx.emit(CharterRetired, { rule: input.rule, ...(input.reason === undefined ? {} : { reason: input.reason }) });
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
