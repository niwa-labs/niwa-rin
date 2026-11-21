// Rin's composition: her plugins install after the agents module, and a host that lacks what she needs refuses
// to serve and says what to install.

import { afterEach, expect, test } from "bun:test";

import { agents } from "@niwa-labs/agent";
import { AGENT_TYPES, agentBriefing, agentGet } from "@niwa-labs/agent/records";
import { actionName } from "@niwa-labs/core";
import { plugin } from "@niwa-labs/plugin";
import type { Plugin } from "@niwa-labs/plugin";
import { requests } from "@niwa-labs/requests";
import { FAKE_HARNESS, connectAsOwner, createNiwa, fakeHarness, messages, sessions, tasks, tempHome, timers, workflow } from "@niwa-labs/testing";

import { RunFinished, RunStarted } from "@niwa-labs/workflow/records";

import { RIN_AGENT, addressingOf, rin, rinNotice, rinPlugin } from "../src/index.ts";

const cleanups: Array<() => Promise<void>> = [];
afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
});

/** A host of the plugins the composition of the test gives, made from what it is told to leave out. */
async function host(leaveOut: readonly string[] = []) {
  const home = await tempHome();
  cleanups.push(() => home.cleanup());
  const fake = fakeHarness();
  const sessionsModule = sessions({ harnesses: [fake.binding] });
  const agentsModule = agents({ default: RIN_AGENT });
  const base: Plugin[] = [sessionsModule, agentsModule];
  const bind = addressingOf(base);
  const all: Plugin[] = [messages({ bind }), requests({ bind }), tasks({ messages: { bind } }), timers([]), sessionsModule, agentsModule, workflow(), ...rin({ bind, harness: FAKE_HARNESS })];
  const niwa = createNiwa({ home: home.path });
  cleanups.push(() => niwa.close());
  niwa.use(...all.filter((one) => !leaveOut.includes(String(one.name))));
  return { niwa, home: home.path };
}

test("her plugins are her tools and herself, to install after the agents module", () => {
  const bind = addressingOf([sessions({ harnesses: [] }), agents()]);
  expect(rin({ bind, harness: "claude" }).map((one) => String(one.name))).toEqual(["memory", "commitments", "delegate", "rin"]);
});

test("she cannot be composed without the addressing of the host", () => {
  expect(() => addressingOf([agents()])).toThrow("no sessions module");
  expect(() => addressingOf([sessions({ harnesses: [] })])).toThrow("no agents module");
  expect(() => rin({ harness: "claude" } as never)).toThrow("caller binding");
});

test("on a whole host she is the agents module's agent, and her section is in her briefing", async () => {
  const { niwa, home } = await host();
  await niwa.serve();
  const owner = await connectAsOwner(home);
  cleanups.push(() => owner.close());
  const got = await owner.call(agentGet, { agent: RIN_AGENT });
  expect(got.definition.tools).toBe("niwa-only");
  expect(got.definition.hands).toContain("rin.attend");
  await owner.call(rinNotice, { key: "x:1", kind: "test", text: "Something happened" });
  const briefing = await owner.call(agentBriefing, { agent: RIN_AGENT });
  expect(briefing.text).toContain("Agent rin (agent:rin)");
  const catalog = (await niwa.call(actionName("niwa.cockpit.catalog"), {})) as { modules: Array<{ id: string }> };
  expect(catalog.modules.map((one) => one.id)).toContain("commitments");
});

/** What Rin needs of a host, each held by a plugin of its own: the agents, the timers, the workflow module, the messages. */
function needed(): Plugin[] {
  const bind = () => undefined;
  return [
    plugin("agents", (api) => api.declare(...AGENT_TYPES)),
    timers([]),
    plugin("workflow", (api) => api.declare(RunStarted, RunFinished)),
    messages({ bind }),
    requests({ bind }),
    rinPlugin({ bind, harness: "claude" }),
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
  ["workflow", /plugin "rin" .*workflow\.run\.finished/],
  ["messages", /plugin "rin" .*message\.(sent|received)/],
  ["agents", /plugin "rin" offers "agent/],
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
