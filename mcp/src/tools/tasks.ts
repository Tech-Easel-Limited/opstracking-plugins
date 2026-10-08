import { z } from "zod";
import { readOf, writeOf } from "../access.js";
import type { OpsTrackingClient } from "../client.js";
import { addDays, formatMinutes, hasMore, localToday, names, pagingLine, taskHandle, untrusted } from "../format.js";
import {
  isUuid,
  projectDetail,
  resolveColumn,
  resolveMembers,
  resolvePerson,
  ResolveError,
  TASK_HANDLE,
} from "../resolve.js";
import type { Session } from "../session.js";
import type { BulkResult, Page, ProjectDetail, Task, TaskComment, TaskDetail } from "../types.js";
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

export const TASK_TYPES = ["Epic", "Story", "Task", "Bug", "Feature", "Improvement", "Spike", "Chore"] as const;
export const PRIORITIES = ["Low", "Medium", "High", "Urgent"] as const;

const taskArg = z.string().min(1).describe("Task handle such as CAT-12, or the task uuid.");
const projectArg = z.string().min(1).describe("Project uuid, key (e.g. CAT) or exact name.");
const statusArg = z
  .string()
  .min(1)
  .describe("Status = board column name in the task's project (e.g. 'In Progress', 'Done'). See list_project_columns.");
const assigneesArg = z
  .array(z.string().min(1))
  .describe("People by exact name, email, member uuid, or 'me'. They must be on the project's roster.");
const effortArg = z
  .number()
  .positive()
  .max(10_000)
  .describe("Estimated effort in hours (decimals allowed, e.g. 1.5). Stored as minutes.");

export function taskRow(t: Task) {
  return {
    id: t.id,
    handle: taskHandle(t),
    title: t.title,
    project: t.project?.name ?? "",
    projectId: t.project?.id ?? "",
    status: t.column?.name ?? "",
    statusId: t.column?.id ?? "",
    priority: t.priority ?? "",
    type: t.type ?? "",
    start: t.start ?? "",
    due: t.due ?? "",
    overdue: t.overdue ?? false,
    done: t.done ?? false,
    estimateMinutes: t.estimateMinutes ?? null,
    assignees: (t.assignees ?? []).map((a) => ({ id: a.id, name: a.name ?? "" })),
    tags: t.tags ?? [],
    parent: t.parent ? { id: t.parent.id, title: t.parent.title ?? "" } : null,
    comments: t.comments ?? 0,
  };
}

function systemNoteText(n: { label: string; url: string }): string {
  return `GitHub: ${n.label}${n.url ? ` (${n.url})` : ""}`;
}

/** A comment's line in list_task_comments' text. A system note is the integration's own words, not a person's. */
function commentLine(c: ReturnType<typeof commentRow>): string {
  if (c.system) return `\n[${c.createdAt}] ${c.body}${c.replyTo ? " (reply)" : ""} (id ${c.id})`;
  return `\n[${c.createdAt}] ${c.author || "someone"}${c.replyTo ? " (reply)" : ""} (id ${c.id}):\n${untrusted("comment", c.body)}`;
}

export function taskLine(t: Task): string {
  const bits = [
    t.column?.name ? `status ${t.column.name}` : "",
    t.priority ? `priority ${t.priority}` : "",
    t.type ?? "",
    t.due ? `due ${t.due}${t.overdue ? " (overdue)" : ""}` : "",
    `assignees: ${names(t.assignees)}`,
  ].filter(Boolean);
  return `${taskHandle(t)} · ${untrusted("title", t.title)} — ${bits.join(" · ")}${t.project?.name ? ` [${untrusted("project", t.project.name)}]` : ""}`;
}

/**
 * One comment as the tools hand it back. A system note from the GitHub
 * integration has no author and an empty body; it reads as
 * "GitHub: <label> (<url>)" rather than as a blank comment from "someone".
 */
function commentRow(c: TaskComment) {
  const system = c.system ?? null;
  return {
    id: c.id,
    author: system ? "GitHub" : (c.author?.name ?? ""),
    authorId: system ? "" : (c.author?.id ?? ""),
    body: system ? systemNoteText(system) : c.body,
    system,
    createdAt: c.createdAt ?? "",
    editedAt: c.editedAt ?? null,
    replyTo: c.parentId ?? "",
  };
}

export function taskDetailText(t: TaskDetail, heading?: string): string {
  const lines = [
    heading ?? "",
    `${taskHandle(t)} · ${untrusted("title", t.title)} (id ${t.id})`,
    `Project: ${untrusted("project", t.project?.name) || "?"} · Status: ${t.column?.name ?? "?"} · Priority: ${t.priority ?? "?"} · Type: ${t.type ?? "Task"}`,
    `Assignees: ${names(t.assignees)}`,
    t.start || t.due ? `Dates: start ${t.start || "—"}, due ${t.due || "—"}${t.overdue ? " (overdue)" : ""}` : "",
    t.estimateMinutes ? `Estimate: ${formatMinutes(t.estimateMinutes)}` : "",
    t.trackedMinutes !== null && t.trackedMinutes !== undefined ? `Tracked: ${formatMinutes(t.trackedMinutes)}` : "",
    t.tags && t.tags.length > 0 ? `Tags: ${untrusted("tags", t.tags.join(", "))}` : "",
    t.parent ? `Parent: ${t.parent.title ? untrusted("title", t.parent.title) : t.parent.id}` : "",
    t.warning?.message ? `Warning: ${t.warning.message}` : "",
    t.desc ? `\nDescription:\n${untrusted("description", t.desc)}` : "",
  ];
  const subtasks = t.subtaskList ?? [];
  if (subtasks.length > 0) {
    lines.push(`\nSubtasks (${t.subtasksDone ?? 0}/${subtasks.length} done):`, ...subtasks.map((s) => `- ${taskLine(s)}`));
  }
  const comments = t.commentList ?? [];
  if (comments.length > 0) lines.push(`\n${comments.length} comment(s) — use list_task_comments to read them.`);
  return lines.filter(Boolean).join("\n");
}

function taskStructured(t: TaskDetail) {
  return {
    task: {
      ...taskRow(t),
      description: t.desc ?? "",
      trackedMinutes: t.trackedMinutes ?? null,
      subtasks: (t.subtaskList ?? []).map(taskRow),
      warning: t.warning ?? null,
    },
  };
}

export async function getTask(client: OpsTrackingClient, base: string, ref: string): Promise<TaskDetail> {
  const value = ref.trim();
  if (!isUuid(value) && !TASK_HANDLE.test(value)) {
    throw new ResolveError(`"${ref}" is not a task handle (like CAT-12) or a task uuid. Use list_tasks to find the task.`);
  }
  // The detail route takes either spelling; the key is matched case-insensitively.
  return client.get<TaskDetail>(`${base}/tasks/${encodeURIComponent(value)}`);
}

async function roster(session: Session, base: string, projectId: string): Promise<ProjectDetail> {
  return projectDetail(session.client, base, projectId);
}

/** A YYYY-MM-DD date, or null to clear it (sent as "", which the API reads as "no date"). */
const clearableDate = z.union([dateArg, z.null()]);

export function registerTaskTools(ctx: ToolContext): void {
  defineTool(
    ctx,
    "list_tasks",
    {
      title: "List tasks",
      description:
        "Lists tasks across projects with filters: search text, project, status (board column), assignee, priority, " +
        "tag and due-date windows. Paged.",
      inputSchema: {
        ...workspaceArg,
        q: z.string().optional().describe("Search text (title)."),
        project: projectArg.optional(),
        status: statusArg.optional().describe("Board column name — needs `project`, since columns are per project."),
        assignee: z.string().optional().describe("Assignee: 'me', exact name, email, or member uuid."),
        unassigned: z.boolean().optional().describe("Only tasks nobody is assigned to."),
        priority: z.enum(PRIORITIES).optional(),
        tag: z.string().optional(),
        dueBefore: dateArg.optional().describe("Due on or before this date (YYYY-MM-DD)."),
        dueWithinDays: z.number().int().min(0).max(365).optional().describe("Due within the next N days (from today)."),
        overdue: z.boolean().optional().describe("Only overdue tasks."),
        noDue: z.boolean().optional().describe("Only tasks without a due date."),
        sort: z.enum(["due", "priority", "title", "project", "status"]).optional(),
        ...pagingArgs,
      },
      annotations: READ,
      access: readOf("tasks"),
    },
    async (args, session) => {
      const { base } = await session.wsPath(args.workspace);
      const { page, size } = pageOf(args);
      let project: ProjectDetail | undefined;
      if (args.project) project = await roster(session, base, args.project);

      let columnUuid: string | undefined;
      if (args.status) {
        if (!project) {
          if (!isUuid(args.status)) throw new ResolveError("Filtering by status name needs `project` too: each project has its own columns.");
          columnUuid = args.status;
        } else {
          columnUuid = (await resolveColumn(session.client, base, project.id, args.status)).id;
        }
      }

      let assigneeMemberUuid: string | undefined;
      if (args.assignee) {
        if (project && args.assignee.trim().toLowerCase() !== "me") {
          assigneeMemberUuid = resolveMembers(project.memberList ?? [], [args.assignee])[0].id;
        } else {
          assigneeMemberUuid = await resolvePerson(session.client, base, args.assignee, () => session.myMemberId());
        }
      }

      let dueBefore = args.dueBefore;
      if (args.dueWithinDays !== undefined) {
        const limit = addDays(localToday(), args.dueWithinDays);
        dueBefore = dueBefore && dueBefore < limit ? dueBefore : limit;
      }

      const res = await session.client.get<Page<Task>>(`${base}/tasks`, {
        q: args.q,
        projectUuid: project?.id,
        columnUuid,
        assigneeMemberUuid,
        unassigned: args.unassigned ? "true" : undefined,
        priority: args.priority,
        tag: args.tag,
        dueBefore,
        overdue: args.overdue ? "true" : undefined,
        noDue: args.noDue ? "true" : undefined,
        sort: args.sort,
        page,
        size,
      });
      const tasks = res.rows ?? [];
      const paging = { page, size, total: res.total ?? tasks.length, shown: tasks.length };
      const text = [...tasks.map((t) => `- ${taskLine(t)}`), pagingLine(paging)].join("\n");
      return result(text, { rows: tasks.map(taskRow), total: paging.total, page, size, hasMore: hasMore(paging) }, ctx.token());
    },
  );

  defineTool(
    ctx,
    "get_task",
    {
      title: "Get task",
      description: "One task in full: description, status, assignees, dates, estimate, tracked time and subtasks.",
      inputSchema: { ...workspaceArg, task: taskArg },
      annotations: READ,
      access: readOf("tasks"),
    },
    async (args, session) => {
      const { base } = await session.wsPath(args.workspace);
      const t = await getTask(session.client, base, args.task);
      return result(taskDetailText(t), taskStructured(t), ctx.token());
    },
  );

  defineTool(
    ctx,
    "list_task_comments",
    {
      title: "List task comments",
      description: "The comment thread on a task, oldest first. Replies name the comment they answer.",
      inputSchema: { ...workspaceArg, task: taskArg },
      annotations: READ,
      access: readOf("tasks"),
    },
    async (args, session) => {
      const { base } = await session.wsPath(args.workspace);
      const t = await getTask(session.client, base, args.task);
      const comments = (t.commentList ?? []).map(commentRow);
      const text = [
        `${taskHandle(t)} · ${untrusted("title", t.title)} — ${comments.length} comment(s)`,
        ...comments.map(commentLine),
      ].join("\n");
      return result(text, { taskId: t.id, comments }, ctx.token());
    },
  );

  defineTool(
    ctx,
    "create_task",
    {
      title: "Create task",
      description:
        "Creates a task in a project. Status is a board column name (defaults to the first column); assignees must be " +
        "on the project roster; effort is in hours. " +
        CONFIRM_FIRST,
      inputSchema: {
        ...workspaceArg,
        project: projectArg,
        title: z.string().min(1).max(500),
        description: z.string().optional().describe("Markdown."),
        type: z.enum(TASK_TYPES).optional().describe("Default Task."),
        priority: z.enum(PRIORITIES).optional().describe("Default Medium."),
        status: statusArg.optional(),
        startOn: dateArg.optional(),
        dueOn: dateArg.optional(),
        effortHours: effortArg.optional(),
        assignees: assigneesArg.optional(),
        tags: z.array(z.string().min(1)).optional(),
        parent: taskArg.optional().describe("Create as a subtask of this task (same project)."),
      },
      annotations: writeHints(false),
      access: writeOf("tasks:write", ["tasks", "add"]),
    },
    async (args, session) => {
      const { base } = await session.wsPath(args.workspace);
      const project = await roster(session, base, args.project);
      const body: Record<string, unknown> = { title: args.title.trim() };
      if (args.description !== undefined) body.desc = args.description;
      if (args.type) body.type = args.type;
      if (args.priority) body.priority = args.priority;
      if (args.status) body.columnUuid = (await resolveColumn(session.client, base, project.id, args.status)).id;
      if (args.startOn) body.startOn = args.startOn;
      if (args.dueOn) body.dueOn = args.dueOn;
      if (args.effortHours !== undefined) body.estimateMinutes = Math.round(args.effortHours * 60);
      if (args.assignees && args.assignees.length > 0) {
        const me = args.assignees.some((a) => a.trim().toLowerCase() === "me") ? await session.myMemberId() : undefined;
        body.assigneeUuids = resolveMembers(project.memberList ?? [], args.assignees, me).map((m) => m.id);
      }
      if (args.tags) body.tags = args.tags;
      if (args.parent) {
        const parent = await getTask(session.client, base, args.parent);
        if (parent.project?.id && parent.project.id !== project.id) {
          throw new ResolveError(`${taskHandle(parent)} is in ${parent.project.name ?? "another project"}; a subtask must be in the same project.`);
        }
        body.parentUuid = parent.id;
      }
      const created = await session.client.post<TaskDetail>(`${base}/projects/${project.id}/tasks`, body);
      return result(taskDetailText(created, "Created:"), taskStructured(created), ctx.token());
    },
  );

  defineTool(
    ctx,
    "update_task",
    {
      title: "Update task",
      description:
        "Changes a task. Only the fields given change. `status` moves the task to that board column; `assignees` " +
        "replaces the whole assignee list; `tags` replaces all tags; pass null for startOn/dueOn to clear a date. " +
        CONFIRM_FIRST,
      inputSchema: {
        ...workspaceArg,
        task: taskArg,
        title: z.string().min(1).max(500).optional(),
        description: z.string().optional().describe("Markdown. Replaces the whole description."),
        type: z.enum(TASK_TYPES).optional(),
        priority: z.enum(PRIORITIES).optional(),
        status: statusArg.optional(),
        startOn: clearableDate.optional(),
        dueOn: clearableDate.optional(),
        effortHours: effortArg.optional(),
        assignees: assigneesArg.optional(),
        tags: z.array(z.string().min(1)).optional(),
      },
      annotations: writeHints(true),
      access: writeOf("tasks:write", ["tasks", "edit"]),
    },
    async (args, session) => {
      const { base } = await session.wsPath(args.workspace);
      const current = await getTask(session.client, base, args.task);
      const projectId = current.project?.id;
      if (!projectId) throw new ResolveError("Could not tell which project this task belongs to.");

      const body: Record<string, unknown> = {};
      if (args.title !== undefined) body.title = args.title.trim();
      if (args.description !== undefined) body.desc = args.description;
      if (args.type) body.type = args.type;
      if (args.priority) body.priority = args.priority;
      if (args.status) body.columnUuid = (await resolveColumn(session.client, base, projectId, args.status)).id;
      if (args.startOn !== undefined) body.startOn = args.startOn ?? "";
      if (args.dueOn !== undefined) body.dueOn = args.dueOn ?? "";
      if (args.effortHours !== undefined) body.estimateMinutes = Math.round(args.effortHours * 60);
      if (args.tags) body.tags = args.tags;

      let assigneeUuids: string[] | undefined;
      if (args.assignees) {
        const project = await roster(session, base, projectId);
        const me = args.assignees.some((a) => a.trim().toLowerCase() === "me") ? await session.myMemberId() : undefined;
        assigneeUuids = resolveMembers(project.memberList ?? [], args.assignees, me).map((m) => m.id);
      }
      if (Object.keys(body).length === 0 && assigneeUuids === undefined) {
        throw new ResolveError("Nothing to update: pass at least one field to change.");
      }

      let updated: TaskDetail = current;
      // The PATCH ignores assignees (task_service.go Update never reads them),
      // so they go through their own declarative PUT.
      if (Object.keys(body).length > 0) updated = await session.client.patch<TaskDetail>(`${base}/tasks/${current.id}`, body);
      const warning = updated.warning;
      if (assigneeUuids !== undefined) {
        updated = await session.client.put<TaskDetail>(`${base}/tasks/${current.id}/assignees`, { memberUuids: assigneeUuids });
        if (warning && !updated.warning) updated = { ...updated, warning };
      }
      return result(taskDetailText(updated, "Updated:"), taskStructured(updated), ctx.token());
    },
  );

  defineTool(
    ctx,
    "set_task_assignees",
    {
      title: "Set task assignees",
      description:
        "Replaces who is assigned to a task. Pass an empty list to unassign everyone. People must be on the project roster. " +
        CONFIRM_FIRST,
      inputSchema: { ...workspaceArg, task: taskArg, assignees: assigneesArg },
      annotations: writeHints(true),
      access: writeOf("tasks:write", ["tasks", "assign"]),
    },
    async (args, session) => {
      const { base } = await session.wsPath(args.workspace);
      const current = await getTask(session.client, base, args.task);
      const projectId = current.project?.id;
      if (!projectId) throw new ResolveError("Could not tell which project this task belongs to.");
      let memberUuids: string[] = [];
      if (args.assignees.length > 0) {
        const project = await roster(session, base, projectId);
        const me = args.assignees.some((a) => a.trim().toLowerCase() === "me") ? await session.myMemberId() : undefined;
        memberUuids = resolveMembers(project.memberList ?? [], args.assignees, me).map((m) => m.id);
      }
      const updated = await session.client.put<TaskDetail>(`${base}/tasks/${current.id}/assignees`, { memberUuids });
      return result(taskDetailText(updated, "Assignees set:"), taskStructured(updated), ctx.token());
    },
  );

  defineTool(
    ctx,
    "add_task_comment",
    {
      title: "Add task comment",
      description:
        "Posts a comment (markdown) on a task, optionally as a reply to an existing comment. Comments cannot be " +
        "deleted through this server, so double-check the text. " +
        CONFIRM_FIRST,
      inputSchema: {
        ...workspaceArg,
        task: taskArg,
        body: z.string().min(1).max(20_000).describe("Markdown."),
        replyTo: z.string().optional().describe("Comment id to reply to (see list_task_comments)."),
      },
      annotations: writeHints(false),
      access: writeOf("tasks:write", ["tasks", "view"]),
    },
    async (args, session) => {
      const { base } = await session.wsPath(args.workspace);
      const t = await getTask(session.client, base, args.task);
      const body: Record<string, unknown> = { body: args.body };
      if (args.replyTo) body.parentId = args.replyTo;
      const c = await session.client.post<TaskComment>(`${base}/tasks/${t.id}/comments`, body);
      return result(
        `Comment added to ${taskHandle(t)} · ${untrusted("title", t.title)} (comment id ${c.id}).`,
        { taskId: t.id, comment: commentRow(c) },
        ctx.token(),
      );
    },
  );
  defineTool(
    ctx,
    "bulk_update_tasks",
    {
      title: "Bulk update tasks",
      description:
        "One change over several tasks at once: move them all to a status (board column), add assignees to them " +
        "all, or set one priority on them all. Status and assignees need every task in the same project (columns " +
        "and rosters are per project); priority works across projects. Assignees are ADDED — nobody is taken off. " +
        "Tasks the user cannot see are skipped, and the result says how many changed. " +
        CONFIRM_FIRST,
      inputSchema: {
        ...workspaceArg,
        tasks: z.array(taskArg).min(1).max(50).describe("Task handles (CAT-12) or uuids."),
        action: z.enum(["status", "assign", "priority"]),
        status: statusArg.optional().describe("With action=status: the column to move them to."),
        assignees: assigneesArg.optional().describe("With action=assign: people to add to every task."),
        priority: z.enum(PRIORITIES).optional().describe("With action=priority."),
      },
      annotations: writeHints(true),
      access: writeOf("tasks:write", ["tasks", "edit"]),
    },
    async (args, session) => {
      const { base } = await session.wsPath(args.workspace);
      const tasks: TaskDetail[] = [];
      for (const ref of args.tasks) {
        const t = await getTask(session.client, base, ref);
        if (!tasks.some((x) => x.id === t.id)) tasks.push(t);
      }
      const body: Record<string, unknown> = { taskUuids: tasks.map((t) => t.id), action: args.action };
      let change: string;
      if (args.action === "priority") {
        if (!args.priority) throw new ResolveError("action=priority needs `priority`.");
        body.priority = args.priority;
        change = `priority ${args.priority}`;
      } else {
        const projects = [...new Set(tasks.map((t) => t.project?.id ?? ""))];
        if (projects.length !== 1 || projects[0] === "") {
          throw new ResolveError(
            `action=${args.action} needs every task in one project; these span ${projects.length}. Split the change by project.`,
          );
        }
        if (args.action === "status") {
          if (!args.status) throw new ResolveError("action=status needs `status`.");
          const col = await resolveColumn(session.client, base, projects[0], args.status);
          body.columnUuid = col.id;
          change = `status ${col.name}`;
        } else {
          if (!args.assignees || args.assignees.length === 0) throw new ResolveError("action=assign needs `assignees`.");
          const project = await roster(session, base, projects[0]);
          const me = args.assignees.some((a) => a.trim().toLowerCase() === "me") ? await session.myMemberId() : undefined;
          const people = resolveMembers(project.memberList ?? [], args.assignees, me);
          body.memberUuids = people.map((m) => m.id);
          change = `added ${people.map((m) => m.name).join(", ")}`;
        }
      }
      const res = await session.client.post<BulkResult>(`${base}/tasks/bulk`, body);
      const handles = tasks.map((t) => taskHandle(t));
      const text = [
        `${res.affected} of ${tasks.length} task(s) changed (${change}): ${handles.join(", ")}.`,
        res.affected < tasks.length ? "The rest were not visible to the user, or already in that state." : "",
        res.warning?.message ? `Warning: ${res.warning.message}` : "",
      ]
        .filter(Boolean)
        .join("\n");
      return result(text, { affected: res.affected, tasks: handles, warning: res.warning ?? null }, ctx.token());
    },
  );

  defineTool(
    ctx,
    "set_task_parent",
    {
      title: "Set task parent",
      description:
        "Makes a task a subtask of another task in the same project, or — with parent null — a top-level task again. " +
        CONFIRM_FIRST,
      inputSchema: {
        ...workspaceArg,
        task: taskArg,
        parent: z.union([taskArg, z.null()]).describe("The new parent (handle or uuid), or null to make it top-level."),
      },
      annotations: writeHints(true),
      access: writeOf("tasks:write", ["tasks", "edit"]),
    },
    async (args, session) => {
      const { base } = await session.wsPath(args.workspace);
      const t = await getTask(session.client, base, args.task);
      let parentUuid: string | null = null;
      if (args.parent !== null) {
        const parent = await getTask(session.client, base, args.parent);
        if (parent.id === t.id) throw new ResolveError("A task cannot be its own parent.");
        if (parent.project?.id && t.project?.id && parent.project.id !== t.project.id) {
          throw new ResolveError(`${taskHandle(parent)} is in another project; a subtask must be in the same project.`);
        }
        parentUuid = parent.id;
      }
      const updated = await session.client.patch<TaskDetail>(`${base}/tasks/${t.id}/parent`, { parentUuid });
      return result(taskDetailText(updated, parentUuid ? "Parent set:" : "Now a top-level task:"), taskStructured(updated), ctx.token());
    },
  );
}
