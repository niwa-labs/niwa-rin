import { describe, expect, test } from "bun:test";
import { checkGraph, checkPackages, GRAPH, type PackageInput } from "./check-boundaries.ts";

function pkg(
  name: string,
  source: string,
  options: { deps?: Record<string, string>; file?: string; exports?: Record<string, string> } = {},
): PackageInput {
  const dir = `packages/${name.replace(/^@niwa-labs\//, "")}`;
  const entries = GRAPH[name]?.entries ?? ["."];
  const exportsMap: Record<string, string> = {
    ...Object.fromEntries(entries.map((e) => [e, e === "." ? "./src/index.ts" : `./src/${e.slice(2)}.ts`])),
    ...options.exports,
  };
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

  test("the script package offers its api entry", () => {
    expect(GRAPH["@niwa-labs/script"]?.entries).toEqual([".", "./api"]);
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

  test("lets pstack's scripts use the flow libraries and start a session through the records of sessions only", () => {
    const deps = { "@niwa-labs/flow": "*", "@niwa-labs/flow-eval": "*", "@niwa-labs/flow-code": "*", "@niwa-labs/forge": "*", "@niwa-labs/sessions": "*" };
    const source = [
      `import { revise } from "@niwa-labs/flow";`,
      `import { evalSuite } from "@niwa-labs/flow-eval";`,
      `import { makeWorktree } from "@niwa-labs/flow-code";`,
      `import { land } from "@niwa-labs/forge/flow";`,
      `import { sessionStart } from "@niwa-labs/sessions/records";`,
    ].join("\n");
    expect(rules([pkg("@niwa-labs/pstack", source, { deps })])).toEqual([]);
    const root = pkg("@niwa-labs/pstack", `import { sessions } from "@niwa-labs/sessions";`, { deps });
    expect(rules([root])).toEqual(["graph"]);
  });

  test("lets rin read base records, arm a timer and offer a cockpit page", () => {
    const deps = {
      "@niwa-labs/messages": "*",
      "@niwa-labs/workflow": "*",
      "@niwa-labs/timer": "*",
      "@niwa-labs/cockpit-sdk": "*",
    };
    const source = [
      `import { MessageSent } from "@niwa-labs/messages/records";`,
      `import { RunFinished } from "@niwa-labs/workflow/records";`,
      `import { daily } from "@niwa-labs/timer";`,
    ].join("\n");
    const cockpit = { "./cockpit": "./src/cockpit/index.tsx" };
    const rin = pkg("@niwa-labs/rin", source, { deps, exports: cockpit });
    rin.files.push({ path: "packages/rin/src/cockpit/page.tsx", source: `import { useCall } from "@niwa-labs/cockpit-sdk";` });
    expect(rules([rin])).toEqual([]);
    const root = pkg("@niwa-labs/rin", `import { messages } from "@niwa-labs/messages";`, { deps });
    expect(rules([root])).toEqual(["graph"]);
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

  test("lets memory read delegate's records and commitments arm timer's, and nothing more of either", () => {
    const memory = pkg("@niwa-labs/memory", `import type { ContextRequest } from "@niwa-labs/delegate/records";`, {
      deps: { "@niwa-labs/delegate": "*" },
    });
    expect(rules([memory])).toEqual([]);
    const commitments = pkg("@niwa-labs/commitments", `import { TimerFired } from "@niwa-labs/timer/records";`, {
      deps: { "@niwa-labs/timer": "*" },
    });
    expect(rules([commitments])).toEqual([]);
    const root = pkg("@niwa-labs/memory", `import { delegate } from "@niwa-labs/delegate";`, { deps: { "@niwa-labs/delegate": "*" } });
    expect(rules([root])).toEqual(["graph", "plugin-entry"]);
  });

  test("lets workflow carry the script libraries and the builders scripts import by name", () => {
    const deps = {
      "@niwa-labs/flow": "workspace:*",
      "@niwa-labs/flow-code": "workspace:*",
      "@niwa-labs/flow-eval": "workspace:*",
      "@niwa-labs/tasks": "workspace:*",
      "@niwa-labs/history": "workspace:*",
    };
    const workflow = pkg("@niwa-labs/workflow", "export {};", { deps });
    const libraries = ["flow", "flow-code", "flow-eval", "tasks", "history"].map((name) => pkg(`@niwa-labs/${name}`, "export {};"));
    expect(rules([workflow, ...libraries])).toEqual([]);
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

  describe("cockpit modules", () => {
    const COCKPIT_DEPS = { "@niwa-labs/cockpit-sdk": "workspace:*", "@niwa-labs/ui-kit": "workspace:*" };
    const cockpit = { "./cockpit": "./src/cockpit.tsx" };
    const LIBS = [pkg("@niwa-labs/cockpit-sdk", "export {};"), pkg("@niwa-labs/ui-kit", "export {};")];

    test("lets a plugin export a cockpit module built on the SDK, the kit and React", () => {
      const module = pkg(
        "@niwa-labs/requests",
        `import { definePlugin } from "@niwa-labs/cockpit-sdk";
import { Button } from "@niwa-labs/ui-kit";
import { useState } from "react";`,
        { deps: COCKPIT_DEPS, exports: cockpit, file: "src/cockpit.tsx" },
      );
      expect(rules([module, ...LIBS])).toEqual([]);
    });

    test("lets a cockpit module keep its files in a folder", () => {
      const module = pkg("@niwa-labs/requests", `import { definePlugin } from "@niwa-labs/cockpit-sdk";`, {
        deps: COCKPIT_DEPS,
        exports: { "./cockpit": "./src/cockpit/index.tsx" },
        file: "src/cockpit/page.tsx",
      });
      expect(rules([module, ...LIBS])).toEqual([]);
    });

    test("does not require a plugin to export a cockpit module", () => {
      expect(rules([pkg("@niwa-labs/requests", "export {};")])).toEqual([]);
    });

    test("rejects a package that is not a plugin exporting a cockpit module", () => {
      const flow = pkg("@niwa-labs/flow", "export {};", { exports: cockpit });
      expect(rules([flow])).toEqual(["exports"]);
    });

    test("rejects a cockpit export that points at no file", () => {
      const requests = pkg("@niwa-labs/requests", "export {};", { exports: { "./cockpit": "./src/missing.tsx" } });
      requests.files = requests.files.filter((file) => !file.path.endsWith("missing.tsx"));
      expect(rules([requests])).toEqual(["exports"]);
    });

    test("rejects the SDK, the kit and React outside the cockpit module of a plugin", () => {
      for (const specifier of ["@niwa-labs/cockpit-sdk", "@niwa-labs/ui-kit", "react", "react-dom/client", "@tanstack/react-query"]) {
        const requests = pkg("@niwa-labs/requests", `import "${specifier}";`, { deps: COCKPIT_DEPS });
        expect(rules([requests, ...LIBS])).toEqual(["cockpit-entry"]);
      }
    });

    test("rejects host code importing the cockpit module", () => {
      const requests = pkg("@niwa-labs/requests", `import module from "./cockpit.tsx";`, { exports: cockpit });
      expect(rules([requests])).toEqual(["cockpit-entry"]);
      const folder = pkg("@niwa-labs/requests", `import module from "./cockpit";`, { exports: cockpit });
      expect(rules([folder])).toEqual(["cockpit-entry"]);
    });

    test("lets a test import the cockpit module", () => {
      const requests = pkg("@niwa-labs/requests", `import module from "../src/cockpit.tsx";`, {
        exports: cockpit,
        file: "test/cockpit.test.ts",
      });
      expect(rules([requests])).toEqual([]);
    });

    test("keeps a cockpit module under the plugin rules for everything else", () => {
      const requests = pkg("@niwa-labs/requests", `import { start } from "@niwa-labs/sessions";`, {
        deps: { "@niwa-labs/sessions": "workspace:*" },
        exports: cockpit,
        file: "src/cockpit.tsx",
      });
      expect(rules([requests, pkg("@niwa-labs/sessions", "export {};")])).toContain("plugin-entry");
    });

    test("offers the theme of the kit as a stylesheet entry", () => {
      expect(GRAPH["@niwa-labs/ui-kit"]?.entries).toEqual([".", "./theme.css"]);
      const web = pkg("@niwa-labs/cockpit", `import "@niwa-labs/ui-kit/theme.css";`, { deps: { "@niwa-labs/ui-kit": "workspace:*" } });
      expect(rules([web, pkg("@niwa-labs/ui-kit", "export {};")])).toEqual([]);
    });
  });
});
