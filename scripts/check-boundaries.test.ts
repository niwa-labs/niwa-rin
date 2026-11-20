import { describe, expect, test } from "bun:test";
import { checkGraph, checkPackages, GRAPH, type PackageInput } from "./check-boundaries.ts";

function pkg(
  name: string,
  source: string,
  options: { deps?: Record<string, string>; file?: string } = {},
): PackageInput {
  const dir = `packages/${name.replace(/^@niwa-labs\//, "")}`;
  const entries = GRAPH[name]?.entries ?? ["."];
  const exportsMap = Object.fromEntries(
    entries.map((e) => [e, e === "." ? "./src/index.ts" : `./src/${e.slice(2)}.ts`]),
  );
  const files = Object.values(exportsMap).map((target) => ({ path: `${dir}/${target.slice(2)}`, source: "export {};" }));
  files.push({ path: `${dir}/${options.file ?? "src/main.ts"}`, source });
  return { dir, manifest: { name, exports: exportsMap, dependencies: options.deps ?? {} }, files };
}

function rules(packages: PackageInput[]): string[] {
  return checkPackages(packages).map((v) => v.rule);
}

describe("check-boundaries", () => {
  test("the graph data obeys its own zone rules", () => {
    expect(checkGraph()).toEqual([]);
  });

  test("accepts an import through a declared, exported entry", () => {
    const sessions = pkg("@niwa-labs/sessions", `import type { X } from "@niwa-labs/history/records";`, {
      deps: { "@niwa-labs/history": "workspace:*" },
    });
    const history = pkg("@niwa-labs/history", "export {};");
    expect(rules([sessions, history])).toEqual([]);
  });

  test("rejects a deep import of another package's internal file", () => {
    const flow = pkg("@niwa-labs/flow", `import { x } from "@niwa-labs/script/src/types.ts";`, {
      deps: { "@niwa-labs/script": "*" },
    });
    expect(rules([flow])).toEqual(["internal-file"]);
  });

  test("rejects a relative import that leaves the package", () => {
    const flow = pkg("@niwa-labs/flow", `import { x } from "../../script/src/index.ts";`);
    expect(rules([flow])).toEqual(["internal-file"]);
  });

  test("rejects a lower zone importing an upper one", () => {
    const sandbox = pkg("@niwa-labs/sandbox", `import type { Host } from "@niwa-labs/host";`, { deps: { "@niwa-labs/host": "*" } });
    expect(rules([sandbox])).toContain("zone");
  });

  test("lets zone I reach only the contracts entry of core", () => {
    const ok = pkg("@niwa-labs/harness", `import type { Json } from "@niwa-labs/core";`, { deps: { "@niwa-labs/core": "*" } });
    expect(rules([ok])).toEqual([]);
    const journal = pkg("@niwa-labs/harness", `import type { Db } from "@niwa-labs/core/journal";`, {
      deps: { "@niwa-labs/core": "*" },
    });
    expect(rules([journal])).toEqual(["zone", "graph"]);
  });

  test("rejects importing a leaf", () => {
    const agent = pkg("@niwa-labs/agent", `import "@niwa-labs/cli";`, { deps: { "@niwa-labs/cli": "*" } });
    expect(rules([agent])).toContain("zone");
  });

  test("rejects a plugin importing another plugin outside /records", () => {
    const messages = pkg("@niwa-labs/messages", `import { start } from "@niwa-labs/sessions";`, {
      deps: { "@niwa-labs/sessions": "*" },
    });
    expect(rules([messages])).toEqual(["plugin-entry"]);
    const viaFlow = pkg("@niwa-labs/history", `import { x } from "@niwa-labs/proc/flow";`, { deps: { "@niwa-labs/proc": "*" } });
    expect(rules([viaFlow])).toContain("plugin-entry");
  });

  test("lets sessions import the root entry of history, and no other plugin may", () => {
    const sessions = pkg("@niwa-labs/sessions", `import { readTranscript } from "@niwa-labs/history";`, {
      deps: { "@niwa-labs/history": "workspace:*" },
    });
    const history = pkg("@niwa-labs/history", "export {};");
    expect(rules([sessions, history])).toEqual([]);
    const agent = pkg("@niwa-labs/agent", `import { readTranscript } from "@niwa-labs/history";`, {
      deps: { "@niwa-labs/history": "workspace:*" },
    });
    expect(rules([agent, history])).toEqual(["plugin-entry"]);
  });

  test("lets testing build plugins on the plugin package", () => {
    const testing = pkg("@niwa-labs/testing", `import { plugin } from "@niwa-labs/plugin";`, {
      deps: { "@niwa-labs/plugin": "workspace:*" },
    });
    expect(rules([testing, pkg("@niwa-labs/plugin", "export {};")])).toEqual([]);
  });

  test("allows /flow of a plugin from scripts", () => {
    const flowCode = pkg("@niwa-labs/flow-code", `import { runCheck } from "@niwa-labs/proc/flow";`, {
      deps: { "@niwa-labs/proc": "*" },
    });
    expect(rules([flowCode])).toEqual([]);
  });

  test("lets a composition import plugin factories directly", () => {
    const rin = pkg("@niwa-labs/rin", `import { memory } from "@niwa-labs/memory";`, { deps: { "@niwa-labs/memory": "*" } });
    expect(rules([rin])).toEqual([]);
  });

  test("lets tasks read message records but not the messages plugin itself", () => {
    const deps = { "@niwa-labs/messages": "workspace:*" };
    const ok = pkg("@niwa-labs/tasks", `import type { Message } from "@niwa-labs/messages/records";`, { deps });
    expect(rules([ok, pkg("@niwa-labs/messages", "export {};")])).toEqual([]);
    const root = pkg("@niwa-labs/tasks", `import { messages } from "@niwa-labs/messages";`, { deps });
    expect(rules([root, pkg("@niwa-labs/messages", "export {};")])).toEqual(["plugin-entry"]);
  });

  test("lets extra plugins read base records only", () => {
    const deps = { "@niwa-labs/agent": "*" };
    const ok = pkg("@niwa-labs/memory", `import type { Mailbox } from "@niwa-labs/agent/records";`, { deps });
    expect(rules([ok])).toEqual([]);
    const root = pkg("@niwa-labs/memory", `import { agent } from "@niwa-labs/agent";`, { deps });
    expect(rules([root])).toEqual(["graph", "plugin-entry"]);
    const tasks = pkg("@niwa-labs/memory", `import type { Task } from "@niwa-labs/tasks/records";`, {
      deps: { "@niwa-labs/tasks": "*" },
    });
    expect(rules([tasks])).toContain("graph");
  });

  test("lets harness kinds use core and sandbox", () => {
    const deps = { "@niwa-labs/core": "*", "@niwa-labs/sandbox": "*", "@niwa-labs/harness": "*" };
    const kind = pkg(
      "@niwa-labs/harness-pi",
      `import type { Timestamp } from "@niwa-labs/core";\nimport { spawnAgent } from "@niwa-labs/sandbox";`,
      { deps },
    );
    expect(rules([kind])).toEqual([]);
  });

  test("keeps the web surface off the host", () => {
    const web = pkg("@niwa-labs/web", `import { createNiwa } from "@niwa-labs/host";`, { deps: { "@niwa-labs/host": "*" } });
    expect(rules([web])).toContain("graph");
  });

  test("rejects an import of a package missing from package.json", () => {
    const flow = pkg("@niwa-labs/flow", `import type { FlowRuntime } from "@niwa-labs/script";`);
    expect(rules([flow])).toEqual(["undeclared"]);
  });

  test("catches type-only and re-export imports", () => {
    const flow = pkg("@niwa-labs/flow", `export type { A } from "@niwa-labs/script";`);
    expect(rules([flow])).toEqual(["undeclared"]);
  });

  test("rejects a package that is not in the graph", () => {
    expect(rules([pkg("@niwa-labs/unknown", "export {};")])).toEqual(["unknown-package"]);
  });

  test("rejects a manifest dependency outside the graph", () => {
    const flow = pkg("@niwa-labs/flow", "export {};", { deps: { "@niwa-labs/host": "*" } });
    expect(rules([flow])).toEqual(["manifest-dependency"]);
  });
});
