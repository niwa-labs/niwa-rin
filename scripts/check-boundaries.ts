import { readdirSync } from "node:fs";
import { dirname, join, relative, resolve, sep } from "node:path";
import * as ts from "typescript";

export type Repo = "niwa" | "plugins" | "rin" | "pstack";

// Zones, lowest first. A package may import its own zone or a lower one.
// Leaves (surfaces, compositions, the umbrella, testing) are imported by
// nothing except the umbrella.
export type Zone = "independent" | "foundation" | "built" | "leaf";

export type Kind =
  | "library"
  | "foundation"
  | "plugin"
  | "script-library"
  | "app"
  | "surface"
  | "composition"
  | "testing"
  | "umbrella";

/** "*" allows every exported entry; a list allows only those entries. */
export type EntryAllowance = "*" | readonly string[];

export type PackageSpec = {
  repo: Repo;
  zone: Zone;
  kind: Kind;
  entries: readonly string[];
  deps: Readonly<Record<string, EntryAllowance>>;
};

const ZONE_RANK: Record<Zone, number> = { independent: 0, foundation: 1, built: 2, leaf: 3 };

const ROOT = ["."] as const;
const PLUGIN = [".", "./records"] as const;
const PLUGIN_FLOW = [".", "./records", "./flow"] as const;
const CONTRACTS = { "@niwa-labs/core": ROOT } as const;
const SCRIPT_TYPES = { "@niwa-labs/script": "*" } as const;
const RECORDS = ["./records"] as const;
const ON_HOST = { "@niwa-labs/plugin": "*", ...CONTRACTS } as const;

// History keeps no state of its own: it reads and searches transcripts, and sessions calls it while
// it runs. Sessions may therefore import its root entry, not only its records.
const ROOT_READERS: Readonly<Record<string, readonly string[]>> = { "@niwa-labs/history": ["@niwa-labs/sessions"] };

function lib(deps: PackageSpec["deps"] = {}): PackageSpec {
  return { repo: "niwa", zone: "independent", kind: "library", entries: ROOT, deps };
}

function basePlugin(deps: PackageSpec["deps"] = {}, entries: readonly string[] = PLUGIN): PackageSpec {
  return { repo: "niwa", zone: "built", kind: "plugin", entries, deps: { ...ON_HOST, ...deps } };
}

function extraPlugin(deps: PackageSpec["deps"] = {}, entries: readonly string[] = PLUGIN): PackageSpec {
  return { repo: "plugins", zone: "built", kind: "plugin", entries, deps: { ...ON_HOST, ...deps } };
}

function leaf(kind: Kind, deps: PackageSpec["deps"], repo: Repo = "niwa"): PackageSpec {
  return { repo, zone: "leaf", kind, entries: ROOT, deps };
}

const KIND_DEPS = { ...CONTRACTS, "@niwa-labs/harness": "*", "@niwa-labs/sandbox": "*" } as const;

const NIWA_CORE_GRAPH: Record<string, PackageSpec> = {
  // Zone I: needs no host; at most the contracts entry of core.
  "@niwa-labs/script": lib(),
  "@niwa-labs/flow": lib({ "@niwa-labs/script": "*" }),
  "@niwa-labs/harness": lib({ ...CONTRACTS, "@niwa-labs/sandbox": "*" }),
  "@niwa-labs/acp": lib({ ...CONTRACTS, "@niwa-labs/harness": "*" }),
  "@niwa-labs/harness-claude": lib({ ...KIND_DEPS, "@niwa-labs/acp": "*" }),
  "@niwa-labs/harness-mcode": lib({ ...KIND_DEPS, "@niwa-labs/acp": "*" }),
  "@niwa-labs/harness-codex": lib(KIND_DEPS),
  "@niwa-labs/harness-pi": lib(KIND_DEPS),
  "@niwa-labs/harness-zcode": lib(KIND_DEPS),
  "@niwa-labs/digest": lib({ "@niwa-labs/harness": "*" }),
  "@niwa-labs/sandbox": lib(),
  "@niwa-labs/ui-kit": lib(),

  // Zone II: the foundation.
  "@niwa-labs/core": { repo: "niwa", zone: "foundation", kind: "foundation", entries: [".", "./journal"], deps: {} },
  "@niwa-labs/plugin": { repo: "niwa", zone: "foundation", kind: "foundation", entries: ROOT, deps: CONTRACTS },
  "@niwa-labs/client": { repo: "niwa", zone: "foundation", kind: "foundation", entries: ROOT, deps: CONTRACTS },
  "@niwa-labs/host": {
    repo: "niwa",
    zone: "foundation",
    kind: "foundation",
    entries: ROOT,
    deps: { "@niwa-labs/core": "*", "@niwa-labs/plugin": "*", "@niwa-labs/client": "*" },
  },

  // Zone III: base plugins.
  "@niwa-labs/requests": basePlugin(),
  "@niwa-labs/tasks": basePlugin({ "@niwa-labs/messages": "*" }),
  "@niwa-labs/timer": basePlugin(),
  "@niwa-labs/git": basePlugin(SCRIPT_TYPES),
  "@niwa-labs/proc": basePlugin({}, PLUGIN_FLOW),
  "@niwa-labs/history": basePlugin({ "@niwa-labs/harness": "*", "@niwa-labs/digest": "*" }, PLUGIN_FLOW),
  "@niwa-labs/sessions": basePlugin({
    "@niwa-labs/history": "*",
    "@niwa-labs/requests": "*",
    "@niwa-labs/git": "*",
    "@niwa-labs/harness": "*",
    "@niwa-labs/sandbox": "*",
  }),
  "@niwa-labs/messages": basePlugin({ "@niwa-labs/sessions": "*" }),
  "@niwa-labs/agent": basePlugin({
    "@niwa-labs/sessions": "*",
    "@niwa-labs/history": "*",
    "@niwa-labs/messages": "*",
    "@niwa-labs/requests": "*",
    "@niwa-labs/tasks": "*",
    ...SCRIPT_TYPES,
  }),
  "@niwa-labs/workflow": basePlugin({
    "@niwa-labs/harness": "*",
    "@niwa-labs/sessions": "*",
    "@niwa-labs/git": "*",
    "@niwa-labs/requests": "*",
    "@niwa-labs/messages": "*",
    "@niwa-labs/timer": "*",
    "@niwa-labs/script": "*",
    "@niwa-labs/sandbox": "*",
  }),

  // Zone III: script libraries and the cockpit SDK.
  "@niwa-labs/flow-code": {
    repo: "niwa",
    zone: "built",
    kind: "script-library",
    entries: ROOT,
    deps: { "@niwa-labs/flow": "*", "@niwa-labs/git": "*", "@niwa-labs/proc": "*" },
  },
  "@niwa-labs/flow-eval": { repo: "niwa", zone: "built", kind: "script-library", entries: ROOT, deps: { "@niwa-labs/flow": "*" } },
  "@niwa-labs/cockpit-sdk": {
    repo: "niwa",
    zone: "built",
    kind: "library",
    entries: ROOT,
    deps: { "@niwa-labs/client": "*", "@niwa-labs/ui-kit": "*" },
  },

  // Leaves: the cockpit app, surfaces, testing.
  "@niwa-labs/cockpit": leaf("app", { "@niwa-labs/cockpit-sdk": "*", "@niwa-labs/ui-kit": "*", "@niwa-labs/client": "*" }),
  "@niwa-labs/cli": leaf("surface", { "@niwa-labs/client": "*", ...CONTRACTS }),
  "@niwa-labs/mcp": leaf("surface", { "@niwa-labs/client": "*", ...CONTRACTS }),
  "@niwa-labs/web": leaf("surface", { "@niwa-labs/client": "*", ...CONTRACTS }),
  "@niwa-labs/telegram": leaf("surface", {
    "@niwa-labs/client": "*",
    "@niwa-labs/plugin": "*",
    "@niwa-labs/messages": "*",
    "@niwa-labs/requests": "*",
    ...CONTRACTS,
  }),
  "@niwa-labs/testing": leaf("testing", {
    "@niwa-labs/host": "*",
    "@niwa-labs/harness": "*",
    "@niwa-labs/workflow": "*",
    "@niwa-labs/client": "*",
    "@niwa-labs/sandbox": "*",
    "@niwa-labs/requests": "*",
    "@niwa-labs/tasks": "*",
    "@niwa-labs/timer": "*",
    "@niwa-labs/git": "*",
    "@niwa-labs/history": "*",
    "@niwa-labs/messages": "*",
    "@niwa-labs/sessions": "*",
    "@niwa-labs/plugin": "*",
    ...CONTRACTS,
  }),
};

const OTHER_REPOS_GRAPH: Record<string, PackageSpec> = {
  "@niwa-labs/forge": extraPlugin({}, PLUGIN_FLOW),
  "@niwa-labs/watch": extraPlugin(),
  "@niwa-labs/evidence": extraPlugin(),
  "@niwa-labs/plan": extraPlugin(),
  "@niwa-labs/memory": extraPlugin({
    "@niwa-labs/requests": RECORDS,
    "@niwa-labs/agent": RECORDS,
    ...SCRIPT_TYPES,
  }),
  "@niwa-labs/commitments": extraPlugin({
    "@niwa-labs/agent": RECORDS,
    "@niwa-labs/requests": RECORDS,
    "@niwa-labs/tasks": RECORDS,
    ...SCRIPT_TYPES,
  }),
  "@niwa-labs/delegate": extraPlugin({
    "@niwa-labs/requests": RECORDS,
    "@niwa-labs/workflow": RECORDS,
    ...SCRIPT_TYPES,
  }),

  // Compositions assemble their modules, so they import factories directly.
  "@niwa-labs/rin": leaf(
    "composition",
    {
      "@niwa-labs/agent": "*",
      "@niwa-labs/memory": "*",
      "@niwa-labs/commitments": "*",
      "@niwa-labs/delegate": "*",
      "@niwa-labs/history": "*",
      ...SCRIPT_TYPES,
      ...ON_HOST,
    },
    "rin",
  ),
  "@niwa-labs/pstack": leaf(
    "composition",
    {
      "@niwa-labs/forge": "*",
      "@niwa-labs/watch": "*",
      "@niwa-labs/evidence": "*",
      "@niwa-labs/plan": "*",
      "@niwa-labs/flow-code": "*",
      ...SCRIPT_TYPES,
      ...ON_HOST,
    },
    "pstack",
  ),
};

const UMBRELLA_DEPS: Record<string, EntryAllowance> = Object.fromEntries(
  Object.entries(NIWA_CORE_GRAPH)
    .filter(([name]) => name !== "@niwa-labs/testing")
    .map(([name]) => [name, "*"]),
);

export const GRAPH: Readonly<Record<string, PackageSpec>> = {
  ...NIWA_CORE_GRAPH,
  ...OTHER_REPOS_GRAPH,
  niwa: leaf("umbrella", UMBRELLA_DEPS),
};

export const TESTING_PACKAGE = "@niwa-labs/testing";

export type SourceFile = { path: string; source: string };

export type PackageInput = {
  /** Directory of the package, relative to the repository root. */
  dir: string;
  manifest: {
    name?: string;
    exports?: Record<string, string>;
    dependencies?: Record<string, string>;
    devDependencies?: Record<string, string>;
    peerDependencies?: Record<string, string>;
  };
  /** Every file of the package, paths relative to the repository root. */
  files: SourceFile[];
};

export type Violation = { file: string; rule: string; message: string };

type Rule =
  | "unknown-package"
  | "exports"
  | "manifest-dependency"
  | "internal-file"
  | "undeclared"
  | "zone"
  | "graph"
  | "plugin-entry";

/** Splits `@niwa-labs/x/sub` or `niwa/sub` into a package name and an export key. */
export function parseSpecifier(specifier: string): { name: string; entry: string } | null {
  const parts = specifier.split("/");
  if (parts[0] === "@niwa-labs" && parts.length >= 2) {
    const rest = parts.slice(2).join("/");
    return { name: `@niwa-labs/${parts[1]}`, entry: rest === "" ? "." : `./${rest}` };
  }
  if (parts[0] === "niwa") {
    const rest = parts.slice(1).join("/");
    return { name: "niwa", entry: rest === "" ? "." : `./${rest}` };
  }
  return null;
}

export function importsOf(source: string): string[] {
  return ts.preProcessFile(source, true, true).importedFiles.map((f) => f.fileName);
}

function isTestFile(path: string): boolean {
  return /\.test\.tsx?$/.test(path) || path.split("/").includes("test");
}

function isFlowFile(pkgDir: string, path: string): boolean {
  const inside = relative(pkgDir, path).split(sep).join("/");
  return inside === "src/flow.ts" || inside.startsWith("src/flow/");
}

function declaredDeps(manifest: PackageInput["manifest"]): Record<string, string> {
  return { ...manifest.peerDependencies, ...manifest.devDependencies, ...manifest.dependencies };
}

function entryAllowed(allowance: EntryAllowance | undefined, entry: string): boolean {
  if (allowance === undefined) return false;
  return allowance === "*" || allowance.includes(entry);
}

/** Zone I may reach the foundation only through the contracts entry of core. */
function zoneException(from: PackageSpec, to: string, entry: string): boolean {
  return from.zone === "independent" && to === "@niwa-labs/core" && entry === ".";
}

export function checkPackages(
  packages: PackageInput[],
  graph: Readonly<Record<string, PackageSpec>> = GRAPH,
): Violation[] {
  const violations: Violation[] = [];
  const report = (file: string, rule: Rule, message: string) => violations.push({ file, rule, message });
  const local = new Set(packages.map((p) => p.manifest.name));

  for (const pkg of packages) {
    const manifestPath = join(pkg.dir, "package.json");
    const name = pkg.manifest.name;
    const spec = name === undefined ? undefined : graph[name];
    if (name === undefined || spec === undefined) {
      report(manifestPath, "unknown-package", `${name ?? pkg.dir} is not in the package graph`);
      continue;
    }

    const exported = Object.keys(pkg.manifest.exports ?? {}).sort();
    const expected = [...spec.entries].sort();
    if (exported.join() !== expected.join()) {
      report(manifestPath, "exports", `${name} must export exactly ${expected.join(", ")}`);
    }
    const filePaths = new Set(pkg.files.map((f) => f.path));
    for (const [key, target] of Object.entries(pkg.manifest.exports ?? {})) {
      if (!filePaths.has(join(pkg.dir, target))) {
        report(manifestPath, "exports", `${name} export ${key} points to missing ${target}`);
      }
    }

    const declared = declaredDeps(pkg.manifest);
    for (const [dep, range] of Object.entries(declared)) {
      if (parseSpecifier(dep) === null) continue;
      const isTesting = dep === TESTING_PACKAGE && pkg.manifest.devDependencies?.[dep] !== undefined;
      if (spec.deps[dep] === undefined && !isTesting) {
        report(manifestPath, "manifest-dependency", `${name} declares ${dep}, which the graph does not allow`);
      }
      const want = local.has(dep) ? "workspace:*" : "*";
      if (range !== want) {
        report(manifestPath, "manifest-dependency", `${name} must declare ${dep} as "${want}"`);
      }
    }

    for (const file of pkg.files) {
      if (!/\.(ts|tsx|mts|cts)$/.test(file.path)) continue;
      for (const specifier of importsOf(file.source)) {
        if (specifier.startsWith(".")) {
          const target = resolve("/", dirname(file.path), specifier);
          const root = resolve("/", pkg.dir);
          if (target !== root && !target.startsWith(root + sep)) {
            report(file.path, "internal-file", `${specifier} reaches outside ${name}; import a package entry instead`);
          }
          continue;
        }
        const parsed = parseSpecifier(specifier);
        if (parsed === null || parsed.name === name) continue;
        const target = graph[parsed.name];
        if (target === undefined) {
          report(file.path, "unknown-package", `${parsed.name} is not in the package graph`);
          continue;
        }
        if (!target.entries.includes(parsed.entry)) {
          report(file.path, "internal-file", `${specifier} is not an exported entry of ${parsed.name}`);
          continue;
        }
        if (declared[parsed.name] === undefined) {
          report(file.path, "undeclared", `${name} imports ${parsed.name} without declaring it in package.json`);
        }
        if (parsed.name === TESTING_PACKAGE && isTestFile(file.path)) continue;

        if (target.zone === "leaf" && spec.kind !== "umbrella") {
          report(file.path, "zone", `${parsed.name} is a leaf; only the umbrella may import it`);
        } else if (ZONE_RANK[target.zone] > ZONE_RANK[spec.zone] && !zoneException(spec, parsed.name, parsed.entry)) {
          report(file.path, "zone", `${name} (${spec.zone}) must not import ${parsed.name} (${target.zone})`);
        }

        if (!entryAllowed(spec.deps[parsed.name], parsed.entry)) {
          report(file.path, "graph", `${name} may not import ${specifier} per the package graph`);
        }

        if (target.kind === "plugin" && (spec.kind === "plugin" || spec.kind === "script-library")) {
          const scripted = spec.kind === "script-library" || isFlowFile(pkg.dir, file.path);
          const reads = parsed.entry === "." && (ROOT_READERS[parsed.name] ?? []).includes(name);
          const ok = parsed.entry === "./records" || reads || (scripted && parsed.entry === "./flow");
          if (!ok) {
            const allowed = scripted ? "/records or /flow" : "/records";
            report(file.path, "plugin-entry", `${name} must import plugin ${parsed.name} only through ${allowed}`);
          }
        }
      }
    }
  }
  return violations;
}

/** Checks that the graph data itself obeys the zone and plugin rules. */
export function checkGraph(graph: Readonly<Record<string, PackageSpec>> = GRAPH): string[] {
  const problems: string[] = [];
  for (const [name, spec] of Object.entries(graph)) {
    for (const entry of spec.entries) {
      if (entry !== "." && !entry.startsWith("./")) problems.push(`${name}: bad entry ${entry}`);
    }
    for (const [dep, allowance] of Object.entries(spec.deps)) {
      const target = graph[dep];
      if (target === undefined) {
        problems.push(`${name} -> ${dep}: unknown package`);
        continue;
      }
      if (allowance !== "*") {
        for (const entry of allowance) {
          if (!target.entries.includes(entry)) problems.push(`${name} -> ${dep}: ${entry} is not exported`);
        }
      }
      const entries = allowance === "*" ? target.entries : allowance;
      if (target.zone === "leaf" && spec.kind !== "umbrella") {
        problems.push(`${name} -> ${dep}: leaf dependency`);
      } else if (
        ZONE_RANK[target.zone] > ZONE_RANK[spec.zone] &&
        !entries.every((entry) => zoneException(spec, dep, entry))
      ) {
        problems.push(`${name} -> ${dep}: upward dependency`);
      }
    }
  }
  return problems;
}

async function readRepository(root: string): Promise<PackageInput[]> {
  const packages: PackageInput[] = [];
  const dirs = readdirSync(join(root, "packages"), { withFileTypes: true }).filter((d) => d.isDirectory());
  for (const entry of dirs) {
    const dir = join("packages", entry.name);
    const manifestFile = Bun.file(join(root, dir, "package.json"));
    const manifest = (await manifestFile.exists()) ? ((await manifestFile.json()) as PackageInput["manifest"]) : {};
    const files: SourceFile[] = [];
    for await (const path of new Bun.Glob(`${dir}/**/*`).scan({ cwd: root })) {
      if (path.split("/").includes("node_modules")) continue;
      const source = /\.(ts|tsx|mts|cts)$/.test(path) ? await Bun.file(join(root, path)).text() : "";
      files.push({ path, source });
    }
    packages.push({ dir, manifest, files });
  }
  return packages;
}

if (import.meta.main) {
  const root = resolve(import.meta.dir, "..");
  const problems = checkGraph();
  for (const problem of problems) console.error(`graph: ${problem}`);
  const violations = checkPackages(await readRepository(root));
  for (const v of violations) console.error(`${v.file}: [${v.rule}] ${v.message}`);
  if (problems.length > 0 || violations.length > 0) process.exit(1);
  console.log("boundaries ok");
}
