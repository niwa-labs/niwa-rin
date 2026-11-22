import { TurnAuthor, TurnId } from "@niwa-labs/agent/records";
import { actionRef, record } from "@niwa-labs/core";
import type { RecordGuard } from "@niwa-labs/core";
import { RequestId } from "@niwa-labs/requests/records";
import { z } from "zod";

export const CaseId = z.string().regex(/^case-[0-9a-f]{10}$/);
export type CaseId = z.output<typeof CaseId>;

const Signal = z.discriminatedUnion("kind", [
  z.strictObject({ kind: z.literal("request-answered"), request: RequestId }),
  z.strictObject({ kind: z.literal("agent-replied"), agent: z.string().min(1), turn: TurnId }),
]);
export type CaseSignal = z.output<typeof Signal>;

const CaseTrack = z.strictObject({
  subject: z.string().trim().min(1).max(240),
  expected: z.string().trim().min(1).max(500),
  due: z.number().int().nonnegative().max(8_640_000_000_000_000),
  signal: Signal.optional(),
});
const CaseKey = z.strictObject({ case: CaseId });
const Reason = z.string().trim().min(1).max(400);

function stateChange(needed: "new" | "open", next: "open" | "closed"): RecordGuard<{ case: CaseId }, "new" | "open" | "closed"> {
  return {
    group: "rin.case",
    key: (data) => data.case,
    initial: () => "new",
    admit: (state) => state === needed ? undefined : { code: "case-changed", reason: `The case is ${state}` },
    fold: () => next,
  };
}

export const CaseTracked = record("rin.case.tracked", CaseTrack.extend({ case: CaseId, by: TurnAuthor }), {
  providerOnly: "rin",
  guard: stateChange("new", "open"),
});
export const CaseClosed = record("rin.case.closed", CaseKey.extend({
  by: TurnAuthor,
  reason: Reason.optional(),
  signalRecord: z.string().min(1).optional(),
}), { providerOnly: "rin", guard: stateChange("open", "closed") });

export const rinCaseTrack = actionRef("rin.case.track", {
  description: "Watch a matter until a deadline (milliseconds since epoch). Describe what you are waiting for; optionally link the Niwa request or agent turn whose answer closes the case. If still open at the deadline, it becomes one occasion for Rin to consider.",
  input: CaseTrack,
  output: CaseKey,
});
export const rinCaseClose = actionRef("rin.case.close", {
  description: "Close a tracked case quietly. Any pending reminder about it is dropped.",
  input: CaseKey.extend({ reason: Reason.optional() }),
  output: CaseKey,
});
export const rinCaseList = actionRef("rin.case.list", {
  description: "List the open cases, in deadline order, with their expected replies or signals.",
  input: z.strictObject({}),
  output: z.object({ cases: z.array(CaseTrack.extend({ case: CaseId })) }),
});
