// Rin's composition: her plugins install after the agents module, and a host that lacks what she needs refuses
// to serve and says what to install.

import { afterEach, expect, test } from "bun:test";

import { agents } from "@niwa-labs/agent";
import { agentAttach, agentBriefing, agentGet, agentTell } from "@niwa-labs/agent/records";
import { actionName, agent, grant, principalOf } from "@niwa-labs/core";
import type { Address, Caller } from "@niwa-labs/core";
import { plugin } from "@niwa-labs/plugin";
import type { Plugin } from "@niwa-labs/plugin";
import { memory } from "@niwa-labs/memory";
import { requests } from "@niwa-labs/requests";
import { FAKE_HARNESS, connect, connectAsOwner, createNiwa, eventually, fakeHarness, messages, sessions, tasks, tempHome, timers, workflow } from "@niwa-labs/testing";
import { RunFinished, RunStarted } from "@niwa-labs/workflow/records";

import { RIN_AGENT, addressingOf, rin, rinAttend, rinAttention, rinConversation, rinNotice, rinPlugin } from "../src/index.ts";

const cleanups: Array<() => Promise<void>> = [];
afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
});

test("her plugins are her tools and herself, to install after the agents module", () => {
  const bind = addressingOf([sessions({ harnesses: [] }), agents()]);
  expect(rin({ bind, harness: "claude" }).map((one) => String(one.name))).toEqual(["memory", "commitments", "delegate", "rin"]);
});

test("she cannot be composed without the addressing of the host", () => {
  expect(() => addressingOf([agents()])).toThrow("no sessions module");
  expect(() => addressingOf([sessions({ harnesses: [] })])).toThrow("no agents module");
  expect(() => rin({ harness: "claude" } as never)).toThrow("caller binding");
});

test("on a whole host she is the default agent, and what she holds is in her briefing and brought up at an attach", async () => {
  const home = await tempHome();
  cleanups.push(() => home.cleanup());
  const fake = fakeHarness();
  const sessionsModule = sessions({ harnesses: [fake.binding] });
  const agentsModule = agents({ default: RIN_AGENT });
  const addressing = addressingOf([sessionsModule, agentsModule]);
  // A client with the token of a session "rin" stands for her main session here.
  const bind = (caller: Caller): Address | undefined =>
    caller.kind === "client" && caller.principal?.kind === "session" && String(caller.principal.id) === RIN_AGENT ? agent(RIN_AGENT) : addressing(caller);
  const niwa = createNiwa({ home: home.path });
  cleanups.push(() => niwa.close());
  niwa.use(messages({ bind }), requests({ bind }), tasks({ messages: { bind } }), timers([]), sessionsModule, agentsModule, workflow(), ...rin({ bind, harness: FAKE_HARNESS }));
  await niwa.serve();
  const owner = await connectAsOwner(home.path);
  cleanups.push(() => owner.close());
  const rinSession = await connect({ home: home.path, id: "session:rin", token: niwa.issueToken(principalOf("session", RIN_AGENT), { grant: grant(["rin.*"]) }) });
  cleanups.push(() => rinSession.close());

  const got = await owner.call(agentGet, { agent: RIN_AGENT });
  expect(got.definition.tools).toBe("niwa-only");
  expect(got.definition.hands).toContain("rin.attend");

  const noticed = await owner.call(rinNotice, { key: "task:t-1", kind: "task", text: "The review task is done" });
  const held = await rinSession.call(rinAttend, { subject: { kind: "occasion", occasion: noticed.occasion! }, decision: "next-contact", text: "The review is done: two comments" });
  expect(held.outcome).toBe("held");
  expect((await owner.call(agentBriefing, { agent: RIN_AGENT })).text).toContain("What Rin holds for you:\n- The review is done: two comments");

  const attached = await owner.call(agentAttach, { harness: FAKE_HARNESS, native: "s1", cwd: "/work" });
  expect(attached.agent).toBe(RIN_AGENT);
  expect(attached.briefing).toContain("- The review is done: two comments");
  await eventually(async () => (await owner.call(rinAttention, { status: "brought" })).items.length === 1);
  expect((await owner.call(agentBriefing, { agent: RIN_AGENT })).text).toContain("- The review is done: two comments");
});

/** What Rin needs of a host, each held by a plugin of its own: the agents, the timers, the workflow module, the messages. */
function needed(options: { telegram?: boolean } = {}): Plugin[] {
  const bind = () => undefined;
  return [
    agents(),
    sessions({ harnesses: [] }),
    timers([]),
    plugin("workflow", (api) => api.declare(RunStarted, RunFinished)),
    messages({ bind }),
    requests({ bind }),
    memory({ bind }),
    rinPlugin({ bind, harness: "claude", ...options }),
  ];
}

test("a host with what she needs serves her", async () => {
  const home = await tempHome();
  cleanups.push(() => home.cleanup());
  const niwa = createNiwa({ home: home.path });
  cleanups.push(() => niwa.close());
  niwa.use(...needed());
  await niwa.serve();
});

for (const [missing, what] of [
  ["timers", /plugin "rin" offers "timer"/],
  ["workflow", /"workflow" plugin .*not installed/],
  ["messages", /"message\.sent".*no installed plugin declares it/],
  ["agents", /"agents" plugin .*not installed/],
  ["requests", /plugin "rin" .*request\.ask/],
  ["memory", /plugin "rin" .*memory\.consolidate/],
] as const) {
  test(`a host without ${missing} refuses to serve her and says so`, async () => {
    const home = await tempHome();
    cleanups.push(() => home.cleanup());
    const niwa = createNiwa({ home: home.path });
    cleanups.push(() => niwa.close());
    niwa.use(...needed().filter((one) => String(one.name) !== missing));
    await expect(niwa.serve()).rejects.toThrow(what);
  });
}


test("Telegram delivery requires telegram.send when requested", async () => {
  const home = await tempHome();
  cleanups.push(() => home.cleanup());
  const niwa = createNiwa({ home: home.path });
  cleanups.push(() => niwa.close());
  niwa.use(...needed({ telegram: true }));
  await expect(niwa.serve()).rejects.toThrow(/plugin "rin" .*telegram\.send/);
});

test("Cockpit submits a routed message and reads the reply from the session that got the turn", async () => {
  const home = await tempHome();
  cleanups.push(() => home.cleanup());
  const fake = fakeHarness();
  const control = fake.instance.sides.control!;
  const instance = { ...fake.instance, sides: { ...fake.instance.sides, control: { ...control, tools: { allow: control.tools?.allow ?? false, niwaOnly: true } } } };
  const sessionsModule = sessions({ harnesses: [{ ...fake.binding, instance }], niwaMcp: { command: process.execPath, args: ["-e", ""] } });
  const agentsModule = agents({ default: RIN_AGENT });
  const bind = addressingOf([sessionsModule, agentsModule]);
  const niwa = createNiwa({ home: home.path });
  cleanups.push(() => niwa.close());
  niwa.use(messages({ bind }), requests({ bind }), tasks({ messages: { bind } }), timers([]), sessionsModule, agentsModule, workflow(), ...rin({ bind, harness: FAKE_HARNESS }));
  await niwa.serve();
  const owner = await connectAsOwner(home.path);
  cleanups.push(() => owner.close());
  const replyTo = { channel: "cockpit", conversation: "rin" } as const;
  const { message } = await owner.call(agentTell, { agent: "rin", text: "What shipped?", replyTo });
  await eventually(async () => (await owner.call(rinConversation, {})).messages[0]?.delivery !== "waiting", 1_000);
  const deliveries = (await niwa.records.read()).filter(({ type }) => type === "agent.turn.failed");
  expect(deliveries.map(({ data }) => data)).toEqual([]);
  expect((await owner.call(rinConversation, {})).messages[0]?.delivery).toBe("delivered");
  const { session } = await owner.call(agentGet, { agent: "rin" });
  const records = await niwa.records.read();
  const mark = records.findLast((row) => row.type === "session.marked" && (row.data as { session?: string }).session === session)?.data as { mark: string } | undefined;
  if (mark === undefined) throw new Error("the delivered turn must be bound to a session");
  const token = niwa.issueToken(principalOf("session", mark.mark), { grant: grant(["agent.reply"]) });
  const rinSession = await connect({ home: home.path, id: "rin-session", token });
  cleanups.push(() => rinSession.close());
  await expect(owner.call(actionName("agent.reply"), { turn: message, text: "Forged" })).rejects.toThrow("Only the session");
  await rinSession.call(actionName("agent.reply"), { turn: message, text: "The cutover landed." });
  expect((await owner.call(rinConversation, {})).messages).toMatchObject([
    { turn: message, from: "owner", text: "What shipped?", delivery: "delivered" },
    { turn: message, from: "rin", text: "The cutover landed." },
  ]);
  expect((await owner.call(rinConversation, { conversation: "other" })).messages).toEqual([]);
});
