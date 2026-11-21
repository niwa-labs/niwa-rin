/**
 * The actions Rin's page calls: the name and the part of each schema the page reads.
 *
 * The module runs in the browser and cannot import the host-side schemas, which reach for Node. A field the host
 * stopped sending fails the page that reads it, which `test/cockpit-actions.test.ts` checks against the real
 * actions.
 */

import { z } from "zod";

export const ItemStatus = z.enum(["held", "sending", "unsure", "said", "brought", "dropped", "dismissed"]);

export const AttentionView = z.object({
  item: z.string(),
  text: z.string(),
  status: ItemStatus,
  why: z.enum(["next-contact", "quiet-hours", "ceiling", "undelivered"]).optional(),
  kind: z.string().optional(),
  count: z.number().optional(),
  at: z.number(),
});
export type AttentionView = z.infer<typeof AttentionView>;

export const RuleView = z.object({
  rule: z.string(),
  about: z.string(),
  text: z.string(),
  status: z.enum(["proposed", "ruled", "declined", "retired"]),
  corrections: z.array(z.string()),
});
export type RuleView = z.infer<typeof RuleView>;

export const attentionAction = {
  name: "rin.attention.list",
  input: z.object({}),
  output: z.object({ items: z.array(AttentionView) }),
} as const;

export const dismissAction = {
  name: "rin.attention.dismiss",
  input: z.object({ item: z.string(), reason: z.string().optional() }),
  output: z.object({ item: z.string() }),
} as const;

export const charterAction = {
  name: "rin.charter",
  input: z.object({}),
  output: z.object({ rules: z.array(RuleView), corrections: z.array(z.object({ correction: z.string(), about: z.string(), what: z.string() })) }),
} as const;

export const retireAction = {
  name: "rin.charter.retire",
  input: z.object({ rule: z.string() }),
  output: z.object({ rule: z.string() }),
} as const;

export const tellAction = {
  name: "agent.tell",
  input: z.object({ agent: z.string(), text: z.string() }),
  output: z.object({ message: z.string() }),
} as const;

export const AgentView = z.object({ name: z.string(), status: z.enum(["new", "working", "asleep"]), source: z.enum(["config", "runtime"]) });
export type AgentView = z.infer<typeof AgentView>;

export const agentsAction = {
  name: "agent.list",
  input: z.object({}),
  output: z.object({ items: z.array(AgentView) }),
} as const;

export const commitmentsAction = {
  name: "commitment.list",
  input: z.object({ to: z.string().optional() }),
  output: z.object({ items: z.array(z.object({ id: z.string(), description: z.string(), status: z.string(), due: z.number().optional() })) }),
} as const;

export const memoryAction = {
  name: "memory.top",
  input: z.object({ memory: z.string() }),
  output: z.object({ text: z.string() }),
} as const;
