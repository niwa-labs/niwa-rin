// The core of Rin's character is the owner's text with a version, and her definition follows her options.

import { expect, test } from "bun:test";

import { AgentDefinition } from "@niwa-labs/agent/records";

import { CORE, HANDS, RIN_AGENT, coreDigest, rinDefinition } from "../src/character.ts";

/** The words of each version of the core. A changed text with the same version fails here: give it a new one. */
const VERSIONS: Record<number, string> = { 1: "45ac4b7d9e0acb12" };

test("the core text is pinned to its version", () => {
  expect(coreDigest(CORE.text)).toBe(VERSIONS[CORE.version]!);
});

test("her definition is one the agents module serves, with only niwa's tools", () => {
  const definition = AgentDefinition.parse(rinDefinition({ harness: "claude" }));
  expect(definition.name).toBe(RIN_AGENT);
  expect(definition.character).toBe(CORE.text);
  expect(definition.tools).toBe("niwa-only");
  expect(definition.hands).toEqual([...HANDS]);
  expect(() => rinDefinition({})).toThrow("exactly one");
  expect(() => rinDefinition({ harness: "claude", role: "assistant" })).toThrow("exactly one");
});

test("she changes herself by code only when the owner turned it on, and only plugins of her own group", () => {
  const plain = rinDefinition({ role: "assistant" });
  expect(plain.hands?.some((hand) => hand.startsWith("plugin.install"))).toBe(false);
  expect(plain.hands).not.toContain("rin.self.install");
  expect(plain.prompt).not.toContain("rin.self.install");
  const selfEdit = rinDefinition({ role: "assistant", selfEdit: "ask" });
  // Her hand is her own action, which asks the owner; the host's install, even scoped to her group, asks nobody.
  expect(selfEdit.hands).toContain("rin.self.install");
  expect(selfEdit.hands?.some((hand) => hand.startsWith("plugin.install"))).toBe(false);
  expect(selfEdit.prompt).toContain("rin.self.install");
});

test("her prompt answers when a conversation may make a promise and what of his memory may leave", () => {
  const prompt = rinDefinition({ harness: "claude" }).prompt;
  expect(prompt).toContain("A promise on his behalf, or one that sets him a deadline, exists only when he worded it himself or confirmed");
  expect(prompt).toContain("Notes about the owner himself do not leave without his answer");
});
