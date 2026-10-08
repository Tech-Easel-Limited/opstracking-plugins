import { z } from "zod";
import { readOf, writeOf } from "../access.js";
import { formatMinutes, hasMore, pagingLine, untrusted } from "../format.js";
import { listColumns, projectDetail, resolveClient, resolveColumn, resolvePerson, ResolveError } from "../resolve.js";
import type { Session } from "../session.js";
import type { BoardColumn, Page, Project, ProjectDetail, ProjectMember } from "../types.js";
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

const projectArg = z
  .string()
  .min(1)
  .describe("Project uuid, key (the letters in task handles, e.g. CAT) or exact name.");

export function projectRow(p: Project) {
  return {
    id: p.id,
    key: p.key ?? "",
    name: p.name,
    status: p.status ?? "",
    client: p.client?.name ?? "",
    clientId: p.client?.id ?? "",
    manager: p.manager?.name ?? "",
    start: p.start ?? "",
    end: p.end ?? "",
    tasksDone: p.tasksDone ?? 0,
    tasksTotal: p.tasksTotal ?? 0,
    progress: p.progress ?? 0,
  };
}

function memberRow(m: ProjectMember) {
  return { id: m.id, name: m.name, email: m.email ?? "", role: m.role ?? "", isClient: m.isClient ?? false };
}

function columnRow(c: BoardColumn) {
  return { id: c.id, name: c.name, done: c.done ?? false, tasks: c.tasks ?? 0, wipLimit: c.wipLimit ?? null };
}

/** One project as get_project and every project write answer it. */
function projectResult(p: ProjectDetail, columns: BoardColumn[], heading: string | undefined, token?: string) {
  const members = (p.memberList ?? []).map(memberRow);
  const row = projectRow(p);
  const text = [
    heading ?? "",
    `${untrusted("project", p.name)}${p.key ? ` [${p.key}]` : ""} — ${row.status} (id ${p.id})`,
    row.client ? `Client: ${untrusted("client", row.client)}` : "",
    row.manager ? `Manager: ${row.manager}` : "",
    row.start || row.end ? `Dates: ${row.start || "?"} → ${row.end || "?"}` : "",
    `Tasks: ${row.tasksDone}/${row.tasksTotal} done (${row.progress}%)`,
    p.loggedMinutes !== undefined && p.loggedMinutes !== null ? `Logged: ${formatMinutes(p.loggedMinutes)}` : "",
    p.desc ? `\n${untrusted("description", p.desc)}\n` : "",
    `Statuses (board columns, in order): ${columns.map((c) => c.name).join(" → ") || "none"}`,
    `Members (${members.length}): ${members.map((m) => m.name || m.email || m.id).join(", ") || "none visible"}`,
  ]
    .filter(Boolean)
    .join("\n");
  return result(
    text,
    {
      project: { ...row, description: p.desc ?? "", billing: p.billing ?? "", currency: p.currency ?? "", loggedMinutes: p.loggedMinutes ?? null },
      columns: columns.map(columnRow),
      members,
    },
    token,
  );
}

const BILLING = ["Hourly", "Fixed Price", "Non-billable"] as const;

const projectFields = {
  description: z.string().max(20_000).optional().describe("Markdown."),
  client: z.string().min(1).optional().describe("Client uuid, exact name or short name."),
  manager: z.string().min(1).optional().describe("Project manager: 'me', exact name, email or member uuid."),
  lead: z.string().min(1).optional().describe("Project lead: 'me', exact name, email or member uuid."),
  billing: z
    .enum(BILLING)
    .optional()
    .describe("How the project bills. A Fixed Price project gets its amount and period in the app; until then its invoices warn."),
  startOn: dateArg.optional(),
  endOn: dateArg.optional(),
  allowNoTask: z.boolean().optional().describe("Whether time may be logged on the project without naming a task."),
};

type ProjectFields = {
  name?: string;
  description?: string;
  client?: string;
  manager?: string;
  lead?: string;
  billing?: (typeof BILLING)[number];
  currency?: string;
  startOn?: string;
  endOn?: string;
  allowNoTask?: boolean;
};

/**
 * The project create/edit body (service.ProjectInput) from friendly fields.
 * Never carries a rate: rates are money, and they stay in the app.
 */
async function projectBody(session: Session, base: string, args: ProjectFields): Promise<Record<string, unknown>> {
  if (args.startOn && args.endOn && args.startOn > args.endOn) throw new ResolveError("`startOn` must be on or before `endOn`.");
  const me = () => session.myMemberId();
  const body: Record<string, unknown> = {};
  if (args.name !== undefined) body.name = args.name.trim();
  if (args.description !== undefined) body.desc = args.description;
  if (args.client) body.clientUuid = (await resolveClient(session.client, base, args.client)).id;
  if (args.manager) body.managerMemberUuid = await resolvePerson(session.client, base, args.manager, me);
  if (args.lead) body.leadMemberUuid = await resolvePerson(session.client, base, args.lead, me);
  if (args.billing) body.billingType = args.billing;
  if (args.currency) body.currency = args.currency.toUpperCase();
  if (args.startOn) body.startOn = args.startOn;
  if (args.endOn) body.endOn = args.endOn;
  if (args.allowNoTask !== undefined) body.allowNoTask = args.allowNoTask;
  return body;
}

export function registerProjectTools(ctx: ToolContext): void {
  defineTool(
    ctx,
    "list_projects",
    {
      title: "List projects",
      description: "Lists projects in a workspace, with search, a status filter, a client filter and paging.",
      inputSchema: {
        ...workspaceArg,
        q: z.string().optional().describe("Search text."),
        status: z
          .enum(["all", "active", "paused", "completed", "closed"])
          .optional()
          .describe("Status filter. Default all."),
        client: z.string().optional().describe("Only this client's projects — client uuid or exact name."),
        ...pagingArgs,
      },
      annotations: READ,
      access: readOf("projects"),
    },
    async (args, session) => {
      const { base } = await session.wsPath(args.workspace);
      const { page, size } = pageOf(args);
      const clientUuid = args.client ? (await resolveClient(session.client, base, args.client)).id : undefined;
      const res = await session.client.get<Page<Project>>(`${base}/projects`, {
        q: args.q,
        tab: args.status ?? "all",
        clientUuid,
        page,
        size,
      });
      const rows = (res.rows ?? []).map(projectRow);
      const paging = { page, size, total: res.total ?? rows.length, shown: rows.length };
      const text = [
        ...rows.map(
          (p) =>
            `- ${untrusted("project", p.name)}${p.key ? ` [${p.key}]` : ""} — ${p.status}${p.client ? ` · client ${untrusted("client", p.client)}` : ""}` +
            ` · ${p.tasksDone}/${p.tasksTotal} tasks done (id ${p.id})`,
        ),
        pagingLine(paging),
      ].join("\n");
      return result(text, { rows, total: paging.total, page, size, hasMore: hasMore(paging) }, ctx.token());
    },
  );

  defineTool(
    ctx,
    "get_project",
    {
      title: "Get project",
      description: "One project's details: status, client, dates, progress, its board columns (task statuses) and its members.",
      inputSchema: { ...workspaceArg, project: projectArg },
      annotations: READ,
      access: readOf("projects"),
    },
    async (args, session) => {
      const { base } = await session.wsPath(args.workspace);
      const p = await projectDetail(session.client, base, args.project);
      const columns = await listColumns(session.client, base, p.id);
      return projectResult(p, columns, undefined, ctx.token());
    },
  );

  defineTool(
    ctx,
    "list_project_columns",
    {
      title: "List project statuses",
      description:
        "Lists a project's board columns in order. Columns are the task statuses: moving a task to a column changes " +
        "its status, and the last column is the 'done' one.",
      inputSchema: { ...workspaceArg, project: projectArg },
      annotations: READ,
      access: readOf("projects"),
    },
    async (args, session) => {
      const { base } = await session.wsPath(args.workspace);
      const p = await projectDetail(session.client, base, args.project);
      const columns = await listColumns(session.client, base, p.id);
      const rows = columns.map((c) => ({
        id: c.id,
        name: c.name,
        position: c.position ?? 0,
        tasks: c.tasks ?? 0,
        wipLimit: c.wipLimit ?? null,
        wipExceeded: c.wipExceeded ?? false,
        done: c.done ?? false,
      }));
      const text = [
        `Statuses for ${untrusted("project", p.name)}:`,
        ...rows.map(
          (c, i) =>
            `${i + 1}. ${c.name} — ${c.tasks} task(s)${c.wipLimit ? `, WIP limit ${c.wipLimit}${c.wipExceeded ? " (exceeded)" : ""}` : ""}` +
            `${c.done ? " [done column]" : ""} (id ${c.id})`,
        ),
      ].join("\n");
      return result(text, { projectId: p.id, columns: rows }, ctx.token());
    },
  );

  defineTool(
    ctx,
    "list_project_members",
    {
      title: "List project members",
      description: "Lists the people on a project's roster. Only these people can be assigned to the project's tasks.",
      inputSchema: { ...workspaceArg, project: projectArg },
      annotations: READ,
      access: readOf("projects"),
    },
    async (args, session) => {
      const { base } = await session.wsPath(args.workspace);
      const p = await projectDetail(session.client, base, args.project);
      const members = (p.memberList ?? []).map(memberRow);
      const text = [
        `Members of ${untrusted("project", p.name)} (${members.length}):`,
        ...members.map((m) => `- ${m.name || "(name hidden)"}${m.email ? ` <${m.email}>` : ""}${m.role ? ` — ${m.role}` : ""}${m.isClient ? " [client]" : ""} (id ${m.id})`),
      ].join("\n");
      return result(text, { projectId: p.id, members }, ctx.token());
    },
  );
  defineTool(
    ctx,
    "create_project",
    {
      title: "Create project",
      description:
        "Creates a project. It starts Active with the default board columns, and the user is put on its roster. " +
        "Rates are not set here — they stay in the app. " +
        CONFIRM_FIRST,
      inputSchema: {
        ...workspaceArg,
        name: z.string().min(1).max(200),
        ...projectFields,
        currency: z.string().regex(/^[A-Za-z]{3}$/).optional().describe("ISO currency code. Default: the workspace's."),
      },
      annotations: writeHints(false),
      access: writeOf("projects:write", ["projects", "add"]),
    },
    async (args, session) => {
      const { base } = await session.wsPath(args.workspace);
      const created = await session.client.post<ProjectDetail>(`${base}/projects`, await projectBody(session, base, args));
      const columns = await listColumns(session.client, base, created.id);
      return projectResult(created, columns, "Created:", ctx.token());
    },
  );

  defineTool(
    ctx,
    "update_project",
    {
      title: "Update project",
      description:
        "Changes a project's name, description, client, manager, lead, billing type, dates or whether time needs a " +
        "task. Only the fields given change. Status has its own tool (set_project_status); rates stay in the app. " +
        CONFIRM_FIRST,
      inputSchema: { ...workspaceArg, project: projectArg, name: z.string().min(1).max(200).optional(), ...projectFields },
      annotations: writeHints(true),
      access: writeOf("projects:write", ["projects", "edit"]),
    },
    async (args, session) => {
      const { base } = await session.wsPath(args.workspace);
      const current = await projectDetail(session.client, base, args.project);
      const body = await projectBody(session, base, args);
      if (Object.keys(body).length === 0) throw new ResolveError("Nothing to update: pass at least one field to change.");
      const updated = await session.client.patch<ProjectDetail>(`${base}/projects/${current.id}`, body);
      const columns = await listColumns(session.client, base, updated.id);
      return projectResult(updated, columns, "Updated:", ctx.token());
    },
  );

  defineTool(
    ctx,
    "set_project_status",
    {
      title: "Set project status",
      description:
        "Sets a project Active, Paused or Completed (Active also reopens an archived project). To close a " +
        "project use archive_project. " +
        CONFIRM_FIRST,
      inputSchema: { ...workspaceArg, project: projectArg, status: z.enum(["Active", "Paused", "Completed"]) },
      annotations: writeHints(true),
      access: writeOf("projects:write", ["projects", "status"]),
    },
    async (args, session) => {
      const { base } = await session.wsPath(args.workspace);
      const current = await projectDetail(session.client, base, args.project);
      const updated = await session.client.post<ProjectDetail>(`${base}/projects/${current.id}/status`, {
        status: args.status.toLowerCase(),
      });
      const columns = await listColumns(session.client, base, updated.id);
      return projectResult(updated, columns, `Status set to ${args.status}:`, ctx.token());
    },
  );

  defineTool(
    ctx,
    "archive_project",
    {
      title: "Archive project",
      description:
        "Closes a project (status Closed). Nothing is deleted: its tasks, time and invoices stay, and " +
        "set_project_status Active reopens it. " +
        CONFIRM_FIRST,
      inputSchema: { ...workspaceArg, project: projectArg },
      annotations: writeHints(true),
      access: writeOf("projects:write", ["projects", "archive"]),
    },
    async (args, session) => {
      const { base } = await session.wsPath(args.workspace);
      const current = await projectDetail(session.client, base, args.project);
      const updated = await session.client.post<ProjectDetail>(`${base}/projects/${current.id}/archive`);
      const columns = await listColumns(session.client, base, updated.id);
      return projectResult(updated, columns, "Archived:", ctx.token());
    },
  );

  const wipArg = z
    .number()
    .int()
    .min(0)
    .max(999)
    .describe("Most tasks the column should hold; 0 removes the limit. Going over warns, it never blocks.");
  const positionArg = z.number().int().min(1).describe("Place on the board, 1 = first column.");

  defineTool(
    ctx,
    "create_project_column",
    {
      title: "Create board column",
      description:
        "Adds a board column (a task status) to a project. A new column goes at the END of the board, which makes " +
        "it the 'done' column, unless `position` places it earlier — say which the user wants. " +
        CONFIRM_FIRST,
      inputSchema: { ...workspaceArg, project: projectArg, name: z.string().min(1).max(60), wipLimit: wipArg.optional(), position: positionArg.optional() },
      annotations: writeHints(false),
      access: writeOf("projects:write", ["projects", "edit"]),
    },
    async (args, session) => {
      const { base } = await session.wsPath(args.workspace);
      const p = await projectDetail(session.client, base, args.project);
      const body: Record<string, unknown> = { name: args.name.trim() };
      if (args.wipLimit !== undefined) body.wipLimit = args.wipLimit;
      let col = await session.client.post<BoardColumn>(`${base}/projects/${p.id}/columns`, body);
      // The create route always appends; placing it is a second write.
      if (args.position !== undefined) {
        col = await session.client.patch<BoardColumn>(`${base}/projects/${p.id}/columns/${col.id}`, { position: args.position - 1 });
      }
      const columns = await listColumns(session.client, base, p.id);
      return columnsResult(p, columns, `Column ${col.name} added (id ${col.id}).`, ctx.token());
    },
  );

  defineTool(
    ctx,
    "update_project_column",
    {
      title: "Update board column",
      description:
        "Renames a board column, changes its WIP limit, or moves it. Moving a column to the end makes it the " +
        "'done' column. " +
        CONFIRM_FIRST,
      inputSchema: {
        ...workspaceArg,
        project: projectArg,
        column: z.string().min(1).describe("Column name or uuid."),
        name: z.string().min(1).max(60).optional(),
        wipLimit: wipArg.optional(),
        position: positionArg.optional(),
      },
      annotations: writeHints(true),
      access: writeOf("projects:write", ["projects", "edit"]),
    },
    async (args, session) => {
      const { base } = await session.wsPath(args.workspace);
      const p = await projectDetail(session.client, base, args.project);
      const col = await resolveColumn(session.client, base, p.id, args.column);
      const body: Record<string, unknown> = {};
      if (args.name !== undefined) body.name = args.name.trim();
      if (args.wipLimit !== undefined) body.wipLimit = args.wipLimit;
      if (args.position !== undefined) body.position = args.position - 1;
      if (Object.keys(body).length === 0) throw new ResolveError("Nothing to update: pass `name`, `wipLimit` or `position`.");
      await session.client.patch<BoardColumn>(`${base}/projects/${p.id}/columns/${col.id}`, body);
      const columns = await listColumns(session.client, base, p.id);
      return columnsResult(p, columns, `Column ${col.name} updated.`, ctx.token());
    },
  );
}

/** The board after a column change, in order, with the done column marked. */
function columnsResult(p: Project, columns: BoardColumn[], heading: string, token?: string) {
  const rows = columns.map(columnRow);
  const text = [
    heading,
    `Statuses for ${untrusted("project", p.name)}, in order: ${rows.map((c) => `${c.name}${c.done ? " [done column]" : ""}`).join(" → ")}`,
  ].join("\n");
  return result(text, { projectId: p.id, columns: rows }, token);
}
