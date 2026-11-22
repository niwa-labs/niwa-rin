/** Rin's page: talking to her, what she holds and told, her charter, her promises, her memory, the agents she leads. */

import { useState } from "react";

import { EntityLink, PageLink, useAction, useCall, useViewer, recordList, useProjection } from "@niwa-labs/cockpit-sdk";
import { Button, CopyValue, FileRef, Markdown } from "@niwa-labs/ui-kit";

import { agentsAction, attentionAction, caseCloseAction, caseListAction, charterAction, commitmentsAction, conversationAction, dismissAction, memoryAction, openQuestionsAction, retireAction, selfHistoryAction, tellAction, uninstallAction } from "./actions.ts";
import type { AttentionView, CaseView } from "./actions.ts";
import { attentionGroups, charterRows, conversationRows, ledAgents, tileText, whyText } from "./view.ts";

const RIN = "rin";
const REPLY_ROUTE = { channel: "cockpit", conversation: RIN } as const;

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
      className="flex min-w-0 flex-wrap items-start gap-2"
      onSubmit={(event) => {
        event.preventDefault();
        const sent = text.trim();
        if (sent === "" || tell.isPending) return;
        tell.mutate({ agent: RIN, text: sent, replyTo: REPLY_ROUTE }, {
          onSuccess: () => setText((current) => current.trim() === sent ? "" : current),
        });
      }}
    >
      <textarea className="min-h-16 flex-1 rounded-md border bg-background p-2 text-sm" aria-label="Написать Рин" value={text} placeholder="Написать Рин" onChange={(event) => setText(event.target.value)} />
      <Button type="submit" size="sm" disabled={tell.isPending || text.trim() === ""}>
        Отправить
      </Button>
      {tell.isError ? <span role="alert" className="text-xs text-destructive">{tell.error.message}</span> : null}
    </form>
  );
}

function Conversation() {
  const conversation = useCall(conversationAction, { conversation: REPLY_ROUTE.conversation }, { refreshOn: { types: ["message.sent", "agent.turn.delivered", "agent.turn.failed", "agent.turn.replied"] } });
  if (conversation.isPending) return <Quiet>Загружаем…</Quiet>;
  if (conversation.isError) return <p role="alert" className="text-sm text-destructive">{conversation.error.message}</p>;
  const rows = conversationRows(conversation.data.messages);
  if (rows.length === 0) return <Quiet>Сообщений пока нет. Напишите Рин, чтобы начать разговор.</Quiet>;
  return (
    <ul className="flex flex-col gap-2">
      {rows.map((row) => (
        <li key={row.id} data-slot="rin-message" data-who={row.who} data-turn={row.turn} className="flex min-w-0 flex-col rounded-lg border bg-card px-3 py-2">
          <span className="text-sm">
            <span className="font-medium">{row.who}</span>
          </span>
          <span className="whitespace-pre-wrap break-words text-sm">{row.text}
          </span>
          <span className="text-xs text-muted-foreground">
            {new Date(row.at).toLocaleString("ru")}
            {row.state === undefined ? "" : ` · ${row.state}`}
          </span>
        </li>
      ))}
    </ul>
  );
}

const OCCASION_LABEL: Readonly<Record<string, string>> = {
  agent: "Агент", case: "Открытое дело", ci: "Проверки", task: "Задача", question: "Вопрос", workflow: "Сценарий",
};

function Item({ item, owner }: { item: AttentionView; owner: boolean }) {
  const dismiss = useAction(dismissAction);
  const open = item.status === "held" || item.status === "sending" || item.status === "unsure" || item.status === "said" || item.status === "brought";
  const kind = item.kind === undefined ? undefined : OCCASION_LABEL[item.kind];
  return (
    <li data-slot="rin-attention" data-status={item.status} className="flex min-w-0 flex-wrap items-start gap-3 border-b px-3 py-3 last:border-b-0">
      <div className="flex min-w-0 flex-col">
        <span className="text-sm">{item.text}</span>
        <span className="text-xs text-muted-foreground">
          {kind === undefined ? "" : `${kind} · `}
          {whyText(item)} · {new Date(item.at).toLocaleString("ru")}
        </span>
      </div>
      {owner && open ? (
        <Button className="ml-auto" variant="outline" size="sm" disabled={dismiss.isPending} onClick={() => dismiss.mutate({ item: item.item })}>
          Скрыть
        </Button>
      ) : null}
      {dismiss.isError ? <p role="alert" className="w-full text-xs text-destructive">{dismiss.error.message}</p> : null}
    </li>
  );
}

function Attention() {
  const viewer = useViewer();
  const attention = useCall(attentionAction, {}, { refreshOn: { types: ["rin.*"] } });
  if (attention.isPending) return <Quiet>Загружаем…</Quiet>;
  if (attention.isError) return <p role="alert" className="text-sm text-destructive">{attention.error.message}</p>;
  const groups = attentionGroups(attention.data.items);
  const list = (items: AttentionView[]) => (
    <ul className="rounded-lg border bg-card">{items.map((item) => <Item key={item.item} item={item} owner={viewer.owner} />)}</ul>
  );
  return (
    <>
      <Section title="Отложенные сообщения">
        {groups.waiting.length ? list(groups.waiting) : <Quiet>У Рин нет сообщений, ожидающих доставки.</Quiet>}
      </Section>
      {groups.told.length ? <details className="space-y-2"><summary className="cursor-pointer text-sm font-medium">История уведомлений ({groups.told.length})</summary>{list(groups.told)}</details> : null}
    </>
  );
}

function CaseRow({ item, canClose }: { item: CaseView; canClose: boolean }) {
  const close = useAction(caseCloseAction);
  return (
    <li className="flex min-w-0 flex-wrap items-start gap-2 py-2">
      <div className="min-w-0 flex-1 space-y-1">
        <p className="break-words text-sm font-medium">{item.subject}</p>
        <p className="whitespace-pre-wrap break-words text-sm">Ждём {item.expected}</p>
        <div className="flex flex-wrap items-center gap-2 text-xs text-muted-foreground">
          <time dateTime={new Date(item.due).toISOString()}>Срок {new Date(item.due).toLocaleString("ru")}</time>
          <CopyValue value={item.case} />
        </div>
      </div>
      {canClose ? (
        <Button type="button" variant="outline" size="sm" disabled={close.isPending || close.isSuccess} onClick={() => close.mutate({ case: item.case })}>
          Закрыть дело
        </Button>
      ) : null}
      {close.isError ? <p role="alert" className="w-full text-xs text-destructive">{close.error.message}</p> : null}
    </li>
  );
}

function OpenCases() {
  const viewer = useViewer();
  const open = useCall(caseListAction, {}, { refreshOn: { types: ["rin.case.*", "request.answered", "agent.turn.replied"] } });
  if (open.isPending) return <Quiet>Загружаем дела…</Quiet>;
  if (open.isError) return <p role="alert" className="text-sm text-destructive">{open.error.message}</p>;
  if (open.data.cases.length === 0) return <Quiet>Открытых дел пока нет.</Quiet>;
  const canClose = viewer.can(caseCloseAction.name);
  return (
    <ul className="divide-y rounded-lg border bg-card px-3">
      {open.data.cases.map((item) => <CaseRow key={item.case} item={item} canClose={canClose} />)}
    </ul>
  );
}

function Charter() {
  const viewer = useViewer();
  const charter = useCall(charterAction, {}, { refreshOn: { types: ["rin.charter.*", "rin.corrected"] } });
  const retire = useAction(retireAction);
  if (charter.isPending) return <Quiet>Загружаем…</Quiet>;
  if (charter.isError) return <p role="alert" className="text-sm text-destructive">{charter.error.message}</p>;
  const rows = charterRows(charter.data.rules);
  return rows.length === 0 ? (
    <Quiet>В уставе пока нет правил. Учтено поправок: {charter.data.corrections.length}.</Quiet>
  ) : (
    <ul className="flex flex-col gap-2">
      {rows.map((row) => (
        <li key={row.rule} data-slot="rin-rule" data-status={row.status} className="flex min-w-0 flex-wrap items-start gap-3 border-b px-3 py-3 last:border-b-0">
          <div className="min-w-0 flex-1">
            <p className="break-words text-sm">{row.text}</p>
            <p className="text-xs text-muted-foreground">{row.label} · {row.about} · поправок: {row.corrections}</p>
          </div>
          {viewer.owner && (row.status === "ruled" || row.status === "proposed" || row.status === "learned") ? (
            <Button variant="outline" size="sm" disabled={retire.isPending} onClick={() => retire.mutate({ rule: row.rule })}>
              Снять правило
            </Button>
          ) : null}
        </li>
      ))}
    </ul>
  );
}

const PROMISE_STATUS: Readonly<Record<string, string>> = {
  proposed: "Ждёт подтверждения", open: "Открыто", due: "Срок наступил",
  kept: "Выполнено", "kept-late": "Выполнено с опозданием", missed: "Просрочено",
  cancelled: "Отменено", declined: "Отклонено",
};

function Promises() {
  const promises = useCall(commitmentsAction, { to: RIN }, { refreshOn: { types: ["commitment.*"] } });
  if (promises.isPending) return <Quiet>Загружаем поручения…</Quiet>;
  if (promises.isError) return <p role="alert" className="text-sm text-destructive">Не удалось загрузить поручения. {promises.error.message}</p>;
  const active = (one: { status: string }) => one.status === "proposed" || one.status === "open" || one.status === "due";
  const open = promises.data.items.filter(active).sort((a, b) => (a.due ?? Infinity) - (b.due ?? Infinity));
  const history = promises.data.items.filter((item) => !active(item));
  const list = (items: typeof open) => (
    <ul className="divide-y rounded-lg border bg-card px-3">
      {items.map((one) => (
        <li key={one.id} className="space-y-1 py-2">
          <p className="break-words text-sm">{one.description}</p>
          <p className="desk-tools text-xs text-muted-foreground">
            <span>{PROMISE_STATUS[one.status] ?? "Статус не определён"}</span>
            {one.due === undefined ? null : <time dateTime={new Date(one.due).toISOString()}>До {new Date(one.due).toLocaleString("ru")}</time>}
          </p>
        </li>
      ))}
    </ul>
  );
  return (
    <>
      {open.length ? list(open) : <Quiet>Открытых поручений для Рин нет.</Quiet>}
      {history.length ? <details className="space-y-2">
        <summary className="cursor-pointer text-sm font-medium">Завершённые поручения ({history.length})</summary>
        {list(history)}
      </details> : null}
    </>
  );
}

function Questions() {
  const viewer = useViewer();
  const available = viewer.owner && viewer.can(openQuestionsAction);
  const open = useCall(openQuestionsAction, { to: { kind: "owner" } }, { enabled: available, refreshOn: { types: ["request.*"] } });
  if (!available) return null;
  const questions = (open.data?.requests ?? []).flatMap((row) => {
    if (!("id" in row)) return [];
    const title = row.question === "rin.charter.confirm" ? "Подтверждение правила устава" :
      row.question === "rin.self-edit.confirm" ? "Подтверждение установки модуля" :
      row.from?.kind === "agent" && row.from.id === RIN ? "Вопрос Рин" : undefined;
    return title === undefined ? [] : [{ id: row.id, title, question: row.input.title }];
  });
  return (
    <Section title="Открытые вопросы">
      {open.isPending ? <Quiet>Загружаем вопросы…</Quiet> :
        open.isError ? <p role="alert" className="text-sm text-destructive">Не удалось загрузить вопросы. {open.error.message}</p> :
        questions.length === 0 ? <Quiet>Сейчас Рин не ждёт ваших решений.</Quiet> :
        <ul className="divide-y rounded-lg border bg-card px-3">
          {questions.map((row) => (
            <li key={row.id} className="space-y-1 py-2">
              <p className="flex flex-wrap items-center gap-2 text-sm font-medium">
                {row.title} <EntityLink entity={{ kind: "request", id: row.id }} short />
              </p>
              <p className="break-words text-sm text-muted-foreground">{row.question}</p>
            </li>
          ))}
        </ul>}
    </Section>
  );
}

function Memory() {
  const top = useCall(memoryAction, { memory: RIN }, { refreshOn: { types: ["memory.*"] } });
  if (top.isPending) return <Quiet>Загружаем…</Quiet>;
  if (top.isError) return <p role="alert" className="text-sm text-destructive">{top.error.message}</p>;
  if (top.data.text === "") return <Quiet>В приоритетной памяти пока пусто.</Quiet>;
  const text = top.data.text.replace(/^About the owner:\n(?=- )/gm, "**О владельце**\n\n")
    .replace(/^In general:\n(?=- )/gm, "**Общее**\n\n");
  return <Markdown text={text} />;
}

const AGENT_STATUS = { new: "Новый", working: "В работе", asleep: "Неактивен" };

function Agents() {
  const agents = useCall(agentsAction, {}, { refreshOn: { types: ["agent.*"] } });
  if (agents.isPending) return <Quiet>Загружаем…</Quiet>;
  if (agents.isError) return <p role="alert" className="text-sm text-destructive">{agents.error.message}</p>;
  const led = ledAgents(agents.data.items);
  if (led.length === 0) return <Quiet>Других агентов пока нет.</Quiet>;
  return (
    <ul className="flex flex-col gap-1 text-sm">
      {led.map((agent) => (
        <li key={agent.name}>
          {agent.name} <span className="text-xs text-muted-foreground">· {AGENT_STATUS[agent.status]}</span>
        </li>
      ))}
    </ul>
  );
}

const MODULE_STATUS: Readonly<Record<string, string>> = {
  pending: "Ждёт решения", installing: "Устанавливается", installed: "Установлен",
  declined: "Отклонён", cancelled: "Отменён", expired: "Срок истёк",
  "not-his": "Подтверждение владельца не получено", failed: "Ошибка установки", unknown: "Итог неизвестен",
};

function SelfEdits() {
  const history = useCall(selfHistoryAction, {}, { refreshOn: { types: ["rin.self-edit.*", "niwa.plugin.*"] } });
  const uninstall = useAction(uninstallAction);
  const [selected, setSelected] = useState<{ plugin: string; hash: string }>();
  if (history.isPending) return <Quiet>Загружаем…</Quiet>;
  if (history.isError) return <p role="alert" className="text-sm text-destructive">{history.error.message}</p>;
  const { mode, edits, installed } = history.data;
  return (
    <details className="space-y-2">
      <summary className="cursor-pointer text-sm font-semibold">Модули Рин</summary>
      <Quiet>{mode === "off" ? "Установка модулей отключена." : mode === "ask" ? "Установка требует вашего подтверждения." : "Рин может устанавливать модули самостоятельно."}</Quiet>
      {installed.length > 0 ? (
        <ul className="flex flex-col gap-2 text-sm">
          {installed.map((entry) => {
            const confirming = selected?.plugin === entry.plugin && selected.hash === entry.hash;
            return (
              <li key={entry.plugin} className="flex items-center gap-2">
                <span className="mr-auto">{entry.plugin} · {entry.version}</span>
                {confirming ? (
                  <>
                    <Button size="sm" variant="outline" onClick={() => setSelected(undefined)} disabled={uninstall.isPending}>Отмена</Button>
                    <Button size="sm" variant="destructive" disabled={uninstall.isPending} onClick={() => uninstall.mutate(selected, { onSuccess: () => setSelected(undefined) })}>
                      Подтвердить удаление
                    </Button>
                  </>
                ) : (
                  <Button size="sm" variant="outline" disabled={uninstall.isPending} onClick={() => setSelected(entry)}>Удалить</Button>
                )}
              </li>
            );
          })}
        </ul>
      ) : null}
      {uninstall.isError ? <p role="alert" className="text-sm text-destructive">{uninstall.error.message}</p> : null}
      {edits.length > 0 ? (
        <ul className="flex flex-col gap-2 text-sm">
          {edits.map((edit) => (
            <li key={edit.edit} className="flex flex-col rounded-lg border bg-card px-3 py-2">
              <span>{edit.plugin} · {MODULE_STATUS[edit.status] ?? "Статус не определён"}</span>
              <span>{edit.why}</span>
              <div className="flex flex-wrap items-center gap-2 text-xs">{edit.module ? <FileRef path={edit.module} /> : null}<CopyValue value={edit.hash} label={edit.hash.slice(0, 12)} /></div>
              {edit.detail ? <span>{edit.detail}</span> : null}
            </li>
          ))}
        </ul>
      ) : null}
    </details>
  );
}

export function RinPage() {
  const viewer = useViewer();
  const { owner } = viewer;
  return (
    <article className="desk-page p-4">
      <h1>Рин</h1>
      <Questions />
      <Section title="Поручения и обязательства">
        <Promises />
      </Section>
      {owner && viewer.can(caseListAction.name) ? (
        <Section title="Открытые дела">
          <OpenCases />
        </Section>
      ) : null}
      <Attention />
      {owner ? (
        <Section title="Разговор">
          <Talk />
          <Conversation />
        </Section>
      ) : null}
      <Section title="Устав">
        <Charter />
      </Section>
      {owner ? <SelfEdits /> : null}
      <details className="space-y-2">
        <summary className="cursor-pointer text-sm font-semibold">Приоритетная память</summary>
        <Memory />
      </details>
      <Section title="Агенты Рин">
        <Agents />
      </Section>
    </article>
  );
}

const ACTIVITY_LABEL = new Map<string, string>([
  ["rin.occasion.opened", "Замечено событие"],
  ["rin.attention.held", "Сообщение отложено"],
  ["rin.attention.said", "Сообщение доставлено"],
  ["rin.attention.unsure", "Доставка не подтверждена"],
  ["rin.attention.brought", "Событие обсуждено"],
  ["rin.corrected", "Учтена поправка"],
  ["rin.charter.proposed", "Предложено правило"],
  ["rin.charter.ruled", "Правило принято"],
  ["rin.charter.retired", "Правило снято"],
  ["rin.self-edit.proposed", "Предложена установка модуля"],
  ["rin.self-edit.settled", "Получен результат установки"],
]);
const recentActivity = recordList({ types: [...ACTIVITY_LABEL.keys()] }, 8);

/** Recent decisions and the items that need the owner. */
export function AttentionTile() {
  const recent = useProjection(recentActivity);
  const attention = useCall(attentionAction, {}, { refreshOn: { types: ["rin.attention.*"] } });
  return (
    <section data-slot="rin-tile" className="desk-section"><h2>Последние действия Рин</h2>
      <PageLink to="/rin">Открыть Рин →</PageLink>
      {attention.error ? <p role="alert">{attention.error.message}</p> : attention.data && <p>{tileText(attention.data.items)}</p>}
      {!recent.length && <p>Заметных действий пока нет.</p>}
      {recent.length > 0 && <ul className="space-y-2">{recent.toReversed().map((record) => {
        const data = (record.data ?? {}) as Record<string, unknown>;
        const detail = typeof data["text"] === "string" ? data["text"] : undefined;
        return <li key={record.id} className="text-sm">
          <time className="mr-2 text-muted-foreground">{new Date(record.at).toLocaleTimeString("ru", { hour: "2-digit", minute: "2-digit" })}</time>
          {ACTIVITY_LABEL.get(record.type)}
          {detail ? <p className="break-words text-muted-foreground">{detail}</p> : null}
        </li>;
      })}</ul>}
    </section>
  );
}
