/**
 * Rin's charter, without a host: how the owner wants her to act, grown from his corrections.
 *
 * Every correction is written down (`rin.corrected`). When corrections about one thing repeat, she is asked whether
 * a rule should cover them; she words the rule and proposes it, and it becomes part of the charter only once the
 * owner confirms it. Consolidation finds the repetition; it never words a rule itself.
 */

import type { Row } from "./attention.ts";
import { CharterDeclined, CharterDue, CharterProposed, CharterRetired, CharterRuled, Corrected } from "./records.ts";
import type { CorrectionId, CorrectionItem, RuleId, RuleItem, Topic } from "./records.ts";

/** How many corrections about one thing, not yet covered, make a rule due. */
export const DEFAULT_RULE_AFTER = 2;

/** A correction, with the rule that covers it once one was proposed for it. */
export interface Correction extends CorrectionItem {
  readonly seq: number;
  readonly source?: string;
}

/** A rule, from its proposal. */
export interface Rule extends RuleItem {
  readonly at: number;
}

export interface CharterState {
  readonly corrections: Correction[];
  readonly rules: Map<RuleId, Rule>;
  /** The corrections she was already asked about, by what they are about. */
  readonly asked: Map<Topic, Set<CorrectionId>>;
}

/** Folds the corrections and the rules, in the order they were written. */
export function foldCharter(rows: readonly Row[]): CharterState {
  const state: CharterState = { corrections: [], rules: new Map(), asked: new Map() };
  const byId = new Map<CorrectionId, Correction>();
  for (const row of rows) {
    switch (row.type) {
      case Corrected.name: {
        const data = Corrected.schema.parse(row.data);
        const correction: Correction = {
          correction: data.correction,
          about: data.about,
          what: data.what,
          by: data.by,
          at: row.at,
          seq: row.seq,
          ...(data.source === undefined ? {} : { source: data.source }),
        };
        if (byId.has(correction.correction)) break;
        byId.set(correction.correction, correction);
        state.corrections.push(correction);
        break;
      }
      case CharterDue.name: {
        const data = CharterDue.schema.parse(row.data);
        const asked = state.asked.get(data.about) ?? new Set();
        for (const id of data.corrections) asked.add(id);
        state.asked.set(data.about, asked);
        break;
      }
      case CharterProposed.name: {
        const data = CharterProposed.schema.parse(row.data);
        state.rules.set(data.rule, { rule: data.rule, about: data.about, text: data.text, status: "proposed", corrections: data.corrections, at: row.at });
        for (const id of data.corrections) {
          const correction = byId.get(id);
          if (correction !== undefined && correction.rule === undefined) Object.assign(correction, { rule: data.rule });
        }
        break;
      }
      case CharterRuled.name:
        setStatus(state, CharterRuled.schema.parse(row.data).rule, "ruled", ["proposed"]);
        break;
      case CharterDeclined.name:
        setStatus(state, CharterDeclined.schema.parse(row.data).rule, "declined", ["proposed"]);
        break;
      case CharterRetired.name:
        setStatus(state, CharterRetired.schema.parse(row.data).rule, "retired", ["ruled", "proposed"]);
        break;
    }
  }
  return state;
}

function setStatus(state: CharterState, id: RuleId, status: Rule["status"], from: readonly Rule["status"][]): void {
  const rule = state.rules.get(id);
  if (rule !== undefined && from.includes(rule.status)) state.rules.set(id, { ...rule, status });
}

/**
 * The corrections about one thing that make a rule due: at least `threshold` of them that no rule covers and she
 * was not asked about yet, while no rule about it waits for the owner. Undefined when nothing is due.
 */
export function dueFor(state: CharterState, about: Topic, threshold: number): CorrectionId[] | undefined {
  if ([...state.rules.values()].some((rule) => rule.about === about && rule.status === "proposed")) return undefined;
  const asked = state.asked.get(about) ?? new Set<CorrectionId>();
  const open = state.corrections.filter((one) => one.about === about && one.rule === undefined && !asked.has(one.correction));
  return open.length >= threshold ? open.map((one) => one.correction) : undefined;
}

/** The rules of the charter: confirmed by the owner and not retired, in the order they were proposed. */
export function ruledRules(state: CharterState): Rule[] {
  return [...state.rules.values()].filter((rule) => rule.status === "ruled");
}

/** The rules as she reads them, one a line; empty when there is none. */
export function charterText(rules: readonly RuleItem[]): string {
  return rules.map((rule) => `- ${rule.rule} (${rule.about}): ${rule.text}`).join("\n");
}

/** A rule as it is read. */
export function ruleView(rule: Rule): RuleItem {
  return { rule: rule.rule, about: rule.about, text: rule.text, status: rule.status, corrections: rule.corrections };
}

/** A correction as it is read. */
export function correctionView(correction: Correction): CorrectionItem {
  return {
    correction: correction.correction,
    about: correction.about,
    what: correction.what,
    by: correction.by,
    at: correction.at,
    ...(correction.rule === undefined ? {} : { rule: correction.rule }),
  };
}
