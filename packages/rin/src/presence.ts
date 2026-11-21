/**
 * Whether the owner is working now: the native sessions he attached to an agent, as their watch last saw them.
 *
 * Attaching a session is the owner's own act, so an attached session that is neither paused nor over is him at
 * work. A pause is only the transcript going quiet; progress written after it says he is back.
 */

import type { Row } from "./attention.ts";

/** A session the owner is working in now. */
export interface Working {
  readonly session: string;
  readonly cwd: string;
  readonly agent: string;
}

/** The record types the fold reads. */
export const PRESENCE_TYPES = ["agent.attached", "agent.detached", "history.session.paused", "history.session.ended", "history.session.seen", "session.progress"] as const;

/** `<harness> <native>`, the way an attachment names a session. */
function nameOf(session: unknown): string | undefined {
  const id = session as { harness?: unknown; native?: unknown } | undefined;
  return typeof id?.harness === "string" && typeof id.native === "string" ? `${id.harness} ${id.native}` : undefined;
}

/** The attached sessions the owner is working in, in the order they were attached. */
export function workingNow(rows: readonly Row[]): Working[] {
  const attached = new Map<string, { cwd: string; agent: string; active: boolean }>();
  for (const row of rows) {
    const data = row.data as { agent?: unknown; session?: unknown; cwd?: unknown };
    switch (row.type) {
      case "agent.attached":
        if (typeof data.session === "string" && typeof data.cwd === "string" && typeof data.agent === "string") {
          attached.delete(data.session);
          attached.set(data.session, { cwd: data.cwd, agent: data.agent, active: true });
        }
        break;
      case "agent.detached":
        if (typeof data.session === "string") attached.delete(data.session);
        break;
      case "history.session.ended": {
        const name = nameOf(data.session);
        if (name !== undefined) attached.delete(name);
        break;
      }
      case "history.session.paused":
      case "history.session.seen":
      case "session.progress": {
        const name = nameOf(data.session);
        const one = name === undefined ? undefined : attached.get(name);
        if (one !== undefined) one.active = row.type !== "history.session.paused";
        break;
      }
    }
  }
  return [...attached].filter(([, one]) => one.active).map(([session, one]) => ({ session, cwd: one.cwd, agent: one.agent }));
}
