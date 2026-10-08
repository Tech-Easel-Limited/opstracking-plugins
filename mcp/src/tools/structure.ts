import { z } from "zod";
import { readOf, writeOf } from "../access.js";
import { untrusted } from "../format.js";
import { resolveDepartment, resolvePerson, resolveTeam, ResolveError } from "../resolve.js";
import type { Session } from "../session.js";
import type { Department, List, Team } from "../types.js";
import { CONFIRM_FIRST, defineTool, READ, result, workspaceArg, writeHints, type ToolContext } from "./common.js";

/**
 * Departments and teams: how a workspace groups its people. Archiving is the
 * way out — deleting either stays in the app.
 */

function departmentRow(d: Department) {
  return {
    id: d.id,
    name: d.name,
    description: d.desc ?? "",
    head: d.head?.name ?? "",
    headId: d.head?.id ?? "",
    members: d.members ?? 0,
    projects: d.projects ?? 0,
    status: d.status ?? "",
  };
}

function teamRow(t: Team) {
  return {
    id: t.id,
    name: t.name,
    department: t.department?.name ?? "",
    departmentId: t.department?.id ?? "",
    lead: t.lead?.name ?? "",
    leadId: t.lead?.id ?? "",
    members: t.members ?? 0,
    projects: t.projects ?? 0,
    status: t.status ?? "",
  };
}

const departmentLine = (d: ReturnType<typeof departmentRow>) =>
  `${untrusted("department", d.name)} — ${d.status}${d.head ? ` · head ${d.head}` : ""} · ${d.members} member(s) · ` +
  `${d.projects} project(s) (id ${d.id})${d.description ? `\n  ${untrusted("description", d.description)}` : ""}`;

const teamLine = (t: ReturnType<typeof teamRow>) =>
  `${untrusted("team", t.name)}${t.department ? ` in ${untrusted("department", t.department)}` : ""} — ${t.status}` +
  `${t.lead ? ` · lead ${t.lead}` : ""} · ${t.members} member(s) (id ${t.id})`;

const statusArg = z.enum(["all", "active", "archived"]).optional().describe("Default all.");
const personArg = z.string().min(1);
const people = (session: Session, base: string, inputs: string[]) =>
  Promise.all(inputs.map((p) => resolvePerson(session.client, base, p, () => session.myMemberId())));

export function registerStructureTools(ctx: ToolContext): void {
  defineTool(
    ctx,
    "list_departments",
    {
      title: "List departments",
      description: "Lists the workspace's departments with their head, member and project counts.",
      inputSchema: { ...workspaceArg, q: z.string().optional().describe("Search text."), status: statusArg },
      annotations: READ,
      access: readOf("departments"),
    },
    async (args, session) => {
      const { base } = await session.wsPath(args.workspace);
      const res = await session.client.get<List<Department>>(`${base}/departments`, { q: args.q, status: args.status });
      const rows = (res.rows ?? []).map(departmentRow);
      const text = rows.length === 0 ? "No departments." : rows.map((d) => `- ${departmentLine(d)}`).join("\n");
      return result(text, { rows, total: res.total ?? rows.length }, ctx.token());
    },
  );

  defineTool(
    ctx,
    "list_teams",
    {
      title: "List teams",
      description: "Lists the workspace's teams with their department, lead and member count.",
      inputSchema: {
        ...workspaceArg,
        q: z.string().optional().describe("Search text."),
        status: statusArg,
        department: z.string().optional().describe("Only this department's teams — uuid or exact name."),
      },
      annotations: READ,
      access: readOf("teams"),
    },
    async (args, session) => {
      const { base } = await session.wsPath(args.workspace);
      const departmentUuid = args.department ? (await resolveDepartment(session.client, base, args.department)).id : undefined;
      const res = await session.client.get<List<Team>>(`${base}/teams`, { q: args.q, status: args.status, departmentUuid });
      const rows = (res.rows ?? []).map(teamRow);
      const text = rows.length === 0 ? "No teams." : rows.map((t) => `- ${teamLine(t)}`).join("\n");
      return result(text, { rows, total: res.total ?? rows.length }, ctx.token());
    },
  );

  const departmentArg = z.string().min(1).describe("Department uuid or exact name.");
  const departmentResult = (d: Department, heading: string) =>
    result(`${heading}\n${departmentLine(departmentRow(d))}`, { department: departmentRow(d) }, ctx.token());

  defineTool(
    ctx,
    "create_department",
    {
      title: "Create department",
      description: "Adds a department, optionally with its head. " + CONFIRM_FIRST,
      inputSchema: {
        ...workspaceArg,
        name: z.string().min(1).max(100),
        description: z.string().max(2000).optional(),
        head: personArg.optional().describe("Department head: 'me', exact name, email or member uuid."),
      },
      annotations: writeHints(false),
      access: writeOf("structure:write", ["departments", "add"]),
    },
    async (args, session) => {
      const { base } = await session.wsPath(args.workspace);
      const body: Record<string, unknown> = { name: args.name.trim() };
      if (args.description !== undefined) body.desc = args.description;
      if (args.head) body.headMemberUuid = (await people(session, base, [args.head]))[0];
      return departmentResult(await session.client.post<Department>(`${base}/departments`, body), "Created:");
    },
  );

  defineTool(
    ctx,
    "update_department",
    {
      title: "Update department",
      description: "Renames a department, changes its description, or its head (null removes the head). " + CONFIRM_FIRST,
      inputSchema: {
        ...workspaceArg,
        department: departmentArg,
        name: z.string().min(1).max(100).optional(),
        description: z.string().max(2000).optional(),
        head: z.union([personArg, z.null()]).optional().describe("New head ('me', name, email or member uuid), or null for none."),
      },
      annotations: writeHints(true),
      access: writeOf("structure:write", ["departments", "edit"]),
    },
    async (args, session) => {
      const { base } = await session.wsPath(args.workspace);
      const d = await resolveDepartment(session.client, base, args.department);
      const body: Record<string, unknown> = {};
      if (args.name !== undefined) body.name = args.name.trim();
      if (args.description !== undefined) body.desc = args.description;
      // An explicit null clears the head; an absent key leaves it alone.
      if (args.head === null) body.headMemberUuid = null;
      else if (args.head !== undefined) body.headMemberUuid = (await people(session, base, [args.head]))[0];
      if (Object.keys(body).length === 0) throw new ResolveError("Nothing to update: pass at least one field to change.");
      return departmentResult(await session.client.patch<Department>(`${base}/departments/${d.id}`, body), "Updated:");
    },
  );

  const teamArg = z.string().min(1).describe("Team uuid or exact name.");
  const teamResult = (t: Team, heading: string) => result(`${heading}\n${teamLine(teamRow(t))}`, { team: teamRow(t) }, ctx.token());
  const membersArg = z
    .array(personArg)
    .describe("The team's whole roster — 'me', exact names, emails or member uuids. Replaces who is on it; [] empties it.");

  defineTool(
    ctx,
    "create_team",
    {
      title: "Create team",
      description: "Adds a team to a department, optionally with its lead and members. " + CONFIRM_FIRST,
      inputSchema: {
        ...workspaceArg,
        name: z.string().min(1).max(100),
        department: departmentArg,
        lead: personArg.optional().describe("Team lead: 'me', exact name, email or member uuid."),
        members: membersArg.optional(),
      },
      annotations: writeHints(false),
      access: writeOf("structure:write", ["teams", "add"]),
    },
    async (args, session) => {
      const { base } = await session.wsPath(args.workspace);
      const d = await resolveDepartment(session.client, base, args.department);
      const body: Record<string, unknown> = { name: args.name.trim(), departmentUuid: d.id };
      if (args.lead) body.leadMemberUuid = (await people(session, base, [args.lead]))[0];
      if (args.members) body.memberUuids = [...new Set(await people(session, base, args.members))];
      return teamResult(await session.client.post<Team>(`${base}/teams`, body), "Created:");
    },
  );

  defineTool(
    ctx,
    "update_team",
    {
      title: "Update team",
      description:
        "Renames a team, moves it to another department, changes its lead (null removes the lead) or replaces its " +
        "members. Only the fields given change. " +
        CONFIRM_FIRST,
      inputSchema: {
        ...workspaceArg,
        team: teamArg,
        name: z.string().min(1).max(100).optional(),
        department: departmentArg.optional(),
        lead: z.union([personArg, z.null()]).optional().describe("New lead ('me', name, email or member uuid), or null for none."),
        members: membersArg.optional(),
      },
      annotations: writeHints(true),
      access: writeOf("structure:write", ["teams", "edit"]),
    },
    async (args, session) => {
      const { base } = await session.wsPath(args.workspace);
      const t = await resolveTeam(session.client, base, args.team);
      const body: Record<string, unknown> = {};
      if (args.name !== undefined) body.name = args.name.trim();
      if (args.department) body.departmentUuid = (await resolveDepartment(session.client, base, args.department)).id;
      if (args.lead === null) body.leadMemberUuid = null;
      else if (args.lead !== undefined) body.leadMemberUuid = (await people(session, base, [args.lead]))[0];
      if (args.members) body.memberUuids = [...new Set(await people(session, base, args.members))];
      if (Object.keys(body).length === 0) throw new ResolveError("Nothing to update: pass at least one field to change.");
      return teamResult(await session.client.patch<Team>(`${base}/teams/${t.id}`, body), "Updated:");
    },
  );

  for (const act of ["archive", "restore"] as const) {
    const verb = act === "archive" ? "Archive" : "Restore";
    const note =
      act === "archive"
        ? "Archives it: it leaves the active list and nothing is deleted — restore brings it back. "
        : "Brings an archived one back to the active list. ";
    defineTool(
      ctx,
      `${act}_department`,
      {
        title: `${verb} department`,
        description: `${verb}s a department. ${note}${CONFIRM_FIRST}`,
        inputSchema: { ...workspaceArg, department: departmentArg },
        annotations: writeHints(true),
        access: writeOf("structure:write", ["departments", act]),
      },
      async (args, session) => {
        const { base } = await session.wsPath(args.workspace);
        const d = await resolveDepartment(session.client, base, args.department);
        return departmentResult(await session.client.post<Department>(`${base}/departments/${d.id}/${act}`), `${verb}d:`);
      },
    );
    defineTool(
      ctx,
      `${act}_team`,
      {
        title: `${verb} team`,
        description: `${verb}s a team. ${note}${CONFIRM_FIRST}`,
        inputSchema: { ...workspaceArg, team: teamArg },
        annotations: writeHints(true),
        access: writeOf("structure:write", ["teams", act]),
      },
      async (args, session) => {
        const { base } = await session.wsPath(args.workspace);
        const t = await resolveTeam(session.client, base, args.team);
        return teamResult(await session.client.post<Team>(`${base}/teams/${t.id}/${act}`), `${verb}d:`);
      },
    );
  }
}
