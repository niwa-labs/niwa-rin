/**
 * Rin: an agent living inside niwa, between the owner's main assistant and a companion. Her character, her
 * judgement about what reaches the owner and when, and what his corrections teach her live here; memory,
 * commitments, delegation and the mechanics of an agent come from the packages she is composed of.
 */

export { RIN_NEEDS, addressingOf, rin } from "./composition.ts";
export type { RinCompositionOptions } from "./composition.ts";
export { RinRefusal, rinPlugin } from "./plugin.ts";
export type { RinOptions } from "./plugin.ts";
export { CORE, HANDS, RIN_AGENT, coreDigest, rinDefinition, workText } from "./character.ts";
export type { Core, RinDefinitionOptions } from "./character.ts";
export { DEFAULT_CEILING, DEFAULT_QUIET, inQuietHours, quietEnds } from "./attention.ts";
export type { Ceiling, QuietHours } from "./attention.ts";
export { DEFAULT_RULE_AFTER } from "./charter.ts";
export { CaseClosed, CaseTracked, rinCaseClose, rinCaseList, rinCaseTrack } from "./case-records.ts";
export type { CaseId, CaseSignal } from "./case-records.ts";
export * from "./records.ts";
