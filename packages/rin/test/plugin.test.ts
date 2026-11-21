// Rin on a real host. The test stands in for her model: it reads the facts she is told and decides as she would,
// through her own actions; the host carries the decisions out.

import { afterEach, expect, test } from "bun:test";
import { z } from "zod";

import { action, actionRef, grant, principalOf } from "@niwa-labs/core";
import type { Address, Caller, StoredRecord } from "@niwa-labs/core";
import { AGENT, plugin } from "@niwa-labs/plugin";
import type { AgentOffer, Plugin } from "@niwa-labs/plugin";
import { AGENT_BRIEFING, AGENT_TYPES, agentNotify } from "@niwa-labs/agent/records";
import { messageSendRef } from "@niwa-labs/messages/records";
import { requests } from "@niwa-labs/requests";
import { requestAnswer, requestAsk, requestCancel } from "@niwa-labs/requests/records";
import { RunFinished, RunStarted } from "@niwa-labs/workflow/records";
import { connect, connectAsOwner, createNiwa, eventually, messages, tempHome, testClock, timers } from "@niwa-labs/testing";
import type { NiwaApi, TestClock } from "@niwa-labs/testing";

import { rinPlugin } from "../src/plugin.ts";
import type { RinOptions } from "../src/plugin.ts";
import {
  rinAttend,
  rinAttention,
  rinBriefing,
  rinCharter,
  rinCharterPropose,
  rinContext,
  rinCorrect,
  rinDismiss,
  rinNotice,
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
  readonly clock: TestClock;
  /** What Rin was told, in order: the facts of her inbox. */
  readonly told: string[];
  /** What reached the owner now. */
  readonly sent: string[];
  readonly offered: { agents: AgentOffer[]; briefing: string[] };
  readonly owner: NiwaApi;
  readonly rin: NiwaApi;
  readonly lead: NiwaApi;
  readonly records: (type: string) => Promise<StoredRecord[]>;
  /** Write a record of the agents' or the workflow module's, as they would. */
  readonly agents: (type: string, data: unknown) => Promise<string>;
  readonly runs: (type: string, data: unknown, as?: NiwaApi) => Promise<string>;
  /** The fact Rin was last told that names an occasion, and the occasion. */
  readonly lastOccasion: () => string;
  readonly failSay: { on: boolean };
}

const cleanups: Array<() => Promise<void>> = [];
afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
});

async function world(options: Partial<RinOptions> = {}, start = NOON): Promise<World> {
  const home = await tempHome();
  const clock = testClock(start);
  const host = createNiwa({ home: home.path, clock });
  cleanups.push(() => home.cleanup());
  cleanups.push(() => host.close());
  const told: string[] = [];
  const sent: string[] = [];
  const failSay = { on: false };
  const offered = { agents: [] as AgentOffer[], briefing: [] as string[] };
  const agentsStub = writer("agents", AGENT_TYPES, (api) => {
    api.action(
      action(agentNotify, {
        recovery: "repeat",
        effect: "record",
        world: "niwa",
        run: async (input) => {
          if (input.agent === "rin") told.push(input.text);
          return { turn: `fact-${(told.length + 0xa00000).toString(16)}` };
        },
      }),
    );
    api.service(() => {
      offered.agents.push(...api.offers(AGENT).map((one) => one.value));
      offered.briefing.push(...api.offers(AGENT_BRIEFING).map((one) => one.value.action));
      return () => {};
    });
  });
  const workflowStub = writer("workflow", [RunStarted, RunFinished]);
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
          if (failSay.on) throw new Error("telegram is down");
          sent.push(input.text);
          return { messageId: sent.length };
        },
      }),
    );
  });
  host.use(
    messages({ bind }),
    requests({ bind }),
    timers([]),
    agentsStub,
    workflowStub,
    telegram,
    rinPlugin({ bind, harness: "claude", quietHours: { from: "23:00", to: "08:00" }, ...options }),
  );
  await host.serve();
  const owner = await connectAsOwner(home.path);
  cleanups.push(() => owner.close());
  const session = async (name: string) => {
    const token = host.issueToken(principalOf("session", name), { grant: grant(["rin.*", "request.ask", "message.send", "workflow.write"]) });
    const client = await connect({ home: home.path, id: `session:${name}`, token });
    cleanups.push(() => client.close());
    return client;
  };
  const rin = await session("rin");
  const lead = await session("lead");
  const records = async (type: string) => (await host.records.read()).filter((row) => row.type === type);
  return {
    clock,
    told,
    sent,
    offered,
    owner,
    rin,
    lead,
    records,
    agents: async (type, data) => (await owner.call(writeRef("agents"), { type, data })).id,
    runs: async (type, data, as = owner) => (await as.call(writeRef("workflow"), { type, data })).id,
    lastOccasion: () => {
      const fact = [...told].reverse().find((text) => text.includes("(occasion occ-"));
      return /occasion (occ-[0-9a-f]{10})/.exec(fact ?? "")?.[1] ?? "";
    },
    failSay,
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

test("an occasion that ends drops what waited about it", async () => {
  const w = await world();
  await w.lead.call(rinNotice, { key: "ci:main", kind: "ci", text: "Main is red" });
  await toldCount(w, 1);
  await w.rin.call(rinAttend, { subject: { kind: "occasion", occasion: w.lastOccasion() }, decision: "next-contact", text: "Main was red overnight" });
  expect((await w.lead.call(rinNotice, { key: "ci:main", kind: "ci", text: "Main is green", ends: true })).status).toBe("ended");
  expect((await w.owner.call(rinBriefing, { agent: "rin" })).text).toBe("");
  expect((await w.owner.call(rinAttention, {})).items).toMatchObject([{ status: "dropped" }]);
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
  await w.runs("workflow.run.started", { run: "run-00a001", file: "/s/a.ts", args: {}, label: "nightly" }, w.rin);
  await w.runs("workflow.run.started", { run: "run-00a002", file: "/s/b.ts", args: {} }, w.lead);
  await w.runs("workflow.run.finished", { run: "run-00a002", outcome: { status: "done", result: 1 } });
  await w.runs("workflow.run.finished", { run: "run-00a001", outcome: { status: "done", result: 1 } });
  await toldCount(w, 1);
  expect(w.told[0]).toContain("The workflow run run-00a001 (nightly) you started ended: done.");
  await Bun.sleep(50);
  expect(w.told).toHaveLength(1);
});

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

  // The rule goes with every occasion she is told about.
  await w.lead.call(rinNotice, { key: "ci:pr-3", kind: "ci", text: "CI is red on draft PR 3" });
  await toldCount(w, 3);
  expect(w.told[2]).toContain(`${proposed.rule} (attention.ci): Red CI on a draft PR is not worth telling`);
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
