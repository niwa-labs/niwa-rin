/**
 * Rin's composition: the plugins a host installs to have her, in the order it installs them.
 *
 * Rin is built on the agents module and uses memory, commitments and delegation as her tools. What she needs of
 * the host besides is not hers to install: addressing (the binding by which her sessions speak as `agent:rin`),
 * the timers, the workflow module, and message delivery (the messages module, and an action that tells the owner
 * something now, `telegram.send` by default). A host that lacks the timers, the workflow module or the messages
 * refuses to serve and says what to install; the binding is an option she cannot do without.
 *
 * ```ts
 * const base = defaultComposition({ home, harnesses, agents: { default: RIN_AGENT, roles } });
 * export default [...base, telegram({ ... }), ...rin({ bind: addressingOf(base), role: "assistant" })];
 * ```
 */

import { commitments } from "@niwa-labs/commitments";
import { delegate } from "@niwa-labs/delegate";
import type { DelegateOptions } from "@niwa-labs/delegate";
import { memory } from "@niwa-labs/memory";
import type { MemoryLimits } from "@niwa-labs/memory";
import { memoryContext } from "@niwa-labs/memory/records";
import type { CallerBinding, Plugin } from "@niwa-labs/plugin";

import { RIN_AGENT } from "./character.ts";
import { rinPlugin } from "./plugin.ts";
import type { RinOptions } from "./plugin.ts";

/** What Rin's composition is made with: her own options, and those of her tools. */
export interface RinCompositionOptions extends RinOptions {
  /** How much her memory holds and shows. */
  readonly memory?: Partial<MemoryLimits>;
  /** How long after its deadline a promise not kept is missed. */
  readonly commitmentGraceMs?: number;
  /** The judges of areas she answers for, and how long each has before the question goes on to the owner. */
  readonly judges?: DelegateOptions["judges"];
  readonly judgeWaitMs?: number;
}

/** What Rin needs of the host besides the plugins of her composition. */
export const RIN_NEEDS = {
  /** The binding by which her sessions speak as `agent:rin`: the one the messages module is given. */
  addressing: "the caller binding of the sessions and agents modules",
  /** The timers: the end of the owner's quiet hours, and the deadlines of promises. */
  timer: "@niwa-labs/timer",
  /** The workflow module: the digests of attached sessions, and the runs she starts. */
  workflow: "@niwa-labs/workflow",
  /** Message delivery: the owner's messages to her, and an action that tells him something now. */
  delivery: ["@niwa-labs/messages", "telegram.send"],
} as const;

/** Rin's plugins, to install after the agents module: her memory, commitments, delegation, and Rin herself. */
export function rin(options: RinCompositionOptions): Plugin[] {
  if (typeof options.bind !== "function") {
    throw new TypeError("rin: she needs the caller binding of the host (addressingOf), so that her sessions speak as agent:rin");
  }
  const { bind } = options;
  return [
    memory({ bind, ...(options.memory === undefined ? {} : { limits: options.memory }) }),
    commitments({ messages: { bind }, ...(options.commitmentGraceMs === undefined ? {} : { graceMs: options.commitmentGraceMs }) }),
    delegate({
      agent: RIN_AGENT,
      messages: { bind },
      context: [memoryContext.name],
      ...(options.judges === undefined ? {} : { judges: options.judges }),
      ...(options.judgeWaitMs === undefined ? {} : { judgeWaitMs: options.judgeWaitMs }),
    }),
    rinPlugin(options),
  ];
}

/** A plugin that hands out the binding of its callers. */
type Binding = Plugin & { bind(fallback?: CallerBinding): CallerBinding };

function bindingPlugin(plugins: readonly Plugin[], name: string): Binding | undefined {
  const found = plugins.find((one) => String(one.name) === name);
  return found !== undefined && typeof (found as Partial<Binding>).bind === "function" ? (found as Binding) : undefined;
}

/**
 * The addressing of a host's plugins: the binding of the sessions module wrapped by the agents module's, so a
 * session the agents module started for Rin speaks as `agent:rin` and the owner's client as the owner.
 */
export function addressingOf(plugins: readonly Plugin[]): CallerBinding {
  const sessions = bindingPlugin(plugins, "sessions");
  const agents = bindingPlugin(plugins, "agents");
  if (sessions === undefined || agents === undefined) {
    throw new TypeError(`rin: the host has no ${sessions === undefined ? "sessions" : "agents"} module to address her sessions by; install it before her`);
  }
  return agents.bind(sessions.bind());
}
