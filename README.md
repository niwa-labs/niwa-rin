# Rin

Rin is an agent that runs inside Niwa. She keeps track of commitments and
open decisions, weighs when to bring something to the owner's attention,
and adapts to corrections through an owner-approved charter. Her Cockpit
page provides a conversation and a view of what needs attention.

The [`@niwa-labs/rin` package guide](packages/rin/README.md) shows how to add
Rin to a Niwa host and configure her agent role, quiet hours, and optional
Telegram delivery. The composition uses the memory, commitments, and
delegate plugins.

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
