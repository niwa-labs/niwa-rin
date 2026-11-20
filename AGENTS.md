# rin

`@niwa-labs/rin`: Rin, an agent living inside niwa. Her character, judgement,
attention and cockpit page live here; memory, commitments, delegation and agent
mechanics come from other packages.

## Layout

- `packages/<name>/` is the package `@niwa-labs/<name>`.
  `src/index.ts` is its root entry; `src/records.ts` (record types and action
  references), `src/flow.ts` (script helpers) and `src/journal.ts` back the
  extra entries of the packages that export them.
- Dependencies on `@niwa-labs/*` are `workspace:*` inside this repository and `*`
  across repositories.
- `scripts/check-boundaries.ts` holds the module map and the import rules.

## Commands

```sh
bun install
bun run typecheck          # tsc --noEmit -p .
bun test
bun run check:boundaries
```

All three checks must pass before a commit.

## Import boundaries

Zones, lowest first: packages that need no host, the foundation, packages built
on niwa (plugins, script libraries, the cockpit SDK), and leaves (the cockpit
app, surfaces, compositions, `testing`, the umbrella). The check fails when a
package:

- imports another package's internal file instead of an exported entry;
- imports a higher zone (the only exception: packages that need no host may use
  the contracts entry of `@niwa-labs/core`) or a leaf (only the umbrella may);
- imports a plugin other than through its `/records` entry, or its `/flow` entry
  from script code; compositions import their plugins directly;
- imports an `@niwa-labs/*` package that its `package.json` does not declare, or
  declares one the map does not allow.

The map is the same file in every niwa repository. Change it in all of them in
the same way.

## Linking the other niwa repositories

Check out the repositories side by side:

```text
niwa-labs/
  niwa/  plugins/  rin/  pstack/
```

The root `package.json` has an `overrides` entry for every `@niwa-labs/*` package
that lives in another repository, including the whole dependency closure, of the
form `"@niwa-labs/core": "link:../niwa/packages/core"`. `bun install` turns each one
into a symlink to the sibling checkout, so edits there are live and nothing is
fetched from the registry. Install in order: `niwa`, then `plugins`, then `rin`
or `pstack`. When a package gains a dependency from another repository, add an
override for it and for every `@niwa-labs/*` package it depends on.

## Commits

- Author and committer: `Niwa Mori <mori@niwa.sh>` (set in the repository
  config).
- Subject: one imperative sentence naming what changes, at most 72 characters,
  no final period, no type prefixes such as `feat:` or `fix:`.
- Body only when the subject does not explain the change: a blank line, then at
  most 100 words wrapped at 72 columns, saying why the change was needed and
  why this approach.
- One self-contained, revertible change per commit, with its tests.
- No co-author or generator trailers.
