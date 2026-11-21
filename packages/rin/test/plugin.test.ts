// Rin on a real host. The test stands in for her model: it reads the facts she is told and decides as she would,
// through her own actions; the host carries the decisions out.

import { afterEach, expect, test } from "bun:test";
import { z } from "zod";

import { NotSent, OptionIdSchema, action, actionRef, grant, principalOf } from "@niwa-labs/core";
import type { Address, Caller, StoredRecord } from "@niwa-labs/core";
import { AGENT, plugin, pluginName } from "@niwa-labs/plugin";
import type { AgentOffer, Plugin } from "@niwa-labs/plugin";
import { AGENT_BRIEFING, AGENT_PROMPT_SECTION, AGENT_TYPES, agentNotify } from "@niwa-labs/agent/records";
import { NoteCorrected, NoteErased, NoteRetracted, NoteWritten } from "@niwa-labs/memory/records";
import { messageSendRef } from "@niwa-labs/messages/records";
import { ResolverRegistry, requests } from "@niwa-labs/requests";
import { requestAnswer, requestAsk, requestCancel, requestOpen } from "@niwa-labs/requests/records";
import { RunFinished, RunRequested, RunStarted, workflowStart } from "@niwa-labs/workflow/records";
import { connect, connectAsOwner, createNiwa, eventually, messages, tempHome, testClock, timers, workflow } from "@niwa-labs/testing";
import type { NiwaApi, TestClock } from "@niwa-labs/testing";

import { rinPlugin } from "../src/plugin.ts";
import type { RinOptions } from "../src/plugin.ts";
import {
  rinAttend,
  rinAttention,
  rinBriefing,
  rinCharter,
  rinCharterPropose,
  rinPromptCharter,
  rinContext,
  rinConversation,
  rinCorrect,
  rinDismiss,
  rinInbox,
  rinNotice,
  rinSelfInstall,
} from "../src/records.ts";

const HOUR = 3_600_000;
/** Noon of a day, local time: away from the quiet hours. */
const NOON = new Date(2026, 10, 20, 12, 0).getTime();

/** The owner is the owner; a session `rin` speaks as the agent `rin`, a session `lead` as the agent `lead`. */
function bind(caller: Caller): Address | undefined {
  if (caller.kind !== "client") return undefined;
  if (caller.principal?.kind === "owner") return { kind: "owner" };
  if (caller.principal?.kind === "session") return { id: String(caller.principal.id), kind: "agent" };
  return { kind: "client", id: caller.id };
}

/** The action of a stub that writes a record of a type it declares, as the test says. */
const writeRef = (name: string) =>
  actionRef(`${name}.write`, {
    description: "Write a record of a declared type.",
    input: z.object({ type: z.string(), data: z.unknown() }),
    output: z.object({ id: z.string() }),
  });

function writer(name: string, types: readonly { name: string }[], extra: (api: Parameters<Parameters<typeof plugin>[1]>[0]) => void = () => {}): Plugin {
  return plugin(name, (api) => {
    api.declare(...(types as never[]));
    api.action(
      action(writeRef(name), {
        recovery: "repeat",
        effect: "record",
        world: "niwa",
        run: async (input, ctx) => {
          const type = types.find((one) => one.name === input.type);
          if (type === undefined) throw new Error(`no type ${input.type}`);
          return { id: String((await ctx.emit(type as never, input.data as never)).id) };
        },
      }),
    );
    extra(api);
  });
}

interface World {
  readonly home: string;
  readonly host: ReturnType<typeof createNiwa>;
  readonly clock: TestClock;
  /** What Rin was told, in order: the facts of her inbox. */
  readonly told: string[];
  /** What reached the owner now. */
  readonly sent: string[];
  readonly offered: { agents: AgentOffer[]; briefing: string[]; prompt: Array<{ id: string; agent?: string; action: string }> };
  readonly owner: NiwaApi;
  readonly rin: NiwaApi;
  readonly lead: NiwaApi;
  readonly records: (type: string) => Promise<StoredRecord[]>;
  /** Write a record of the agents' or the workflow module's, as they would. */
  readonly agents: (type: string, data: unknown) => Promise<string>;
  readonly runs: (type: string, data: unknown, as?: NiwaApi) => Promise<string>;
  /** Write a record of the memory module, as it would. */
  readonly memory: (type: string, data: unknown) => Promise<string>;
  /** The fact Rin was last told that names an occasion, and the occasion. */
  readonly lastOccasion: () => string;
  /** `on`: the send fails; `unsure`: it fails in a way that may have sent it, not as `NotSent`. */
  readonly failSay: { on: boolean; unsure: boolean };
  /** How many of the next facts told to her fail: the handler that tells her pauses, as after a crash. */
  readonly failTell: { times: number };
  /** Let a paused invocation go on: the step that failed is made again. */
  readonly retryPaused: () => Promise<void>;
}

const cleanups: Array<() => Promise<void>> = [];
afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
});

async function world(options: Partial<RinOptions> = {}, start = NOON, resolvers?: ResolverRegistry, realWorkflow = false, withTelegram = true): Promise<World> {
  const home = await tempHome();
  const clock = testClock(start);
  const host = createNiwa({ home: home.path, clock });
  cleanups.push(() => home.cleanup());
  cleanups.push(() => host.close());
  const told: string[] = [];
  const sent: string[] = [];
  const failSay = { on: false, unsure: false };
  const failTell = { times: 0 };
  const offered = { agents: [] as AgentOffer[], briefing: [] as string[], prompt: [] as Array<{ id: string; agent?: string; action: string }> };
  const agentsStub = writer("agents", AGENT_TYPES, (api) => {
    api.action(
      action(agentNotify, {
        recovery: "repeat",
        effect: "record",
        world: "niwa",
        run: async (input) => {
          if (failTell.times > 0) {
            failTell.times -= 1;
            throw new Error("the inbox is gone");
          }
          if (input.agent === "rin") told.push(input.text);
          return { turn: `fact-${(told.length + 0xa00000).toString(16)}` };
        },
      }),
    );
    api.service(() => {
      offered.agents.push(...api.offers(AGENT).map((one) => one.value));
      offered.briefing.push(...api.offers(AGENT_BRIEFING).map((one) => one.value.action));
      offered.prompt.push(...api.offers(AGENT_PROMPT_SECTION).map((one) => one.value));
      return () => {};
    });
  });
  const workflowStub = realWorkflow ? workflow() : writer("workflow", [RunRequested, RunStarted, RunFinished]);
  const memoryStub = writer("memory", [NoteWritten, NoteCorrected, NoteRetracted, NoteErased]);
  const telegram = plugin("telegram", (api) => {
    api.action(
      action("telegram.send", {
        description: "Send a text to the owner's chat.",
        input: z.object({ text: z.string() }),
        output: z.object({ messageId: z.number() }),
        recovery: "do-not-repeat",
        effect: "write",
        world: "local",
        run: async (input) => {
          if (failSay.on) throw failSay.unsure ? new Error("the connection was cut") : new NotSent("telegram is down");
          sent.push(input.text);
          return { messageId: sent.length };
        },
      }),
    );
  });
  host.use(
    messages({ bind }),
    requests({ bind, ...(resolvers === undefined ? {} : { resolvers }) }),
    timers([]),
    agentsStub,
    workflowStub,
    memoryStub,
    ...(withTelegram ? [telegram] : []),
    rinPlugin({ bind, harness: "claude", quietHours: { from: "23:00", to: "08:00" }, ...options }),
  );
  await host.serve();
  const owner = await connectAsOwner(home.path);
  cleanups.push(() => owner.close());
  const session = async (name: string) => {
    const token = host.issueToken(principalOf("session", name), { grant: grant(["rin.*", "request.ask", "message.send", "workflow.*"]) });
    const client = await connect({ home: home.path, id: `session:${name}`, token });
    cleanups.push(() => client.close());
    return client;
  };
  const rin = await session("rin");
  const lead = await session("lead");
  const records = async (type: string) => (await host.records.read()).filter((row) => row.type === type);
  return {
    home: home.path,
    host,
    clock,
    told,
    sent,
    offered,
    owner,
    rin,
    lead,
    records,
    agents: async (type, data) => (await owner.call(writeRef("agents"), { type, data })).id,
    memory: async (type, data) => (await owner.call(writeRef("memory"), { type, data })).id,
    runs: async (type, data, as = owner) => (await as.call(writeRef("workflow"), { type, data })).id,
    lastOccasion: () => {
      const fact = [...told].reverse().find((text) => text.includes("(occasion occ-"));
      return /occasion (occ-[0-9a-f]{10})/.exec(fact ?? "")?.[1] ?? "";
    },
    failSay,
    failTell,
    retryPaused: async () => {
      let paused: string | undefined;
      await eventually(async () => {
        const open = await owner.call(requestOpen, {});
        paused = open.requests.find((one): one is Extract<typeof one, { kind: "paused" }> => "kind" in one && one.kind === "paused")?.invocation;
        return paused !== undefined;
      }, 5000, "an invocation to pause");
      await owner.call("niwa.invocation.resolve" as never, { invocation: paused, choice: "retry" } as never);
    },
  };
}

/** Wait until Rin was told `n` facts. */
async function toldCount(w: World, n: number): Promise<void> {
  await eventually(() => w.told.length >= n, 5000, `Rin to be told ${n} facts, got ${w.told.length}`);
}

test("Rin is offered to the agents module with a briefing section of her own", async () => {
  const w = await world();
  expect(w.offered.agents.map((one) => one.name)).toEqual(["rin"]);
  expect(w.offered.briefing).toEqual(["rin.briefing"]);
  expect(w.offered.prompt).toEqual([{ id: "charter", agent: "rin", action: "rin.prompt.charter" }]);
});

test("an occasion reaches her once while it holds, with what she weighs", async () => {
  const w = await world();
  const opened = await w.lead.call(rinNotice, { key: "ci:pr-101", kind: "ci", text: "CI is red on PR 101" });
  expect(opened.status).toBe("opened");
  await toldCount(w, 1);
  expect(w.told[0]).toContain("CI is red on PR 101");
  expect(w.told[0]).toContain("The owner is not working in an attached session now.");
  expect(w.told[0]).toContain("Your charter has no rules yet.");

  // Three red builds over the night are one occasion.
  expect((await w.lead.call(rinNotice, { key: "ci:pr-101", kind: "ci", text: "CI is red on PR 101 again" })).status).toBe("repeated");
  expect((await w.lead.call(rinNotice, { key: "ci:pr-101", kind: "ci", text: "CI is red on PR 101 again" })).status).toBe("repeated");
  await Bun.sleep(50);
  expect(w.told).toHaveLength(1);
  const { occasions } = await w.owner.call(rinAttention, {});
  expect(occasions).toMatchObject([{ key: "ci:pr-101", count: 3 }]);
});

test("the stub model's decisions: silence keeps, the next contact waits for his message, now goes out", async () => {
  const w = await world();
  const decide = async (key: string, kind: string, decision: "silent" | "next-contact" | "now", text: string) => {
    const before = w.told.length;
    await w.lead.call(rinNotice, { key, kind, text });
    await toldCount(w, before + 1);
    return w.rin.call(rinAttend, { subject: { kind: "occasion", occasion: w.lastOccasion() }, decision, text });
  };
  expect((await decide("ci:pr-7", "ci", "silent", "CI on a draft")).outcome).toBe("kept");
  expect((await decide("task:t-1", "task", "next-contact", "The review is done: two comments"))).toMatchObject({ outcome: "held", why: "next-contact" });
  expect((await decide("agent:lead", "agent", "now", "The lead has been stuck for an hour"))).toMatchObject({ outcome: "sending" });
  await eventually(() => w.sent.length === 1);
  expect(w.sent).toEqual(["The lead has been stuck for an hour"]);

  // He writes to her: what waited is brought up, and she is told what it was.
  const before = w.told.length;
  await w.owner.call(messageSendRef, { to: { kind: "agent", id: "rin" }, body: { type: "update", text: "morning" } });
  await toldCount(w, before + 1);
  expect(w.told.at(-1)).toContain("- The review is done: two comments");
  const { items } = await w.owner.call(rinAttention, {});
  expect(items.map((one) => [one.text, one.status])).toEqual([
    ["The lead has been stuck for an hour", "said"],
    ["The review is done: two comments", "brought"],
  ]);
});

test("a fact of her inbox, a task's outcome, can be decided about by the id her inbox read gives", async () => {
  const w = await world();
  await w.agents("agent.turn.queued", { agent: "rin", turn: "fact-0a0a0a", kind: "fact", author: { kind: "niwa", by: "tasks" }, text: "Task task-1 is done: two comments\nmore" });
  await w.agents("agent.turn.queued", { agent: "lead", turn: "fact-0b0b0b", kind: "fact", author: { kind: "niwa", by: "tasks" }, text: "not hers" });
  const before = await w.rin.call(rinInbox, {});
  expect(before.turns).toEqual([{ turn: "fact-0a0a0a", kind: "fact", from: { kind: "niwa", by: "tasks" }, text: "Task task-1 is done: two comments", decided: false }]);
  const held = await w.rin.call(rinAttend, { subject: { kind: "turn", turn: before.turns[0]!.turn }, decision: "next-contact", text: "The review task is done: two comments" });
  expect(held.outcome).toBe("held");
  expect((await w.rin.call(rinInbox, {})).turns).toEqual([]);
  expect((await w.rin.call(rinInbox, { decided: true })).turns).toMatchObject([{ turn: "fact-0a0a0a", decided: true }]);
  expect((await w.owner.call(rinBriefing, { agent: "rin" })).text).toBe("- The review task is done: two comments");
});

test("the conversation shows what he wrote with where it stands, and what she wrote to him", async () => {
  const w = await world();
  const first = await w.owner.call(messageSendRef, { to: { kind: "agent", id: "rin" }, body: { type: "update", text: "Review the migration" } });
  const second = await w.owner.call(messageSendRef, { to: { kind: "agent", id: "rin" }, body: { type: "update", text: "And the docs" } });
  const third = await w.owner.call(messageSendRef, { to: { kind: "agent", id: "rin" }, body: { type: "update", text: "And the tests" } });
  await w.lead.call(messageSendRef, { to: { kind: "agent", id: "rin" }, body: { type: "update", text: "not his" } });
  expect((await w.owner.call(rinConversation, {})).messages.map((one) => [one.text, one.from, one.delivery])).toEqual([
    ["Review the migration", "owner", "waiting"],
    ["And the docs", "owner", "waiting"],
    ["And the tests", "owner", "waiting"],
  ]);
  await w.agents("agent.turn.delivered", { agent: "rin", turn: first.id, session: "claude s1", receipt: { status: "started" } });
  await w.agents("agent.turn.failed", { agent: "rin", turn: second.id, status: "unsent", reason: "the harness is gone" });
  await w.rin.call(messageSendRef, { to: { kind: "owner" }, body: { type: "update", text: "Done: two comments" } });
  const { messages } = await w.owner.call(rinConversation, {});
  expect(messages.map((one) => [one.id === third.id ? "third" : one.text, one.from, one.delivery])).toEqual([
    ["Review the migration", "owner", "delivered"],
    ["And the docs", "owner", "unsent"],
    ["third", "owner", "waiting"],
    ["Done: two comments", "rin", undefined],
  ]);
  expect((await w.owner.call(rinConversation, { limit: 2 })).messages.map((one) => one.from)).toEqual(["owner", "rin"]);
});

test("only Rin decides, and something already said is raised again only by a rule of her charter", async () => {
  const w = await world();
  await w.lead.call(rinNotice, { key: "pr:9", kind: "pr", text: "PR 9 waits for his review" });
  await toldCount(w, 1);
  const subject = { kind: "occasion" as const, occasion: w.lastOccasion() };
  await expect(w.lead.call(rinAttend, { subject, decision: "now", text: "x" })).rejects.toThrow("only Rin");
  await expect(w.rin.call(rinAttend, { subject, decision: "now" })).rejects.toThrow("needs the text");
  await w.rin.call(rinAttend, { subject, decision: "now", text: "PR 9 waits for you" });
  await expect(w.rin.call(rinAttend, { subject, decision: "now", text: "PR 9 still waits" })).rejects.toThrow("insist");
  await expect(w.rin.call(rinAttend, { subject, decision: "insist", text: "PR 9 still waits" })).rejects.toThrow("rule");

  const { rule } = await w.owner.call(rinCharterPropose, { about: "attention.pr", text: "A PR that waits on me a day is raised again" });
  const insisted = await w.rin.call(rinAttend, { subject, decision: "insist", text: "PR 9 still waits, a day now", rule });
  expect(insisted.outcome).toBe("sending");
  await eventually(() => w.sent.length === 2);
  expect(w.sent[1]).toBe("PR 9 still waits, a day now");
});

test("what she says now in his quiet hours goes out when they end", async () => {
  const night = new Date(2026, 10, 20, 23, 30).getTime();
  const w = await world({}, night);
  await w.lead.call(rinNotice, { key: "deploy:1", kind: "deploy", text: "The deploy failed" });
  await toldCount(w, 1);
  expect(w.told[0]).toContain("These are his quiet hours, until 08:00");
  const held = await w.rin.call(rinAttend, { subject: { kind: "occasion", occasion: w.lastOccasion() }, decision: "now", text: "The deploy failed at 23:30" });
  expect(held).toMatchObject({ outcome: "held", why: "quiet-hours", until: new Date(2026, 10, 21, 8, 0).getTime() });
  await w.clock.advance(4 * HOUR);
  await Bun.sleep(50);
  expect(w.sent).toEqual([]);
  await w.clock.advance(5 * HOUR);
  await eventually(() => w.sent.length === 1);
  expect(w.sent).toEqual(["The deploy failed at 23:30"]);
});

test("past the safety ceiling, what she says now waits for his next contact", async () => {
  const w = await world({ ceiling: { count: 1, windowMs: 24 * HOUR } });
  for (const key of ["a:1", "a:2"]) await w.lead.call(rinNotice, { key, kind: "agent", text: `Agent ${key} is stuck` });
  await toldCount(w, 2);
  const [first, second] = w.told.map((text) => /occasion (occ-[0-9a-f]{10})/.exec(text)?.[1] ?? "");
  expect((await w.rin.call(rinAttend, { subject: { kind: "occasion", occasion: first! }, decision: "now", text: "one" })).outcome).toBe("sending");
  expect(await w.rin.call(rinAttend, { subject: { kind: "occasion", occasion: second! }, decision: "now", text: "two" })).toMatchObject({ outcome: "held", why: "ceiling" });
  await eventually(() => w.sent.length === 1);
  expect((await w.rin.call(rinContext, {})).ceiling.left).toBe(0);
});

test("what cannot reach him now waits for his next contact, and she is told", async () => {
  const w = await world();
  w.failSay.on = true;
  await w.lead.call(rinNotice, { key: "x:1", kind: "ci", text: "red" });
  await toldCount(w, 1);
  await w.rin.call(rinAttend, { subject: { kind: "occasion", occasion: w.lastOccasion() }, decision: "now", text: "Main is red" });
  await toldCount(w, 2);
  expect(w.told[1]).toContain("did not reach him");
  expect((await w.owner.call(rinAttention, { status: "held" })).items).toMatchObject([{ text: "Main is red", why: "undelivered" }]);
});

test("a decision to tell him now is refused while the host serves no action that does, and holding it is not", async () => {
  const w = await world({}, NOON, undefined, false, false);
  await w.lead.call(rinNotice, { key: "ci:x", kind: "ci", text: "red" });
  await toldCount(w, 1);
  const subject = { kind: "occasion" as const, occasion: w.lastOccasion() };
  await expect(w.rin.call(rinAttend, { subject, decision: "now", text: "Main is red" })).rejects.toThrow('"telegram.send", which nothing on this host serves');
  expect((await w.owner.call(rinAttention, {})).items).toEqual([]);
  expect((await w.rin.call(rinAttend, { subject, decision: "next-contact", text: "Main is red" })).outcome).toBe("held");
});

test("a custom channel is the action named in the refusal", async () => {
  const w = await world({ say: "slack.post" }, NOON, undefined, false, false);
  await w.lead.call(rinNotice, { key: "ci:y", kind: "ci", text: "red" });
  await toldCount(w, 1);
  await expect(w.rin.call(rinAttend, { subject: { kind: "occasion", occasion: w.lastOccasion() }, decision: "now", text: "x" })).rejects.toThrow('"slack.post"');
});

test("what may have reached him is not sent again and does not wait for his next contact", async () => {
  const w = await world();
  w.failSay.on = true;
  w.failSay.unsure = true;
  await w.lead.call(rinNotice, { key: "x:1", kind: "ci", text: "red" });
  await toldCount(w, 1);
  const subject = { kind: "occasion" as const, occasion: w.lastOccasion() };
  await w.rin.call(rinAttend, { subject, decision: "now", text: "Main is red" });
  await toldCount(w, 2);
  expect(w.told[1]).toContain("may or may not have reached him");
  expect((await w.owner.call(rinAttention, {})).items).toMatchObject([{ text: "Main is red", status: "unsure" }]);
  expect((await w.owner.call(rinBriefing, { agent: "rin" })).text).toBe("");
  // It counts as told: saying it again is insisting.
  await expect(w.rin.call(rinAttend, { subject, decision: "now", text: "Main is red" })).rejects.toThrow("insist");
});

test("what did not reach him because its occasion ended meanwhile is dropped, not held for his next contact", async () => {
  const w = await world();
  w.failSay.on = true;
  await w.lead.call(rinNotice, { key: "x:2", kind: "ci", text: "red" });
  await toldCount(w, 1);
  const subject = { kind: "occasion" as const, occasion: w.lastOccasion() };
  // The send fails slowly: the occasion ends before the failure is settled.
  await w.rin.call(rinAttend, { subject, decision: "now", text: "Main is red" });
  await w.lead.call(rinNotice, { key: "x:2", kind: "ci", text: "green", ends: true });
  await Bun.sleep(100);
  expect((await w.owner.call(rinBriefing, { agent: "rin" })).text).toBe("");
  const items = (await w.owner.call(rinAttention, {})).items;
  expect(items.map((one) => one.status)).not.toContain("held");
});

test("a decision about an occasion that ended is refused", async () => {
  const w = await world();
  await w.lead.call(rinNotice, { key: "ci:late", kind: "ci", text: "Main is red" });
  await toldCount(w, 1);
  const subject = { kind: "occasion" as const, occasion: w.lastOccasion() };
  await w.lead.call(rinNotice, { key: "ci:late", kind: "ci", text: "Main is green", ends: true });
  await expect(w.rin.call(rinAttend, { subject, decision: "next-contact", text: "Main was red" })).rejects.toThrow("no such occasion");
});

test("two decisions to tell him one thing are one message, and a thing already told is raised again only by insisting", async () => {
  const night = new Date(2026, 10, 20, 23, 30).getTime();
  const w = await world({}, night);
  await w.lead.call(rinNotice, { key: "deploy:2", kind: "deploy", text: "The deploy failed" });
  await toldCount(w, 1);
  const subject = { kind: "occasion" as const, occasion: w.lastOccasion() };
  const first = await w.rin.call(rinAttend, { subject, decision: "now", text: "The deploy failed" });
  const second = await w.rin.call(rinAttend, { subject, decision: "now", text: "The deploy failed at 23:30, twice" });
  expect(second.item).toBe(first.item);
  expect((await w.owner.call(rinAttention, {})).items).toMatchObject([{ text: "The deploy failed at 23:30, twice", status: "held" }]);
  await w.clock.advance(9 * HOUR);
  await eventually(() => w.sent.length >= 1);
  await Bun.sleep(50);
  expect(w.sent).toEqual(["The deploy failed at 23:30, twice"]);

  // A held thing is not told yet, so there is nothing to insist on; a told one cannot be said again or held again.
  await w.lead.call(rinNotice, { key: "deploy:3", kind: "deploy", text: "Another deploy failed" });
  await toldCount(w, 2);
  const other = { kind: "occasion" as const, occasion: w.lastOccasion() };
  await w.rin.call(rinAttend, { subject: other, decision: "next-contact", text: "Another deploy failed" });
  const rule = (await w.owner.call(rinCharterPropose, { about: "attention.deploy", text: "Raise a failed deploy again after a day" })).rule;
  await expect(w.rin.call(rinAttend, { subject: other, decision: "insist", text: "again", rule })).rejects.toThrow("not told");
  await w.owner.call(messageSendRef, { to: { kind: "agent", id: "rin" }, body: { type: "update", text: "morning" } });
  await eventually(async () => (await w.records("rin.attention.brought")).length === 1);
  await expect(w.rin.call(rinAttend, { subject: other, decision: "now", text: "again" })).rejects.toThrow("insist");
  await expect(w.rin.call(rinAttend, { subject: other, decision: "next-contact", text: "again" })).rejects.toThrow("insist");
});

test("an occasion that ends drops what waited about it", async () => {
  const w = await world();
  await w.lead.call(rinNotice, { key: "ci:main", kind: "ci", text: "Main is red" });
  await toldCount(w, 1);
  await w.rin.call(rinAttend, { subject: { kind: "occasion", occasion: w.lastOccasion() }, decision: "next-contact", text: "Main was red overnight" });
  expect((await w.lead.call(rinNotice, { key: "ci:main", kind: "ci", text: "Main is green", ends: true })).status).toBe("ended");
  expect((await w.owner.call(rinBriefing, { agent: "rin" })).text).toBe("");
  expect((await w.owner.call(rinAttention, {})).items).toMatchObject([{ status: "dropped" }]);
});

test("what was brought up reaches her from the record that says so, also when telling her paused", async () => {
  const w = await world();
  await w.lead.call(rinNotice, { key: "task:t-9", kind: "task", text: "The review task is done" });
  await toldCount(w, 1);
  await w.rin.call(rinAttend, { subject: { kind: "occasion", occasion: w.lastOccasion() }, decision: "next-contact", text: "The review is done" });
  w.failTell.times = 1;
  await w.owner.call(messageSendRef, { to: { kind: "agent", id: "rin" }, body: { type: "update", text: "morning" } });
  await eventually(async () => (await w.records("rin.attention.brought")).length === 1);
  await w.retryPaused();
  await toldCount(w, 2);
  expect(w.told[1]).toContain("- The review is done");
});

test("her briefing shows what waits, also to the attach that brought it up", async () => {
  const w = await world();
  await w.lead.call(rinNotice, { key: "task:t-2", kind: "task", text: "The migration task is done" });
  await toldCount(w, 1);
  await w.rin.call(rinAttend, { subject: { kind: "occasion", occasion: w.lastOccasion() }, decision: "next-contact", text: "The migration is done" });
  expect((await w.owner.call(rinBriefing, { agent: "rin" })).text).toBe("- The migration is done");
  expect((await w.owner.call(rinBriefing, { agent: "lead" })).text).toBe("");

  await w.agents("agent.attached", { agent: "rin", session: "claude s1", cwd: "/work/a" });
  await eventually(async () => (await w.records("rin.attention.brought")).length === 1);
  expect((await w.owner.call(rinBriefing, { agent: "rin" })).text).toBe("- The migration is done");
  expect((await w.rin.call(rinContext, {})).working).toEqual([{ session: "claude s1", cwd: "/work/a", agent: "rin" }]);

  await w.agents("agent.attached", { agent: "rin", session: "claude s2", cwd: "/work/a" });
  expect((await w.owner.call(rinBriefing, { agent: "rin" })).text).toBe("");
});

test("a stuck agent is an occasion until a turn reaches it again", async () => {
  const w = await world();
  await w.agents("agent.turn.failed", { agent: "lead", turn: "msg-abcdef", status: "unsent", reason: "the harness is gone" });
  await toldCount(w, 1);
  expect(w.told[0]).toContain("A turn did not reach agent lead");
  await w.agents("agent.turn.failed", { agent: "lead", turn: "msg-abcde0", status: "unsent", reason: "the harness is gone" });
  await eventually(async () => (await w.records("rin.occasion.repeated")).length === 1);
  await w.agents("agent.turn.delivered", { agent: "lead", turn: "msg-abcde1", session: "claude s9", receipt: { status: "started" } });
  await eventually(async () => (await w.records("rin.occasion.ended")).length === 1);
  expect(w.told).toHaveLength(1);
  expect((await w.owner.call(rinAttention, {})).occasions).toEqual([]);
});

test("she learns how a workflow run she started ended, and not runs of others", async () => {
  const w = await world();
  // The run is asked for by its caller, and the workflow module writes its start.
  await w.runs("workflow.run.requested", { run: "run-00a001", file: "/s/a.ts", args: {}, label: "nightly" }, w.rin);
  await w.runs("workflow.run.requested", { run: "run-00a002", file: "/s/b.ts", args: {} }, w.lead);
  await w.runs("workflow.run.started", { run: "run-00a001", file: "/s/a.ts", args: {}, label: "nightly" });
  await w.runs("workflow.run.started", { run: "run-00a002", file: "/s/b.ts", args: {} });
  await w.runs("workflow.run.finished", { run: "run-00a002", outcome: { status: "done", result: 1 } });
  await w.runs("workflow.run.finished", { run: "run-00a001", outcome: { status: "done", result: 1 } });
  await toldCount(w, 1);
  expect(w.told[0]).toContain("The workflow run run-00a001 (nightly) you started ended: done.");
  await Bun.sleep(50);
  expect(w.told).toHaveLength(1);
});

test("on a real workflow module she learns of the run she started with workflow.start, and not of another caller's", async () => {
  const w = await world({}, NOON, undefined, true);
  const script = `${w.home}/quick.ts`;
  await Bun.write(script, 'export default workflow({ description: "A run that ends at once", output: z.json() }, async () => ({ ok: true }));\n');
  const hers = await w.rin.call(workflowStart, { file: script });
  const his = await w.lead.call(workflowStart, { file: script });
  await eventually(async () => (await w.records("workflow.run.finished")).length === 2, 20_000, "both runs to finish");
  await toldCount(w, 1);
  expect(w.told[0]).toContain(`The workflow run ${hers.run}`);
  await Bun.sleep(100);
  expect(w.told).toHaveLength(1);
  expect(w.told.join("\n")).not.toContain(his.run);
}, 60_000);

test("a correction is the owner's: Rin writes one only from his own words", async () => {
  const w = await world();
  await expect(w.lead.call(rinCorrect, { about: "tone", what: "Be shorter" })).rejects.toThrow("owner");
  await expect(w.rin.call(rinCorrect, { about: "tone", what: "Be shorter" })).rejects.toThrow("own words");
  const said = await w.lead.call(messageSendRef, { to: { kind: "agent", id: "rin" }, body: { type: "update", text: "be shorter" } });
  await expect(w.rin.call(rinCorrect, { about: "tone", what: "Be shorter", source: said.id })).rejects.toThrow("own words");
  const his = await w.owner.call(messageSendRef, { to: { kind: "agent", id: "rin" }, body: { type: "update", text: "too long, keep it to three lines" } });
  const written = await w.rin.call(rinCorrect, { about: "tone", what: "Keep Telegram replies to three lines", source: his.id });
  const { corrections } = await w.owner.call(rinCharter, {});
  expect(corrections).toMatchObject([{ correction: written.correction, about: "tone", by: { kind: "agent", id: "rin" } }]);
});

test("her source may be the id of the journal record that holds his words, and nothing that merely carries his name", async () => {
  const w = await world();
  const his = await w.owner.call(messageSendRef, { to: { kind: "agent", id: "rin" }, body: { type: "update", text: "too long, keep it to three lines" } });
  // The id of the record an action emitted holds slashes: it is a record id like any other.
  const record = (await w.records("message.sent")).find((row) => (row.data as { id?: string }).id === his.id)!;
  expect(String(record.id)).toContain("/emit/");
  const viaRecord = await w.rin.call(rinCorrect, { about: "tone", what: "Keep replies to three lines", source: String(record.id) });
  expect(viaRecord.correction).toMatch(/^cor-/);

  // A turn of his that holds a message counts; one whose author is another agent does not, whoever wrote the record.
  const turn = await w.agents("agent.turn.queued", { agent: "rin", turn: "msg-aaaaaa", kind: "message", author: { kind: "owner" }, text: "no jokes before ten" });
  expect((await w.rin.call(rinCorrect, { about: "tone", what: "No jokes before ten", source: turn })).correction).toMatch(/^cor-/);
  const alien = await w.agents("agent.turn.queued", { agent: "rin", turn: "msg-bbbbbb", kind: "message", author: { kind: "agent", id: "lead" }, text: "he said no jokes" });
  await expect(w.rin.call(rinCorrect, { about: "tone", what: "No jokes", source: alien })).rejects.toThrow("own words");

  // A record his client wrote that holds no words of his: his own correction, or the answer to a request.
  const written = await w.owner.call(rinCorrect, { about: "memory", what: "Stop noting what I eat" });
  const correction = (await w.records("rin.corrected")).find((row) => (row.data as { correction?: string }).correction === written.correction)!;
  await expect(w.rin.call(rinCorrect, { about: "memory", what: "Stop noting food", source: String(correction.id) })).rejects.toThrow("own words");
  await expect(w.rin.call(rinCorrect, { about: "memory", what: "Stop noting food", source: "no-such-record/emit/1" })).rejects.toThrow("own words");
});

test("repeated corrections ask her for a rule, and the owner's yes puts it in her charter", async () => {
  const w = await world();
  const first = await w.owner.call(rinCorrect, { about: "attention.ci", what: "Do not tell me about CI on drafts" });
  await Bun.sleep(30);
  expect(w.told).toHaveLength(0);
  const second = await w.owner.call(rinCorrect, { about: "attention.ci", what: "Draft PRs can be red, leave them" });
  await toldCount(w, 1);
  expect(w.told[0]).toContain("corrections about attention.ci repeat");
  expect(w.told[0]).toContain(first.correction);
  expect(w.told[0]).toContain(second.correction);

  // The stub model words the rule.
  const proposed = await w.rin.call(rinCharterPropose, {
    about: "attention.ci",
    text: "Red CI on a draft PR is not worth telling",
    corrections: [first.correction, second.correction],
  });
  expect(proposed.status).toBe("proposed");
  await expect(w.rin.call(rinCharterPropose, { about: "attention.ci", text: "again" })).rejects.toThrow("already waits");
  expect((await w.owner.call(rinBriefing, { agent: "rin" })).text).toContain("Red CI on a draft PR is not worth telling");

  await eventually(async () => (await w.records("request.created")).length === 1);
  const asked = (await w.records("request.created"))[0]?.data as { id: string; input: { title: string } };
  expect(asked.input.title).toContain("Red CI on a draft PR is not worth telling");
  await w.owner.call(requestAnswer, { id: asked.id, answer: { ids: ["confirm"] } });
  await eventually(async () => (await w.records("rin.charter.ruled")).length === 1);
  await toldCount(w, 2);
  expect(w.told[1]).toContain("The owner confirmed a rule of your charter");

  // The rule is in the section of her prompt, read live, and only hers.
  expect((await w.owner.call(rinPromptCharter, { agent: "rin" })).text).toContain(`${proposed.rule} (attention.ci): Red CI on a draft PR is not worth telling`);
  expect((await w.owner.call(rinPromptCharter, { agent: "lead" })).text).toBe("");

  // The rule goes with every occasion she is told about.
  await w.lead.call(rinNotice, { key: "ci:pr-3", kind: "ci", text: "CI is red on draft PR 3" });
  await toldCount(w, 3);
  expect(w.told[2]).toContain(`${proposed.rule} (attention.ci): Red CI on a draft PR is not worth telling`);
});

test("the ask for a rule reaches her from the record that says one is due, also when telling her paused", async () => {
  const w = await world();
  await w.owner.call(rinCorrect, { about: "attention.ci", what: "Do not tell me about CI on drafts" });
  w.failTell.times = 1;
  await w.owner.call(rinCorrect, { about: "attention.ci", what: "Draft PRs can be red, leave them" });
  await eventually(async () => (await w.records("rin.charter.due")).length === 1);
  await w.retryPaused();
  await toldCount(w, 1);
  expect(w.told[0]).toContain("corrections about attention.ci repeat");
});

test("her prompt section says her charter has no rules before the owner confirms one", async () => {
  const w = await world();
  expect((await w.owner.call(rinPromptCharter, { agent: "rin" })).text).toBe("Your charter has no rules yet.");
});

test("a rule the owner declines stays out of the charter", async () => {
  const w = await world();
  const proposed = await w.rin.call(rinCharterPropose, { about: "tone", text: "No jokes before ten" });
  await eventually(async () => (await w.records("request.created")).length === 1);
  const asked = (await w.records("request.created"))[0]?.data as { id: string };
  await w.owner.call(requestAnswer, { id: asked.id, answer: { ids: ["decline"] } });
  await eventually(async () => (await w.records("rin.charter.declined")).length === 1);
  const { rules } = await w.owner.call(rinCharter, {});
  expect(rules).toMatchObject([{ rule: proposed.rule, status: "declined" }]);
});

test("what the owner answers to a question of hers comes back to her as a fact, and a resolver's answer is told as not his", async () => {
  const w = await world();
  const choice = { kind: "choice", title: "Shall I archive the old branches?", options: [{ id: "yes", label: "yes", flavor: "plain" }, { id: "no", label: "no", flavor: "plain" }] } as never;
  const first = (await w.rin.call(requestAsk, { to: { kind: "owner" }, question: "rin.archive" as never, input: choice })) as { id: string };
  await w.owner.call(requestAnswer, { id: first.id as never, answer: { ids: ["no"] } as never });
  await toldCount(w, 1);
  expect(w.told[0]).toContain(first.id);
  expect(w.told[0]).toContain("Shall I archive the old branches?");
  expect(w.told[0]).toContain("The owner chose no");

  const second = await world({}, NOON, resolving("yes"));
  const asked = (await second.rin.call(requestAsk, { to: { kind: "owner" }, question: "rin.archive" as never, input: choice })) as { id: string };
  await toldCount(second, 1);
  expect(second.told[0]).toContain(asked.id);
  expect(second.told[0]).toContain("Not the owner but a resolver");
});

test("what the owner acts out is a correction: a question of hers turned down, something she told him waved away", async () => {
  const w = await world();
  const ask = await w.rin.call(requestAsk, { to: { kind: "owner" }, question: "rin.check" as never, input: { kind: "choice", title: "Shall I archive the old branches?", options: [{ id: "yes", label: "yes", flavor: "plain" }] } as never });
  const id = (ask as { id: string }).id;
  await w.owner.call(requestCancel, { id: id as never, reason: "not now" });
  await eventually(async () => (await w.records("rin.corrected")).length === 1);
  const turnedDown = (await w.records("rin.corrected"))[0]?.data as { about: string; what: string };
  expect(turnedDown).toMatchObject({ about: "questions" });
  expect(turnedDown.what).toContain("Shall I archive the old branches?");

  await w.lead.call(rinNotice, { key: "news:1", kind: "news", text: "A new release of Bun" });
  await toldCount(w, 1);
  const said = await w.rin.call(rinAttend, { subject: { kind: "occasion", occasion: w.lastOccasion() }, decision: "next-contact", text: "Bun has a new release" });
  await expect(w.lead.call(rinDismiss, { item: said.item! })).rejects.toThrow("only the owner");
  await w.owner.call(rinDismiss, { item: said.item!, reason: "I do not care about releases" });
  const corrections = (await w.owner.call(rinCharter, {})).corrections;
  expect(corrections.map((one) => one.about)).toEqual(["questions", "attention.news"]);
  expect((await w.owner.call(rinBriefing, { agent: "rin" })).text).toBe("");
});

const HER = { kind: "agent" as const, id: "rin" };
const noteWritten = (note: string, text: string) => ({ memory: "rin", note, text, about: "owner", source: { kind: "inferred" }, by: HER });

test("what the owner did to a note of hers is a correction that reads the note from memory, and shows nothing of an erased one", async () => {
  const w = await world();
  await w.memory("memory.note.written", noteWritten("note-aaaaaaaa", "The owner eats late"));
  await w.memory("memory.note.corrected", { memory: "rin", note: "note-aaaaaaaa", text: "The owner eats at nine", by: { kind: "owner" } });
  await w.memory("memory.note.written", noteWritten("note-bbbbbbbb", "The owner dislikes mornings"));
  await w.memory("memory.note.retracted", { memory: "rin", note: "note-bbbbbbbb", reason: "He likes them", by: { kind: "owner" } });
  await eventually(async () => (await w.records("rin.corrected")).length === 2);
  const read = async () => (await w.owner.call(rinCharter, {})).corrections.map((one) => one.what);
  expect(await read()).toEqual([
    'The owner changed a note of yours: "The owner eats late" became "The owner eats at nine"',
    'The owner took back a note of yours: "The owner dislikes mornings", saying: He likes them',
  ]);

  // Erased: what the correction says no longer holds the note's words, though nothing was rewritten.
  await w.memory("memory.note.erased", { memory: "rin", note: "note-aaaaaaaa", by: { kind: "owner" } });
  await eventually(async () => (await w.records("rin.corrected")).length === 3);
  const after = await read();
  expect(after.join("\n")).not.toContain("eats");
  expect(after[0]).toBe("The owner changed a note of yours");
  expect(after[1]).toContain("dislikes mornings");
  // The records of her own hold no words of the note either.
  expect(JSON.stringify((await w.records("rin.corrected")).map((row) => row.data))).not.toContain("eats");
});

test("the ask for a rule holds none of a note's words, which stay in memory and in what rin.charter reads", async () => {
  const w = await world();
  await w.memory("memory.note.written", noteWritten("note-aaaaaaaa", "The owner eats late"));
  await w.memory("memory.note.corrected", { memory: "rin", note: "note-aaaaaaaa", text: "The owner eats at nine", by: { kind: "owner" } });
  await eventually(async () => (await w.records("rin.corrected")).length === 1);
  await w.memory("memory.note.corrected", { memory: "rin", note: "note-aaaaaaaa", text: "The owner eats at ten", by: { kind: "owner" } });
  await eventually(async () => (await w.records("rin.corrected")).length === 2);
  await toldCount(w, 1);
  expect(w.told[0]).toContain("corrections about memory repeat");
  expect(w.told[0]).toContain("rin.charter");
  expect(w.told[0]).not.toContain("eats");
  // Her inbox is journaled: the words of a note erased after the ask are not in it.
  expect(JSON.stringify((await w.records("agent.turn.queued")).map((row) => row.data))).not.toContain("eats");
  expect((await w.owner.call(rinCharter, {})).corrections.map((one) => one.what).join("\n")).toContain("eats at nine");
});

test("a long reason for taking a note back does not make the charter unreadable", async () => {
  const w = await world();
  await w.memory("memory.note.written", noteWritten("note-cccccccc", "The owner likes jazz"));
  await w.memory("memory.note.retracted", { memory: "rin", note: "note-cccccccc", reason: "x".repeat(2100), by: { kind: "owner" } });
  await eventually(async () => (await w.records("rin.corrected")).length === 1);
  const { corrections } = await w.owner.call(rinCharter, {});
  expect(corrections).toHaveLength(1);
  expect(corrections[0]!.what.length).toBeLessThanOrEqual(2000);
  expect(corrections[0]!.what).toContain("The owner likes jazz");
});

test("notices and decisions that arrive at once are taken one after the other", async () => {
  const w = await world();
  const notices = await Promise.all([1, 2, 3].map((n) => w.lead.call(rinNotice, { key: "ci:pr-5", kind: "ci", text: `red ${n}` })));
  expect(notices.map((one) => one.status).sort()).toEqual(["opened", "repeated", "repeated"]);
  await toldCount(w, 1);
  const subject = { kind: "occasion" as const, occasion: w.lastOccasion() };
  const decided = await Promise.allSettled([1, 2].map((n) => w.rin.call(rinAttend, { subject, decision: "now", text: `PR 5 is red (${n})` })));
  expect(decided.map((one) => one.status).sort()).toEqual(["fulfilled", "rejected"]);
});

// ---- the owner's word -------------------------------------------------------------------------------------------

/** A resolver that answers every question with the choice, as a judge of an area would. */
function resolving(choice: string): ResolverRegistry {
  const resolvers = new ResolverRegistry();
  resolvers.register("*", () => ({ answered: true, answer: { ids: [OptionIdSchema.parse(choice)] }, info: { how: "recalled" } }));
  return resolvers;
}

test("a rule is the owner's only when he answered: a resolver's yes leaves it out of the charter", async () => {
  const w = await world({}, NOON, resolving("confirm"));
  const proposed = await w.rin.call(rinCharterPropose, { about: "tone", text: "No jokes before ten" });
  await eventually(async () => (await w.records("rin.charter.declined")).length === 1);
  expect((await w.records("rin.charter.ruled")).length).toBe(0);
  expect((await w.records("rin.charter.declined"))[0]?.data).toMatchObject({ rule: proposed.rule, why: "not-his" });
  expect((await w.owner.call(rinCharter, {})).rules).toMatchObject([{ rule: proposed.rule, status: "declined" }]);
  await toldCount(w, 1);
  expect(w.told[0]).toContain("not answered by the owner");
});

/** A module that exports a plugin of Rin's group, written to a file of the host's home. */
async function moduleOf(w: World, name: string, version: string): Promise<string> {
  const path = `${w.home}/${name.replace("/", "-")}.ts`;
  await Bun.write(
    path,
    [`import { plugin } from ${JSON.stringify(import.meta.resolve("@niwa-labs/plugin"))};`, `export default plugin(${JSON.stringify(name)}, () => {}, { version: ${JSON.stringify(version)} });`, ""].join("\n"),
  );
  return path;
}

/** The request Rin's last proposal to the owner opened. */
async function asked(w: World, count: number): Promise<{ id: string; input: { title: string } }> {
  await eventually(async () => (await w.records("request.created")).length === count);
  return (await w.records("request.created"))[count - 1]!.data as { id: string; input: { title: string } };
}

test("she installs a plugin of her own group only after the owner said yes to that file", async () => {
  const w = await world({ selfEdit: true });
  const module = await moduleOf(w, "rin/extra", "v1");
  const proposed = await w.rin.call(rinSelfInstall, { plugin: "rin/extra", module, why: "to keep a diary" });
  const request = await asked(w, 1);
  expect(request.input.title).toContain("rin/extra");
  expect(request.input.title).toContain(proposed.hash);
  expect(request.input.title).toContain("to keep a diary");
  // Nothing is installed while the owner has not answered.
  expect(w.host.installed(pluginName("rin/extra"))).toBeUndefined();

  await w.owner.call(requestAnswer, { id: request.id, answer: { ids: ["confirm"] } });
  await eventually(async () => (await w.records("rin.self-edit.settled")).length === 1);
  expect((await w.records("rin.self-edit.settled"))[0]?.data).toMatchObject({ edit: proposed.edit, outcome: "installed" });
  expect(String(w.host.installed(pluginName("rin/extra"))?.version)).toBe("v1");
  await toldCount(w, 1);
  expect(w.told[0]).toContain("rin/extra");
});

test("a plugin the owner declines is not installed, and a file changed after he looked is refused", async () => {
  const w = await world({ selfEdit: true });
  const module = await moduleOf(w, "rin/extra", "v1");
  await w.rin.call(rinSelfInstall, { plugin: "rin/extra", module, why: "diary" });
  await w.owner.call(requestAnswer, { id: (await asked(w, 1)).id, answer: { ids: ["decline"] } });
  await eventually(async () => (await w.records("rin.self-edit.settled")).length === 1);
  expect((await w.records("rin.self-edit.settled"))[0]?.data).toMatchObject({ outcome: "declined" });
  expect(w.host.installed(pluginName("rin/extra"))).toBeUndefined();

  // He says yes to the file he was shown; it changes before it is installed.
  await w.rin.call(rinSelfInstall, { plugin: "rin/extra", module, why: "diary again" });
  const second = await asked(w, 2);
  await moduleOf(w, "rin/extra", "v2");
  await w.owner.call(requestAnswer, { id: second.id, answer: { ids: ["confirm"] } });
  await eventually(async () => (await w.records("rin.self-edit.settled")).length === 2);
  expect((await w.records("rin.self-edit.settled"))[1]?.data).toMatchObject({ outcome: "failed" });
  expect(w.host.installed(pluginName("rin/extra"))).toBeUndefined();
});

test("a resolver's yes does not install a plugin", async () => {
  const w = await world({ selfEdit: true }, NOON, resolving("confirm"));
  const module = await moduleOf(w, "rin/extra", "v1");
  await w.rin.call(rinSelfInstall, { plugin: "rin/extra", module, why: "diary" });
  await eventually(async () => (await w.records("rin.self-edit.settled")).length === 1);
  expect((await w.records("rin.self-edit.settled"))[0]?.data).toMatchObject({ outcome: "not-his" });
  expect(w.host.installed(pluginName("rin/extra"))).toBeUndefined();
});

test("only Rin proposes to change herself, only when the owner turned it on, and only a plugin of her group", async () => {
  const on = await world({ selfEdit: true });
  const module = await moduleOf(on, "rin/extra", "v1");
  await expect(on.lead.call(rinSelfInstall, { plugin: "rin/extra", module, why: "x" })).rejects.toThrow("only Rin");
  await expect(on.owner.call(rinSelfInstall, { plugin: "rin/extra", module, why: "x" })).rejects.toThrow("only Rin");
  await expect(on.rin.call(rinSelfInstall, { plugin: "other/extra", module, why: "x" })).rejects.toThrow("begins with rin/");
  await expect(on.rin.call(rinSelfInstall, { plugin: "rin/extra", module: `${on.home}/missing.ts`, why: "x" })).rejects.toThrow("cannot read");
  expect((await on.records("request.created")).length).toBe(0);

  const off = await world();
  await expect(off.rin.call(rinSelfInstall, { plugin: "rin/extra", module: await moduleOf(off, "rin/extra", "v1"), why: "x" })).rejects.toThrow("turned off");
});
