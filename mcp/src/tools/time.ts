import { z } from "zod";
import { readOf, writeOf } from "../access.js";
import { addDays, formatMinutes, hasMore, localToday, mondayOf, pagingLine, taskHandle, untrusted } from "../format.js";
import { resolvePerson, resolveProject, ResolveError } from "../resolve.js";
import type { Page, TimeEntry, Timer, TimerStop } from "../types.js";
import {
  CONFIRM_FIRST,
  dateArg,
  defineTool,
  pageOf,
  pagingArgs,
  READ,
  result,
  workspaceArg,
  writeHints,
  type ToolContext,
} from "./common.js";
import { getTask } from "./tasks.js";

const MAX_WEEKS = 8;
const MAX_ENTRY_MINUTES = 24 * 60;

function entryRow(e: TimeEntry) {
  return {
    id: e.id,
    date: e.date,
    minutes: e.minutes,
    duration: formatMinutes(e.minutes),
    project: e.project ?? "",
    projectId: e.projectId ?? "",
    task: e.task ?? "",
    taskId: e.taskId ?? null,
    billable: e.billable ?? true,
    notes: e.notes ?? "",
    status: e.submissionStatus || "Draft",
  };
}

/** One entry's line: day, duration, what it was for, and its note. */
function entryLine(e: ReturnType<typeof entryRow>): string {
  return (
    `${e.date} ${e.duration} · ${untrusted("project", e.project)}${e.task ? ` / ${untrusted("task", e.task)}` : ""}` +
    `${e.billable ? "" : " · non-billable"} · ${e.status}${e.notes ? ` — ${untrusted("notes", e.notes)}` : ""}`
  );
}

function timerRow(t: Timer) {
  return {
    id: t.id,
    project: t.project ?? "",
    projectId: t.projectId ?? "",
    task: t.task ?? "",
    taskId: t.taskId ?? null,
    billable: t.billable ?? true,
    startedAt: t.startedAt ?? "",
    stopsAt: t.stopAt ?? "",
    workedOn: t.workedOn ?? "",
  };
}

export function registerTimeTools(ctx: ToolContext): void {
  defineTool(
    ctx,
    "list_time_entries",
    {
      title: "List time entries",
      description:
        "Lists logged time for one week (default: this week) or a date range of up to 8 weeks, with totals per day " +
        "and per project. Defaults to the user's own time.",
      inputSchema: {
        ...workspaceArg,
        week: dateArg.optional().describe("Any date in the week to show (YYYY-MM-DD). Default: this week."),
        from: dateArg.optional().describe("Range start (YYYY-MM-DD). Use with `to` instead of `week`."),
        to: dateArg.optional().describe("Range end, inclusive (YYYY-MM-DD)."),
        member: z.string().optional().describe("Whose time: 'me' (default), exact name, email or member uuid. Others need permission."),
        project: z.string().optional().describe("Only this project (uuid, key or exact name)."),
        task: z.string().optional().describe("Only this task (handle like CAT-12 or uuid)."),
        ...pagingArgs,
      },
      annotations: READ,
      access: readOf("timesheets"),
    },
    async (args, session) => {
      const { base } = await session.wsPath(args.workspace);
      const { page, size } = pageOf(args);
      if ((args.from && !args.to) || (!args.from && args.to)) throw new ResolveError("Pass both `from` and `to` for a range.");
      if (args.from && args.to && args.from > args.to) throw new ResolveError("`from` must be on or before `to`.");

      const from = args.from ?? mondayOf(args.week ?? localToday());
      const to = args.to ?? addDays(from, 6);
      const weeks: string[] = [];
      for (let w = mondayOf(from); w <= to; w = addDays(w, 7)) weeks.push(w);
      if (weeks.length > MAX_WEEKS) throw new ResolveError(`That range spans ${weeks.length} weeks; ask for ${MAX_WEEKS} or fewer at a time.`);

      const memberUuid =
        args.member && args.member.trim().toLowerCase() !== "me"
          ? await resolvePerson(session.client, base, args.member, () => session.myMemberId())
          : undefined;
      const taskUuid = args.task ? (await getTask(session.client, base, args.task)).id : undefined;
      const projectId = args.project ? (await resolveProject(session.client, base, args.project)).id : undefined;

      const all: TimeEntry[] = [];
      for (const week of weeks) {
        for (let p = 1; p <= 10; p++) {
          const res = await session.client.get<Page<TimeEntry>>(`${base}/timesheets/entries`, {
            week,
            memberUuid,
            taskUuid,
            page: p,
            size: 100,
          });
          const rows = res.rows ?? [];
          all.push(...rows);
          if (rows.length < 100) break;
        }
      }
      const entries = all
        .filter((e) => e.date >= from && e.date <= to)
        .filter((e) => !projectId || e.projectId === projectId)
        .sort((a, b) => (a.date === b.date ? 0 : a.date < b.date ? -1 : 1));

      const totalMinutes = entries.reduce((s, e) => s + (e.minutes ?? 0), 0);
      const byDay = new Map<string, number>();
      const byProject = new Map<string, number>();
      for (const e of entries) {
        byDay.set(e.date, (byDay.get(e.date) ?? 0) + e.minutes);
        const key = e.project || e.projectId || "?";
        byProject.set(key, (byProject.get(key) ?? 0) + e.minutes);
      }

      const shown = entries.slice((page - 1) * size, page * size).map(entryRow);
      const paging = { page, size, total: entries.length, shown: shown.length };
      const lines = [
        `Time ${from} → ${to}: ${formatMinutes(totalMinutes)} in ${entries.length} entr${entries.length === 1 ? "y" : "ies"}.`,
      ];
      if (byDay.size > 0) lines.push(`By day: ${[...byDay].map(([d, m]) => `${d} ${formatMinutes(m)}`).join(", ")}`);
      if (byProject.size > 0) {
        lines.push(`By project: ${[...byProject].map(([p, m]) => `${untrusted("project", p)} ${formatMinutes(m)}`).join(", ")}`);
      }
      if (entries.length > 0) {
        lines.push(
          "",
          ...shown.map(
            (e) =>
              `- ${entryLine(e)} (id ${e.id})`,
          ),
          pagingLine(paging),
        );
      }
      const text = lines.join("\n");
      return result(
        text,
        {
          from,
          to,
          totalMinutes,
          byDay: Object.fromEntries(byDay),
          byProject: Object.fromEntries(byProject),
          rows: shown,
          total: entries.length,
          page,
          size,
          hasMore: hasMore(paging),
        },
        ctx.token(),
      );
    },
  );

  defineTool(
    ctx,
    "log_time",
    {
      title: "Log time",
      description:
        "Logs the user's own time against a task or a project on one day. Give either `hours` or `minutes`. When a " +
        "task is given its project is used. Some projects require a task. Future dates are refused. " +
        CONFIRM_FIRST,
      inputSchema: {
        ...workspaceArg,
        task: z.string().optional().describe("Task handle (CAT-12) or uuid."),
        project: z.string().optional().describe("Project uuid, key or exact name. Needed when no task is given."),
        date: dateArg.optional().describe("Day worked (YYYY-MM-DD). Default today."),
        hours: z.number().positive().max(24).optional().describe("Duration in hours, e.g. 1.5."),
        minutes: z.number().int().positive().max(MAX_ENTRY_MINUTES).optional().describe("Duration in minutes, e.g. 90."),
        note: z.string().max(5000).optional().describe("What was done."),
        // Left out, the API decides from the project's billing type — the
        // same default the app's time-entry modal shows.
        billable: z
          .boolean()
          .optional()
          .describe("Default: the project's billing type — billable on an Hourly project, not on Fixed Price or Non-billable."),
      },
      annotations: writeHints(false),
      access: writeOf("time:write", ["timesheets", "add"]),
    },
    async (args, session) => {
      const { base } = await session.wsPath(args.workspace);
      if ((args.hours === undefined) === (args.minutes === undefined)) {
        throw new ResolveError("Give the duration as either `hours` or `minutes` (exactly one).");
      }
      const minutes = args.minutes ?? Math.round((args.hours as number) * 60);
      if (minutes < 1 || minutes > MAX_ENTRY_MINUTES) throw new ResolveError("A time entry must be between 1 minute and 24 hours.");
      if (!args.task && !args.project) throw new ResolveError("Say what the time was for: pass `task` or `project`.");

      let taskUuid: string | undefined;
      let projectUuid: string;
      let label: string;
      if (args.task) {
        const t = await getTask(session.client, base, args.task);
        const tp = t.project?.id;
        if (!tp) throw new ResolveError("Could not tell which project this task belongs to.");
        if (args.project) {
          const p = await resolveProject(session.client, base, args.project);
          if (p.id !== tp) throw new ResolveError(`The task is in ${t.project?.name ?? "another project"}, not ${p.name}.`);
        }
        taskUuid = t.id;
        projectUuid = tp;
        label = `${taskHandle(t)} · ${untrusted("title", t.title)}`;
      } else {
        const p = await resolveProject(session.client, base, args.project as string);
        projectUuid = p.id;
        label = untrusted("project", p.name);
      }

      // Never `taskTitle`: that composes a new task on the board, which is a
      // separate decision from logging an hour.
      const body: Record<string, unknown> = {
        date: args.date ?? localToday(),
        projectUuid,
        minutes,
        mode: "duration",
      };
      if (taskUuid) body.taskUuid = taskUuid;
      if (args.note !== undefined) body.notes = args.note;
      if (args.billable !== undefined) body.billable = args.billable;

      const e = await session.client.post<TimeEntry>(`${base}/timesheets/entries`, body);
      const row = entryRow(e);
      return result(
        `Logged ${row.duration} on ${row.date} for ${label}${row.billable ? "" : " (non-billable)"} (entry id ${row.id}).`,
        { entry: row },
        ctx.token(),
      );
    },
  );
  defineTool(
    ctx,
    "update_time_entry",
    {
      title: "Update time entry",
      description:
        "Changes one of the user's time entries (the id from list_time_entries): the day (within the same week), " +
        "the duration, the note, billable, or the task (null clears it where the project allows no task). The " +
        "project never changes — log a new entry instead. Submitted or locked time is refused by the server. " +
        CONFIRM_FIRST,
      inputSchema: {
        ...workspaceArg,
        entry: z.string().min(1).describe("The entry id (list_time_entries)."),
        date: dateArg.optional().describe("New day, in the same week."),
        hours: z.number().positive().max(24).optional(),
        minutes: z.number().int().positive().max(MAX_ENTRY_MINUTES).optional(),
        note: z.string().max(5000).optional().describe("Replaces the note."),
        billable: z.boolean().optional(),
        task: z.union([z.string().min(1), z.null()]).optional().describe("Task handle or uuid in the same project, or null to clear."),
      },
      annotations: writeHints(true),
      access: writeOf("time:write", ["timesheets", "edit"]),
    },
    async (args, session) => {
      const { base } = await session.wsPath(args.workspace);
      if (args.hours !== undefined && args.minutes !== undefined) throw new ResolveError("Give `hours` or `minutes`, not both.");
      const body: Record<string, unknown> = {};
      if (args.date) body.date = args.date;
      if (args.hours !== undefined) body.minutes = Math.round(args.hours * 60);
      if (args.minutes !== undefined) body.minutes = args.minutes;
      if (args.note !== undefined) body.notes = args.note;
      if (args.billable !== undefined) body.billable = args.billable;
      if (args.task === null) body.taskUuid = null;
      else if (args.task !== undefined) body.taskUuid = (await getTask(session.client, base, args.task)).id;
      if (Object.keys(body).length === 0) throw new ResolveError("Nothing to update: pass at least one field to change.");
      const e = await session.client.patch<TimeEntry>(`${base}/timesheets/entries/${encodeURIComponent(args.entry.trim())}`, body);
      const row = entryRow(e);
      return result(`Updated: ${entryLine(row)} (entry id ${row.id}).`, { entry: row }, ctx.token());
    },
  );

  defineTool(
    ctx,
    "start_timer",
    {
      title: "Start timer",
      description:
        "Starts the user's timer on a task; stop_timer logs the time. A person has one timer at a time — the server " +
        "refuses a second one — and it stops itself at the end of the day. " +
        CONFIRM_FIRST,
      inputSchema: {
        ...workspaceArg,
        task: z.string().min(1).describe("Task handle (CAT-12) or uuid. A timer always runs on a task."),
        billable: z.boolean().optional().describe("Default: the project's billing type."),
      },
      annotations: writeHints(false),
      access: writeOf("time:write", ["timesheets", "add"]),
    },
    async (args, session) => {
      const { base } = await session.wsPath(args.workspace);
      const t = await getTask(session.client, base, args.task);
      if (!t.project?.id) throw new ResolveError("Could not tell which project this task belongs to.");
      // Never `taskTitle`: that composes a new task on the board.
      const body: Record<string, unknown> = { projectUuid: t.project.id, taskUuid: t.id };
      if (args.billable !== undefined) body.billable = args.billable;
      const timer = await session.client.post<Timer>(`${base}/timesheets/timer`, body);
      const row = timerRow(timer);
      return result(
        `Timer started on ${taskHandle(t)} · ${untrusted("title", t.title)} at ${row.startedAt}` +
          `${row.stopsAt ? `; it stops itself at ${row.stopsAt}` : ""}. Call stop_timer to log it.`,
        { timer: row },
        ctx.token(),
      );
    },
  );

  defineTool(
    ctx,
    "stop_timer",
    {
      title: "Stop timer",
      description:
        "Stops the user's running timer and logs the time. If the server cannot log it (a locked day, a submitted " +
        "week) the minutes come back with the reason, and nothing is lost: offer log_time for them. " +
        CONFIRM_FIRST,
      inputSchema: { ...workspaceArg },
      annotations: writeHints(false),
      access: writeOf("time:write", ["timesheets", "add"]),
    },
    async (args, session) => {
      const { base } = await session.wsPath(args.workspace);
      const stop = await session.client.post<TimerStop>(`${base}/timesheets/timer/stop`);
      const duration = formatMinutes(stop.minutes);
      let text: string;
      if (stop.discarded) {
        text = `Timer stopped after less than a minute; nothing was logged.`;
      } else if (stop.refusal) {
        text =
          `Timer stopped, but the ${duration} on ${stop.date ?? "that day"} could NOT be logged: ` +
          `${stop.refusal.message ?? ""}${stop.refusal.code ? ` [${stop.refusal.code}]` : ""}. ` +
          "Tell the user, and offer to log the time with log_time.";
      } else {
        const e = stop.entry ? entryRow(stop.entry) : undefined;
        text = e ? `Timer stopped: logged ${entryLine(e)} (entry id ${e.id}).` : `Timer stopped: logged ${duration} on ${stop.date ?? ""}.`;
      }
      return result(
        text,
        {
          minutes: stop.minutes,
          date: stop.date ?? "",
          discarded: stop.discarded ?? false,
          entry: stop.entry ? entryRow(stop.entry) : null,
          refusal: stop.refusal ?? null,
        },
        ctx.token(),
      );
    },
  );
}
