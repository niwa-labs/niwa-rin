/** Rin's page: talking to her, what she holds and told, her charter, her promises, her memory, the agents she leads. */

import { useState } from "react";

import { useAction, useCall, useViewer } from "@niwa-labs/cockpit-sdk";
import { Badge, Button } from "@niwa-labs/ui-kit";

import { agentsAction, attentionAction, charterAction, commitmentsAction, conversationAction, dismissAction, memoryAction, retireAction, tellAction } from "./actions.ts";
import type { AttentionView } from "./actions.ts";
import { attentionGroups, charterRows, conversationRows, ledAgents, tileText, whyText } from "./view.ts";

const RIN = "rin";

function Section({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <section className="flex min-w-0 flex-col gap-2">
      <h3 className="text-sm font-semibold">{title}</h3>
      {children}
    </section>
  );
}

function Quiet({ children }: { children: React.ReactNode }) {
  return <p className="text-sm text-muted-foreground">{children}</p>;
}

function Talk() {
  const tell = useAction(tellAction);
  const [text, setText] = useState("");
  return (
    <form
      className="flex gap-2"
      onSubmit={(event) => {
        event.preventDefault();
        if (text.trim() === "") return;
        tell.mutate({ agent: RIN, text }, { onSuccess: () => setText("") });
      }}
    >
      <textarea className="min-h-16 flex-1 rounded-md border bg-background p-2 text-sm" value={text} placeholder="Write to Rin" onChange={(event) => setText(event.target.value)} />
      <Button type="submit" size="sm" disabled={tell.isPending}>
        Send
      </Button>
      {tell.isError ? <span role="alert" className="text-xs text-destructive">{tell.error.message}</span> : null}
    </form>
  );
}

function Conversation() {
  const conversation = useCall(conversationAction, {}, { refreshOn: { types: ["message.*", "agent.turn.*"] } });
  if (conversation.isPending) return <Quiet>Loading…</Quiet>;
  if (conversation.isError) return <p role="alert" className="text-sm text-destructive">{conversation.error.message}</p>;
  const rows = conversationRows(conversation.data.messages);
  if (rows.length === 0) return <Quiet>Nothing said yet.</Quiet>;
  return (
    <ul className="flex flex-col gap-2">
      {rows.map((row) => (
        <li key={row.id} data-slot="rin-message" data-who={row.who} className="flex min-w-0 flex-col rounded-lg border bg-card px-3 py-2">
          <span className="text-sm">
            <span className="font-medium">{row.who}</span> · {row.text}
          </span>
          <span className="text-xs text-muted-foreground">
            {new Date(row.at).toLocaleString()}
            {row.state === undefined ? "" : ` · ${row.state}`}
          </span>
        </li>
      ))}
    </ul>
  );
}

function Item({ item, owner }: { item: AttentionView; owner: boolean }) {
  const dismiss = useAction(dismissAction);
  const open = item.status === "held" || item.status === "sending" || item.status === "unsure" || item.status === "said" || item.status === "brought";
  return (
    <li data-slot="rin-attention" data-status={item.status} className="flex min-w-0 items-center gap-3 rounded-lg border bg-card px-3 py-2">
      <div className="flex min-w-0 flex-col">
        <span className="text-sm">{item.text}</span>
        <span className="text-xs text-muted-foreground">
          {item.kind === undefined ? "" : `${item.kind} · `}
          {whyText(item)} · {new Date(item.at).toLocaleString()}
        </span>
      </div>
      {owner && open ? (
        <Button className="ml-auto" variant="outline" size="sm" disabled={dismiss.isPending} onClick={() => dismiss.mutate({ item: item.item })}>
          Not for me
        </Button>
      ) : null}
    </li>
  );
}

function Attention() {
  const viewer = useViewer();
  const attention = useCall(attentionAction, {}, { refreshOn: { types: ["rin.*"] } });
  if (attention.isPending) return <Quiet>Loading…</Quiet>;
  if (attention.isError) return <p role="alert" className="text-sm text-destructive">{attention.error.message}</p>;
  const groups = attentionGroups(attention.data.items);
  const list = (items: AttentionView[], empty: string) =>
    items.length === 0 ? <Quiet>{empty}</Quiet> : <ul className="flex flex-col gap-2">{items.map((item) => <Item key={item.item} item={item} owner={viewer.owner} />)}</ul>;
  return (
    <>
      <Section title="What she holds for you">{list(groups.waiting, "Nothing waits for you.")}</Section>
      <Section title="What she told you">{list(groups.told, "She has told you nothing yet.")}</Section>
    </>
  );
}

function Charter() {
  const viewer = useViewer();
  const charter = useCall(charterAction, {}, { refreshOn: { types: ["rin.charter.*", "rin.corrected"] } });
  const retire = useAction(retireAction);
  if (charter.isPending) return <Quiet>Loading…</Quiet>;
  if (charter.isError) return <p role="alert" className="text-sm text-destructive">{charter.error.message}</p>;
  const rows = charterRows(charter.data.rules);
  return rows.length === 0 ? (
    <Quiet>No rules yet: they grow from your corrections ({charter.data.corrections.length} so far).</Quiet>
  ) : (
    <ul className="flex flex-col gap-2">
      {rows.map((row) => (
        <li key={row.rule} data-slot="rin-rule" data-status={row.status} className="flex min-w-0 items-center gap-3 rounded-lg border bg-card px-3 py-2">
          <Badge variant="secondary">{row.label}</Badge>
          <span className="min-w-0 flex-1 text-sm">{row.text}</span>
          <span className="text-xs text-muted-foreground">
            {row.about} · {row.corrections} corrections
          </span>
          {viewer.owner && (row.status === "ruled" || row.status === "proposed") ? (
            <Button variant="outline" size="sm" disabled={retire.isPending} onClick={() => retire.mutate({ rule: row.rule })}>
              Retire
            </Button>
          ) : null}
        </li>
      ))}
    </ul>
  );
}

function Promises() {
  const promises = useCall(commitmentsAction, { to: RIN }, { refreshOn: { types: ["commitment.*"] } });
  if (promises.isPending) return <Quiet>Loading…</Quiet>;
  if (promises.isError) return <p role="alert" className="text-sm text-destructive">{promises.error.message}</p>;
  if (promises.data.items.length === 0) return <Quiet>No promises.</Quiet>;
  return (
    <ul className="flex flex-col gap-1 text-sm">
      {promises.data.items.map((one) => (
        <li key={one.id}>
          {one.description} <span className="text-xs text-muted-foreground">· {one.status}</span>
        </li>
      ))}
    </ul>
  );
}

function Memory() {
  const top = useCall(memoryAction, { memory: RIN }, { refreshOn: { types: ["memory.*"] } });
  if (top.isPending) return <Quiet>Loading…</Quiet>;
  if (top.isError) return <p role="alert" className="text-sm text-destructive">{top.error.message}</p>;
  return top.data.text === "" ? <Quiet>Nothing lifted yet.</Quiet> : <pre className="whitespace-pre-wrap text-sm">{top.data.text}</pre>;
}

function Agents() {
  const agents = useCall(agentsAction, {}, { refreshOn: { types: ["agent.*"] } });
  if (agents.isPending) return <Quiet>Loading…</Quiet>;
  if (agents.isError) return <p role="alert" className="text-sm text-destructive">{agents.error.message}</p>;
  const led = ledAgents(agents.data.items);
  if (led.length === 0) return <Quiet>She leads no agents yet.</Quiet>;
  return (
    <ul className="flex flex-col gap-1 text-sm">
      {led.map((agent) => (
        <li key={agent.name}>
          agent:{agent.name} <span className="text-xs text-muted-foreground">· {agent.status}</span>
        </li>
      ))}
    </ul>
  );
}

export function RinPage() {
  return (
    <div className="flex min-w-0 flex-col gap-5 p-4">
      <h2 className="text-lg font-semibold">Rin</h2>
      <Section title="Talk to her">
        <Conversation />
        <Talk />
      </Section>
      <Attention />
      <Section title="Her charter">
        <Charter />
      </Section>
      <Section title="Her promises">
        <Promises />
      </Section>
      <Section title="What she remembers">
        <Memory />
      </Section>
      <Section title="Agents she leads">
        <Agents />
      </Section>
    </div>
  );
}

/** The tile on the home page: how much waits for him. */
export function AttentionTile() {
  const attention = useCall(attentionAction, {}, { refreshOn: { types: ["rin.attention.*"] } });
  return (
    <div data-slot="rin-tile" className="rounded-lg border bg-card px-3 py-2 text-sm">
      <span className="font-medium">Rin</span> · {attention.data === undefined ? "…" : tileText(attention.data.items)}
    </div>
  );
}
