import type { RecordGuard } from "@niwa-labs/core";

export interface OccasionAdmission {
  readonly open: string | null;
  readonly notifications: ReadonlyMap<string, "claimed" | "notified">;
}

export const occasionGuard = <T extends { key: string }>(
  admit: RecordGuard<T, OccasionAdmission>["admit"],
  fold: RecordGuard<T, OccasionAdmission>["fold"],
): { guard: RecordGuard<T, OccasionAdmission> } => ({
  guard: {
    group: "occasion",
    key: (data) => data.key,
    initial: () => ({ open: null, notifications: new Map() }),
    admit,
    fold,
  },
});

interface CharterAdmission {
  readonly corrections: ReadonlyMap<string, "new" | "asked" | "covered">;
  readonly rules: ReadonlyMap<string, "proposed" | "ruled" | "declined" | "retired">;
}

export const charterGuard = <T extends { about: string }>(
  admit: RecordGuard<T, CharterAdmission>["admit"],
  fold: RecordGuard<T, CharterAdmission>["fold"],
): { guard: RecordGuard<T, CharterAdmission> } => ({
  guard: {
    group: "charter",
    key: (data) => data.about,
    initial: () => ({ corrections: new Map(), rules: new Map() }),
    admit,
    fold,
  },
});

export function ruleStatus(status: "ruled" | "declined" | "retired") {
  return charterGuard<{ about: string; rule: string }>(
    (state, data) => {
      const current = state.rules.get(data.rule);
      if (current === "proposed" || (current === "ruled" && status === "retired")) return;
      return { code: "rule-closed", reason: `Rule ${data.rule} can no longer be ${status}` };
    },
    (state, data) => ({ ...state, rules: new Map(state.rules).set(data.rule, status) }),
  );
}

export function correctionStatus(
  state: CharterAdmission,
  ids: readonly string[],
  status: "asked" | "covered",
): CharterAdmission {
  const corrections = new Map(state.corrections);
  for (const id of ids) corrections.set(id, status);
  return { ...state, corrections };
}

export const hasProposal = (state: CharterAdmission) => [...state.rules.values()].includes("proposed");

export const editGuard = <T extends { plugin: string; edit: string }>(
  admit: RecordGuard<T, string | null>["admit"],
  fold: RecordGuard<T, string | null>["fold"],
): { guard: RecordGuard<T, string | null> } => ({
  guard: {
    group: "self-edit",
    key: (data) => data.plugin,
    initial: () => null,
    admit,
    fold,
  },
});
