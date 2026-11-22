import { AgentTurnReplied } from "@niwa-labs/agent/records";
import type { TurnAuthor } from "@niwa-labs/agent/records";
import { action, recordId, seq } from "@niwa-labs/core";
import type { Caller, JournalReader, Step, StoredRecord } from "@niwa-labs/core";
import type { PluginApi } from "@niwa-labs/plugin";
import { RequestAnswered } from "@niwa-labs/requests/records";
import { SLEEP_NEEDS, SleepRequested, TimerSlept, timerSleepRequest } from "@niwa-labs/timer";
import type { z } from "zod";

import { CaseClosed, CaseTracked, rinCaseClose, rinCaseList, rinCaseTrack } from "./case-records.ts";
import type { CaseId, CaseSignal } from "./case-records.ts";
import { OccasionEnded } from "./records.ts";

const CASE_KEY_PREFIX = "rin:case:";
export const caseKey = (id: CaseId): string => `${CASE_KEY_PREFIX}${id}`;
export const isCaseKey = (key: string): boolean => key.startsWith(CASE_KEY_PREFIX);
const moduleAuthor = { kind: "niwa", by: "rin.case" } as const;

type Tracked = z.output<typeof CaseTracked.schema>;
type Closed = z.output<typeof CaseClosed.schema>;
type Closing = readonly [typeof CaseClosed] | readonly [typeof CaseClosed, typeof OccasionEnded];

interface Cases {
  journal: () => JournalReader | undefined;
  serially: <T>(work: () => Promise<T>) => Promise<T>;
  checkCaller: (caller: Caller) => TurnAuthor;
  makeId: (seed: string) => CaseId;
  unknownCase: (caseId: CaseId) => Error;
  openOccasion: (step: Step, item: Tracked) => Promise<void>;
  endingOccasion: (id: CaseId) => z.output<typeof OccasionEnded.schema> | undefined;
}

export function installCases(api: PluginApi, dependencies: Cases) {
  const { journal, serially, checkCaller, makeId, unknownCase, openOccasion, endingOccasion } = dependencies;
  api.declare(CaseTracked, CaseClosed);
  api.needs({ actions: [timerSleepRequest] });

  const trackedById = (id: CaseId): Tracked | undefined => {
    const row = journal()?.find({ type: CaseTracked.name, field: "case", equals: id })[0];
    return row === undefined ? undefined : CaseTracked.schema.parse(row.data);
  };
  const closed = (id: CaseId): boolean =>
    (journal()?.find({ type: CaseClosed.name, field: "case", equals: id }).length ?? 0) > 0;
  const signalRecord = (signal: CaseSignal | undefined): StoredRecord | undefined => {
    if (signal === undefined) return undefined;
    if (signal.kind === "request-answered") {
      return journal()?.find({ type: RequestAnswered.name, field: "id", equals: signal.request })
        .find((row) => !("cancelled" in RequestAnswered.schema.parse(row.data).answer));
    }
    return journal()?.find({ type: AgentTurnReplied.name, field: "turn", equals: signal.turn })
      .find((row) => AgentTurnReplied.schema.parse(row.data).agent === signal.agent);
  };
  const open = (item: Tracked): boolean => !closed(item.case) && signalRecord(item.signal) === undefined;
  const hasOpenOccasion = (key: string): boolean => {
    if (!isCaseKey(key)) return true;
    const item = trackedById(key.slice(CASE_KEY_PREFIX.length));
    return item !== undefined && open(item);
  };
  const list = () => (journal()?.since(seq(0), [CaseTracked.name]) ?? [])
    .map((row) => CaseTracked.schema.parse(row.data))
    .filter(open)
    .sort((a, b) => a.due - b.due || a.case.localeCompare(b.case));

  const closing = (data: Closed) => {
    const close = { type: CaseClosed, data };
    const occasion = endingOccasion(data.case);
    return occasion === undefined ? [close] as const : [close, { type: OccasionEnded, data: occasion }] as const;
  };

  api.action(action(rinCaseTrack, {
    recovery: "repeat",
    effect: "record",
    world: "niwa",
    run: async (input, ctx) => {
      const by = checkCaller(ctx.caller);
      const id = makeId(String(ctx.operationId));
      const previous = journal()?.get(recordId(`${ctx.operationId}/emit/1`));
      if (previous?.type !== CaseTracked.name) await ctx.emit(CaseTracked, { ...input, case: id, by });
      return { case: id };
    },
  }));
  api.action(action(rinCaseClose, {
    recovery: "repeat",
    effect: "record",
    world: "niwa",
    run: (input, ctx) => serially(async () => {
      const by = checkCaller(ctx.caller);
      if (trackedById(input.case) === undefined) throw unknownCase(input.case);
      if (!closed(input.case)) await ctx.emitAll<Closing>(closing({ ...input, by }));
      return { case: input.case };
    }),
  }));
  api.action(action(rinCaseList, {
    recovery: "repeat",
    effect: "read",
    world: "niwa",
    run: (_input, ctx) => {
      checkCaller(ctx.caller);
      return { cases: list().map(({ by: _by, ...item }) => item) };
    },
  }));

  const closeFrom = async (item: Tracked, record: StoredRecord, step: Step): Promise<void> => {
    if (closed(item.case)) return;
    const data: Closed = { case: item.case, by: moduleAuthor, signalRecord: String(record.id) };
    await step.emitAll<Closing>(closing(data), { key: `close-${item.case}` });
  };
  const closeMatches = (step: Step, row: StoredRecord, field: string, value: string): Promise<void> => serially(async () => {
    for (const match of journal()?.find({ type: CaseTracked.name, field, equals: value }) ?? []) {
      const item = CaseTracked.schema.parse(match.data);
      if (signalRecord(item.signal)?.id === row.id) await closeFrom(item, row, step);
    }
  });
  api.on(RequestAnswered, { id: "case-request-answered" }, (answer, step, row) =>
    closeMatches(step, row, "signal.request", answer.id));
  api.on(AgentTurnReplied, { id: "case-agent-replied" }, (reply, step, row) =>
    closeMatches(step, row, "signal.turn", reply.turn));

  api.on(CaseTracked, { id: "case-deadline", requires: SLEEP_NEEDS }, (item, step) => serially(async () => {
    if (closed(item.case)) return;
    const signal = signalRecord(item.signal);
    if (signal !== undefined) {
      await closeFrom(item, signal, step);
      return;
    }
    await step(timerSleepRequest, { key: caseKey(item.case), at: item.due }, { key: "case-deadline" });
  }));

  api.on(TimerSlept, { id: "case-due" }, ({ key }, step, row) => {
    if (!isCaseKey(key)) return;
    return serially(async () => {
      const item = trackedById(key.slice(CASE_KEY_PREFIX.length));
      if (item === undefined || closed(item.case) || row.at < item.due) return;
      // A typed answer may already be committed even if its handler hasn't run yet.
      const signal = signalRecord(item.signal);
      if (signal !== undefined) await closeFrom(item, signal, step);
      else await openOccasion(step, item);
    });
  });
  api.on(CaseClosed, { id: "case-ended" }, (item, step, row) => serially(async () => {
    const key = caseKey(item.case);
    const reader = journal();
    if (reader?.find({ type: SleepRequested.name, field: "key", equals: key }).length &&
      !reader.find({ type: TimerSlept.name, field: "key", equals: key }).length) {
      // Settle the existing timer at closure. Its due handler sees the closed case and exits.
      await step(timerSleepRequest, { key, at: row.at }, { key: "settle-timer" });
    }
  }));

  return { list, hasOpenOccasion };
}
