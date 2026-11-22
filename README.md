# Rin

Rin is an agent that runs inside the [Niwa host](https://github.com/niwa-labs/niwa).
She keeps track of commitments and open decisions, weighs when to bring
something to the owner's attention, and adapts to corrections through an
owner-approved charter. She can take work from the owner or get the outcomes
of tasks and runs she started. Her Cockpit page at `/rin` brings together the
conversation, attention, promises, memory and charter.

Rin composes three packages from
[Niwa Plugins](https://github.com/niwa-labs/niwa-plugins). Memory keeps
notes and their sources, commitments tracks promises and deadlines, and
delegate lets the owner entrust a bounded decision to Rin. Niwa provides
the underlying agent identity, messages, requests, timers and workflows.

## Add Rin to a source host

Use the [Niwa source setup](https://github.com/niwa-labs/niwa#run-from-source)
and the sibling checkouts below. In the workspace's `host.ts`, import
`addressingOf` and `rin` from
`./rin/packages/rin/src/index.ts`. Bind a signed-in harness that supports
Niwa-only tools and map the `assistant` role to its installation ID. For
example, register `piKind.bind({ id: "pi-local" })` in the host's harness
registry and add `agents: { roles: { assistant: "pi-local" } }` to
`defaultComposition`. The Codex adapter does not support this tool mode.

Collect the standard composition into `base` and export the combined
composition.

```ts
import { addressingOf, rin } from "./rin/packages/rin/src/index.ts";

export default [
  ...base,
  ...rin({ bind: addressingOf(base), role: "assistant" }),
];
```

Restart the host, open Cockpit and choose Rin. To make Rin the default for
`niwa agent attach`, also import `RIN_AGENT` and set `default: RIN_AGENT`
alongside `roles` in the standard composition's `agents` options.
The [package guide](packages/rin/README.md) explains how to set quiet hours,
configure optional Telegram delivery and manage Rin's charter and module
installation.

## Develop from source

Install Bun and run these commands from a common parent directory. Keep the
checkout names below so the workspace can resolve packages from `../niwa` and
`../plugins`.

```sh
git clone https://github.com/niwa-labs/niwa.git niwa
git clone https://github.com/niwa-labs/niwa-plugins.git plugins
git clone https://github.com/niwa-labs/niwa-rin.git rin
(cd niwa && bun install)
(cd plugins && bun install)
cd rin
bun install
bun run typecheck
bun test
bun run check:boundaries
```

## License

[MIT](LICENSE)
