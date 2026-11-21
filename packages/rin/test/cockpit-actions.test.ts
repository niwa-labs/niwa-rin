// The copies of the actions Rin's page keeps read what the host answers and send what it takes, and the plugin
// offers the page to the cockpit.

import { afterEach, expect, test } from "bun:test";

import { agentList, agentTell } from "@niwa-labs/agent/records";
import { commitmentList } from "@niwa-labs/commitments/records";
import { actionName } from "@niwa-labs/core";
import { memoryTop } from "@niwa-labs/memory/records";
import { plugin } from "@niwa-labs/plugin";
import { createNiwa, messages, tempHome, timers, unreadable, unsendable } from "@niwa-labs/testing";
import { AGENT_TYPES } from "@niwa-labs/agent/records";
import { RunFinished, RunStarted } from "@niwa-labs/workflow/records";

import { agentsAction, attentionAction, charterAction, commitmentsAction, dismissAction, memoryAction, retireAction, tellAction } from "../src/cockpit/actions.ts";
import { rinAttention, rinCharter, rinCharterRetire, rinDismiss } from "../src/records.ts";
import { rinPlugin } from "../src/plugin.ts";

const pairs = [
  [attentionAction, rinAttention],
  [dismissAction, rinDismiss],
  [charterAction, rinCharter],
  [retireAction, rinCharterRetire],
  [tellAction, agentTell],
  [agentsAction, agentList],
  [commitmentsAction, commitmentList],
  [memoryAction, memoryTop],
] as const;

for (const [copy, real] of pairs) {
  test(`the page reads and calls ${String(real.name)} as the host serves it`, () => {
    expect(String(copy.name)).toBe(String(real.name));
    expect(unsendable(copy.input, real.input as never)).toEqual([]);
    expect(unreadable(copy.output, real.output as never)).toEqual([]);
  });
}

const cleanups: Array<() => Promise<void>> = [];
afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
});

test("the plugin offers her page to the cockpit", async () => {
  const home = await tempHome();
  cleanups.push(() => home.cleanup());
  const niwa = createNiwa({ home: home.path });
  cleanups.push(() => niwa.close());
  const bind = () => undefined;
  niwa.use(
    plugin("agents", (api) => api.declare(...AGENT_TYPES)),
    timers([]),
    plugin("workflow", (api) => api.declare(RunStarted, RunFinished)),
    messages({ bind }),
    rinPlugin({ bind, harness: "claude" }),
  );
  await niwa.serve();
  const catalog = (await niwa.call(actionName("niwa.cockpit.catalog"), {})) as { modules: Array<{ id: string; package: string }> };
  expect(catalog.modules.map((one) => one.id)).toContain("rin");
});
