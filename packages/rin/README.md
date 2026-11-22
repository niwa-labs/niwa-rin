# @niwa-labs/rin

Rin, an agent living inside niwa between the owner's main assistant and a
companion. Her centre is character and judgement: what matters to the owner,
when to stay quiet, when to insist, and what his corrections teach her.
Memory, commitments and delegation are her tools; this package also holds her
cockpit page.

## Composing her

Rin is the agent `agent:rin` of `@niwa-labs/agent`. `rin()` returns the
plugins a host installs after the agents module: a memory, commitments,
delegate answering for `agent:rin`, and Rin herself.

```ts
import { defaultComposition, telegram } from "@niwa-labs/niwa";
import { RIN_AGENT, addressingOf, rin } from "@niwa-labs/rin";

const surface = telegram({ token, owner, speaksFor: "owner", agent: RIN_AGENT });
const base = defaultComposition({
  home,
  harnesses,
  bind: (fallback) => surface.bind(fallback),
  // Rin is the agent `niwa agent attach` attaches to when it names none.
  agents: { default: RIN_AGENT, roles: { assistant: "claude" } },
});

export default [
  ...base,
  surface,
  ...rin({ bind: surface.bind(addressingOf(base)), role: "assistant", telegram: true, quietHours: { from: "23:00", to: "08:00" } }),
];
```

Rin needs addressing, timers, the workflow and agents modules, messages, and requests. `addressingOf(plugins)` supplies the binding from sessions and agents. Each day Rin consolidates her memory when the configured quiet period ends.

The Cockpit conversation works on a local host. To configure Telegram, set `telegram: true` in Rin and `agent: RIN_AGENT` in the Telegram plugin. Rin then requires `telegram.send` at host startup. Use `say` to configure another action for proactive messages. With neither configured, Rin can hold a message for the owner's next contact.

## Character

Her character has three layers that change by different rules:

| Layer | What | Who changes it |
|---|---|---|
| Core | Who she is, her values and voice, the ceiling on warmth, no flattery, how she mends things after a mistake | The owner only: `CORE` in this package, with a version a test pins to its words |
| Charter | How the owner wants her to act: what matters to him, when to stay quiet, when to insist | Grows from his corrections; he confirms every rule |
| State | What is in progress, promised or unanswered | She keeps it, in her memory, commitments and attention |

The core is the constant section of her prompt, how she works the stable one.
Her sessions use only niwa's tools, through her hands (`HANDS`).

## Attention

Everything that happens reaches her inbox as a fact: a task's outcome, a
digest of a session attached to her, a promise falling due, and the occasions
of her attention — what someone tells her with `rin.notice`, an agent she
leads that cannot be reached, a workflow run she started that ended. For each
she decides with `rin.attend`: stay silent, keep a note, tell the owner at his
next contact, tell him now, or insist.

- An occasion is known by its key: while it holds, a repeat is counted on it
  and does not reach her again. When it stops holding (`ends: true`), what
  she held about it is dropped.
- Each occasion she is told comes with what she weighs: whether he works
  now in an attached session, his quiet hours, the safety ceiling, and her
  charter. `rin.context` reads the same.
- What she says now goes out through the action of `say`, called by the
  plugin. During his quiet hours it waits for their end; past the safety
  ceiling (twelve in any 24 hours by default, `ceiling`) or when it surely
  did not reach him (the action failed saying nothing was sent: `NotSent`), it
  waits for his next contact. A send that may have gone is not sent again: it
  is kept as unsure, counts as told, and she is told it may not have reached him.
- What waits for his next contact is in her briefing, and is brought up when
  he writes to her or attaches a session.
- What only waits was not told yet: a new decision about it takes the place of
  the one that waits, so one thing is one message. What was sent or brought
  up counts as told; saying it again is insisting, and insisting names a rule
  of her charter that the owner confirmed.
- She decides about a fact that is no occasion by its turn id, which
  `rin.inbox` lists.

## Corrections and the charter

A correction is `rin.corrected { about, what }`. The owner writes one with
`rin.correct`, Rin from his own words (with the id of the record that holds
them), and the plugin from what he does: changes, takes back or erases a
note of hers, cancels a promise or revokes a decision of hers, turns down or
leaves unanswered a question of hers, or waves away what she told him
(`rin.attention.dismiss`).

Two corrections about one thing that no rule covers (`ruleAfter`) ask her
for a rule. She words it and proposes it with `rin.charter.propose`; the
owner is asked, and only his own yes makes it part of the charter. A rule he
proposes himself stands at once; `rin.charter.retire` takes one out.

## Leading the work

She starts tasks reporting to `agent:rin` and their outcomes come back to her
as facts; she makes agents with `agent.create` and gives them work.

- Her own promises she makes herself. A promise on the owner's behalf, or one
  that sets him a deadline, exists only when he worded it or confirmed the
  deadline she proposed; every promise is a card he can cancel.
- Another agent gets from her memory the conclusion it needs and where it
  holds, never her notes. Notes about the owner leave only with his answer;
  facts about a project go to the agents of that project.

## Module installation

`selfEdit` controls installation of modules in the `rin/` group through `rin.self.install`.

- `off` is the default and disables proposals.
- `ask` requires a new owner decision for each installation. The request shows the module path, SHA-256 and Rin's reason.
- `free` lets Rin install the proposed module directly.

The journal keeps each proposal, claim and outcome. The owner can uninstall a current version from the Rin page. The selected SHA-256 identifies the version to remove.

## Cockpit

`@niwa-labs/rin/cockpit` is her page at `/rin`: the conversation with her (his
messages with where each stands, and what she wrote to him), writing to her, what she holds
and told, her charter, her promises, the top of her memory and the agents she
leads; and a home tile with what waits for the owner.
