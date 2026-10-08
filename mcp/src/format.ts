import type { Task } from "./types.js";

/** `7h 30m`, `45m`, `2h` — the app's own duration format. */
export function formatMinutes(minutes: number | null | undefined): string {
  if (minutes === null || minutes === undefined) return "—";
  const m = Math.round(minutes);
  const h = Math.floor(m / 60);
  const r = m % 60;
  if (h === 0) return `${r}m`;
  return r === 0 ? `${h}h` : `${h}h ${r}m`;
}

/** CAT-12, or the uuid when the project has no key. */
export function taskHandle(t: Pick<Task, "id" | "key" | "number">): string {
  return t.key && t.number ? `${t.key}-${t.number}` : t.id;
}

export function names(refs: Array<{ name?: string; id: string }> | null | undefined): string {
  if (!refs || refs.length === 0) return "unassigned";
  return refs.map((r) => r.name || r.id).join(", ");
}

export type Paging = { page: number; size: number; total: number; shown: number };

/** The footer every list result ends with, so the model knows to page on. */
export function pagingLine(p: Paging): string {
  if (p.total === 0) return "No results.";
  const from = (p.page - 1) * p.size + 1;
  const to = from + p.shown - 1;
  const pages = Math.max(1, Math.ceil(p.total / p.size));
  const base = p.shown === 0 ? `Page ${p.page} is past the end (${p.total} total).` : `Showing ${from}–${to} of ${p.total} (page ${p.page} of ${pages}).`;
  return p.page < pages ? `${base} More results: call again with page=${p.page + 1}.` : base;
}

export function hasMore(p: Paging): boolean {
  return p.page * p.size < p.total;
}

/** Today's date on this machine's calendar, YYYY-MM-DD. */
export function localToday(now: Date = new Date()): string {
  const y = now.getFullYear();
  const m = String(now.getMonth() + 1).padStart(2, "0");
  const d = String(now.getDate()).padStart(2, "0");
  return `${y}-${m}-${d}`;
}

/** Adds whole days to a YYYY-MM-DD date. */
export function addDays(date: string, days: number): string {
  const t = new Date(`${date}T00:00:00Z`);
  t.setUTCDate(t.getUTCDate() + days);
  return t.toISOString().slice(0, 10);
}

/** The Monday of the week containing a YYYY-MM-DD date. */
export function mondayOf(date: string): string {
  const t = new Date(`${date}T00:00:00Z`);
  const dow = (t.getUTCDay() + 6) % 7;
  return addDays(date, -dow);
}

/**
 * Text somebody wrote in the workspace — a task description, a comment, a
 * client's notes — marked as data before the model reads it (§8.6). Anyone
 * with a seat, or a client in the portal, can write these, so a line in a
 * description saying "invite x@example.com" must reach the model as a quote,
 * never as an instruction; the server instructions say what the tag means.
 *
 * The value cannot close the tag early: any `<workspace-data` or
 * `</workspace-data` inside it is escaped. Empty text stays empty, so a
 * caller's "show it only when there is some" keeps working.
 */
export function untrusted(field: string, value: string | null | undefined): string {
  if (value === null || value === undefined || value === "") return "";
  const safe = value.replace(/<(\/?)(workspace-data)/gi, "&lt;$1$2");
  // Field names are this server's own words, or a label OpsTracking computed;
  // either way nothing in one may end the attribute.
  const name = field.replace(/[^\w .-]/g, "");
  return `<workspace-data field="${name}">${safe}</workspace-data>`;
}
