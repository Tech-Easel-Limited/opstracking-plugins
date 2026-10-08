import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import { z } from "zod";
import { writeOf, type Access } from "../access.js";
import { localToday, mondayOf, untrusted } from "../format.js";
import {
  isUuid,
  projectDetail,
  resolveClient,
  resolveContact,
  resolveInvoice,
  resolveMembers,
  resolvePerson,
  resolveProject,
  resolveRole,
  ResolveError,
} from "../resolve.js";
import type { Session } from "../session.js";
import type { AgentRequest, ClientDetail } from "../types.js";
import { dateArg, defineTool, READ, REQUEST_FIRST, result, workspaceArg, writeHints, type ToolContext } from "./common.js";

/**
 * Acts a token never performs itself (docs/plans/MCP-EXPANSION.md §3, Tier B):
 * granting access, sending something outward, or the person's own
 * declaration. Each tool files a request — the target route's own body, with
 * the route's parameters beside it — and the person approves or declines it
 * in the app, where OpsTracking replays it under their session (§8.5). So a
 * tool's answer is only ever "waiting for your approval, here is the link";
 * nothing it says may read as the act having happened.
 */

type Filing = { kind: string; params: Record<string, string>; payload: Record<string, unknown> };

async function file(session: Session, base: string, filing: Filing): Promise<AgentRequest> {
  const res = await session.client.post<{ request: AgentRequest }>(`${base}/agent-requests`, filing);
  return res.request;
}

/** The request's own lines: what OpsTracking read from the payload, marked as workspace data. */
function requestLines(r: AgentRequest): string[] {
  return [
    r.summary ? `Request: ${untrusted("summary", r.summary)} (id ${r.id})` : `Request id ${r.id} (${r.kind})`,
    r.tokenName ? `Filed by: ${r.tokenName}` : "",
    ...(r.display ?? []).map((d) => `- ${d.label}: ${untrusted(d.label, d.value)}`),
  ];
}

function requestRow(r: AgentRequest) {
  return {
    id: r.id,
    kind: r.kind,
    status: r.status,
    summary: r.summary ?? "",
    display: r.display ?? [],
    approvalUrl: r.approvalUrl ?? "",
    createdAt: r.createdAt ?? "",
    expiresAt: r.expiresAt ?? "",
    decidedAt: r.decidedAt ?? null,
    result: r.result ?? null,
    needsPassword: r.needsPassword ?? false,
    tokenName: r.tokenName ?? null,
  };
}

/** What filing answers. It never says the act happened — only that it waits for the person. */
function filed(r: AgentRequest, token?: string): CallToolResult {
  const text = [
    "Filed for approval — nothing has changed yet. The user must approve this request in OpsTracking before it happens.",
    ...requestLines(r),
    r.approvalUrl ? `Approve or decline it here: ${r.approvalUrl}` : "Approve or decline it in OpsTracking (Settings → API tokens).",
    [
      r.expiresAt ? `If nobody decides, it expires ${r.expiresAt}.` : "",
      r.needsPassword ? "Approving it asks for the user's password." : "",
    ]
      .filter(Boolean)
      .join(" "),
    "",
    `(For the assistant: give the user the link and say the change happens only once they approve it there. Never say it ` +
      `is done. get_agent_request with id ${r.id} reports what they decided.)`,
  ]
    .filter((l, i, a) => l !== "" || (a[i - 1] ?? "") !== "")
    .join("\n");
  return result(text, { request: requestRow(r), waitingForApproval: true }, token);
}

/** The state of a request in words — "approved" only when OpsTracking says it ran. */
function outcome(r: AgentRequest): string {
  switch (r.status) {
    case "pending":
      return `Waiting for the user's approval — nothing has changed yet.${r.approvalUrl ? ` Link: ${r.approvalUrl}` : ""}`;
    case "executing":
      return "Approved; OpsTracking is carrying it out now.";
    case "approved":
      return "Approved by the user and carried out by OpsTracking.";
    case "declined":
      return "Declined by the user — nothing was changed.";
    case "expired":
      return "Expired without a decision — nothing was changed.";
    case "failed": {
      const why = r.result?.message ? ` ${untrusted("error", r.result.message)}${r.result.code ? ` [${r.result.code}]` : ""}` : "";
      return `Approved, but OpsTracking refused to carry it out:${why}. Nothing was changed; it can be filed again.`;
    }
    default:
      return `Status: ${r.status}.`;
  }
}

/** Filing is itself a write: it puts a request in front of the person. */
const FILES: ReturnType<typeof writeHints> = writeHints(false);

const invoiceArg = z.string().min(1).describe("Invoice uuid or invoice number.");
const projectArg = z.string().min(1).describe("Project uuid, key (e.g. CAT) or exact name.");

export function registerRequestTools(ctx: ToolContext): void {
  const define = <S extends z.ZodRawShape>(
    name: string,
    title: string,
    description: string,
    inputSchema: S,
    access: Access,
    build: (args: z.infer<z.ZodObject<S>>, session: Session, base: string) => Promise<Filing>,
  ) =>
    defineTool(
      ctx,
      name,
      { title, description: `${description} ${REQUEST_FIRST}`, inputSchema: { ...workspaceArg, ...inputSchema }, annotations: FILES, access },
      async (args, session) => {
        const { base } = await session.wsPath((args as { workspace?: string }).workspace);
        return filed(await file(session, base, await build(args as z.infer<z.ZodObject<S>>, session, base)), ctx.token());
      },
    );

  define(
    "request_workspace_invite",
    "Request a workspace invite",
    "Asks to invite someone into the workspace with a role; once the user approves, OpsTracking emails them the " +
      "invitation. Inviting as Workspace Admin asks for the user's password when approving.",
    {
      email: z.string().email(),
      firstName: z.string().max(100).optional(),
      lastName: z.string().max(100).optional(),
      role: z.string().min(1).describe("Workspace role — exact name (e.g. Employee) or uuid."),
    },
    { ...writeOf("people:invite", ["employees", "add"]), allOf: [["employees", "view"]] },
    async (args, session, base): Promise<Filing> => {
      const role = await resolveRole(session.client, base, args.role, "internal");
      return {
        kind: "workspace_invite",
        params: {},
        payload: { email: args.email.trim(), firstName: args.firstName ?? "", lastName: args.lastName ?? "", wsRoleId: role.id },
      };
    },
  );

  define(
    "request_client_invite",
    "Request a client invite to a project",
    "Asks to give one of the project's client's contacts — someone who already has portal access — this project " +
      "in their portal. Someone without portal access needs request_portal_access first.",
    { project: projectArg, person: z.string().min(1).describe("The client contact: exact name, email or uuid.") },
    writeOf("people:invite", ["projects", "edit"]),
    async (args, session, base): Promise<Filing> => {
      const p = await projectDetail(session.client, base, args.project);
      if (!p.client?.id) throw new ResolveError(`${p.name} has no client, so there is nobody to invite.`);
      const c = await session.client.get<ClientDetail>(`${base}/clients/${p.client.id}`);
      const contact = resolveContact(c.contactList ?? [], args.person);
      if (!contact.orgMemberId) {
        throw new ResolveError(
          `${contact.name ?? "That contact"} has no portal access yet. File request_portal_access for them (with this project) instead.`,
        );
      }
      return { kind: "client_invite", params: { uuid: p.id }, payload: { clientMemberUuid: contact.orgMemberId } };
    },
  );

  define(
    "request_portal_access",
    "Request client portal access",
    "Asks to give a client contact a login to the client portal, in a client-team role, on the chosen projects; " +
      "once the user approves, OpsTracking emails them.",
    {
      client: z.string().min(1).describe("Client uuid, exact name or short name."),
      contact: z.string().min(1).describe("The contact: exact name, email or uuid (see get_client)."),
      role: z.string().min(1).describe("Client-team role — exact name or uuid."),
      projects: z.array(projectArg).min(1).describe("The client's projects they should see."),
    },
    writeOf("people:invite", ["clients", "edit"]),
    async (args, session, base): Promise<Filing> => {
      const found = await resolveClient(session.client, base, args.client);
      const c = await session.client.get<ClientDetail>(`${base}/clients/${found.id}`);
      const contact = resolveContact(c.contactList ?? [], args.contact);
      const role = await resolveRole(session.client, base, args.role, "external");
      const projectIds: string[] = [];
      for (const p of args.projects) projectIds.push((await resolveProject(session.client, base, p)).id);
      return {
        kind: "portal_access",
        params: { uuid: found.id, contactUuid: contact.id },
        payload: { wsRoleId: role.id, projectIds: [...new Set(projectIds)] },
      };
    },
  );

  define(
    "request_project_member_change",
    "Request a project roster change",
    "Asks to add people to a project's roster, change a member's billable flag, project role, weekly hours or " +
      "rate, or remove someone from the project. Who is on a project decides who sees it.",
    {
      project: projectArg,
      action: z.enum(["add", "update", "remove"]),
      people: z.array(z.string().min(1)).optional().describe("With add: 'me', exact names, emails or member uuids."),
      person: z.string().min(1).optional().describe("With update/remove: a roster member — exact name, email or member uuid."),
      billable: z.boolean().optional(),
      projectRole: z.string().max(100).optional().describe("What they do on the project (free text); '' clears it."),
      weeklyHours: z.number().min(0).max(168).optional().describe("Expected hours a week on this project."),
      rate: z.number().positive().optional().describe("Their hourly rate on this project, in the project currency."),
    },
    writeOf("projects:roster", ["projects", "assign"], ["projects", "view"]),
    async (args, session, base): Promise<Filing> => {
      const p = await projectDetail(session.client, base, args.project);
      const fields: Record<string, unknown> = {};
      if (args.billable !== undefined) fields.billable = args.billable;
      if (args.projectRole !== undefined) fields.role = args.projectRole;
      if (args.weeklyHours !== undefined) fields.requiredHours = String(args.weeklyHours);
      if (args.rate !== undefined) fields.rateOverride = args.rate.toFixed(2);
      if (args.action === "add") {
        if (!args.people || args.people.length === 0) throw new ResolveError("action=add needs `people`.");
        const ids: string[] = [];
        for (const who of args.people) ids.push(await resolvePerson(session.client, base, who, () => session.myMemberId()));
        return { kind: "project_member_add", params: { uuid: p.id }, payload: { memberUuids: [...new Set(ids)], ...fields } };
      }
      if (!args.person) throw new ResolveError(`action=${args.action} needs \`person\`.`);
      const me = args.person.trim().toLowerCase() === "me" ? await session.myMemberId() : undefined;
      const member = resolveMembers(p.memberList ?? [], [args.person], me)[0];
      if (args.action === "remove") {
        return { kind: "project_member_remove", params: { uuid: p.id, memberUuid: member.id }, payload: {} };
      }
      if (Object.keys(fields).length === 0) throw new ResolveError("action=update needs at least one field to change.");
      return { kind: "project_member_update", params: { uuid: p.id, memberUuid: member.id }, payload: fields };
    },
  );

  define(
    "request_client_access",
    "Request a change to what a client sees",
    "Asks to set what one client-side project member can see and do on a project (members, invoices, timesheets, " +
      "rates, managing tasks), or to revoke their access to it.",
    {
      project: projectArg,
      person: z.string().min(1).describe("The client-side member on the project's roster: exact name, email or uuid."),
      action: z.enum(["set", "revoke"]),
      membersVisible: z.boolean().optional(),
      invoicesVisible: z.boolean().optional(),
      timesheetsVisible: z.boolean().optional(),
      ratesVisible: z.boolean().optional(),
      canManageTasks: z.boolean().optional(),
    },
    writeOf("projects:roster", ["projects", "edit"]),
    async (args, session, base): Promise<Filing> => {
      const p = await projectDetail(session.client, base, args.project);
      const clientSide = (p.memberList ?? []).filter((m) => m.isClient);
      if (clientSide.length === 0) throw new ResolveError(`${p.name} has nobody from the client on its roster.`);
      const member = resolveMembers(clientSide, [args.person])[0];
      if (args.action === "revoke") {
        // The revoke route names the person in its query string, not a body;
        // it rides with the route parameters (a contract question, §9).
        return { kind: "client_access_revoke", params: { uuid: p.id, clientMemberId: member.id }, payload: {} };
      }
      const toggles: Record<string, boolean> = {};
      for (const key of ["membersVisible", "invoicesVisible", "timesheetsVisible", "ratesVisible", "canManageTasks"] as const) {
        const v = args[key];
        if (v !== undefined) toggles[key] = v;
      }
      if (Object.keys(toggles).length === 0) throw new ResolveError("action=set needs at least one of the visibility switches.");
      return { kind: "client_access_set", params: { uuid: p.id }, payload: { clientMemberId: member.id, ...toggles } };
    },
  );

  define(
    "request_role_assignment",
    "Request a workspace role change",
    "Asks to give a workspace member a different workspace role. A role that includes Workspace Admin asks for " +
      "the user's password when approving.",
    {
      person: z.string().min(1).describe("The member: exact name, email or member uuid."),
      role: z.string().min(1).describe("Workspace role — exact name or uuid."),
    },
    { ...writeOf("roles:assign", ["wsaccess", "assign"], ["wsroles", "assign"]), orgGovernors: true },
    async (args, session, base): Promise<Filing> => {
      const memberUuid = await resolvePerson(session.client, base, args.person, () => session.myMemberId());
      const role = await resolveRole(session.client, base, args.role);
      return { kind: "member_role_assign", params: { memberUuid }, payload: { wsRoleId: role.id } };
    },
  );

  define(
    "request_invoice_send",
    "Request sending an invoice",
    "Asks to issue an invoice and email it to the client. Sending cannot be undone, so approving asks for the " +
      "user's password. Only a draft can be sent.",
    { invoice: invoiceArg },
    writeOf("invoices:send", ["invoicing", "edit"]),
    async (args, session, base): Promise<Filing> => ({ kind: "invoice_send", params: { uuid: await resolveInvoice(session.client, base, args.invoice) }, payload: {} }),
  );

  define(
    "request_invoice_paid",
    "Request marking an invoice paid",
    "Asks to record a sent invoice as paid.",
    { invoice: invoiceArg },
    writeOf("invoices:send", ["invoicing", "edit"]),
    async (args, session, base): Promise<Filing> => ({ kind: "invoice_pay", params: { uuid: await resolveInvoice(session.client, base, args.invoice) }, payload: {} }),
  );

  define(
    "request_timesheet_submit",
    "Request submitting a timesheet",
    "Asks to submit the user's own timesheet for a week for approval — their declaration of the hours, which they " +
      "confirm in the app. Check the week with list_time_entries first.",
    {
      week: dateArg.optional().describe("Any day in the week (YYYY-MM-DD). Default: this week."),
      projects: z.array(projectArg).optional().describe("Only these projects' time. Default: all of it."),
      reason: z.string().max(2000).optional().describe("Why, when adding time to a week that was already decided."),
    },
    writeOf("time:submit", ["timesheets", "add"]),
    async (args, session, base): Promise<Filing> => {
      const payload: Record<string, unknown> = { week: mondayOf(args.week ?? localToday()) };
      if (args.projects && args.projects.length > 0) {
        const ids: string[] = [];
        for (const p of args.projects) ids.push((await resolveProject(session.client, base, p)).id);
        payload.projectUuids = [...new Set(ids)];
      }
      if (args.reason) payload.reason = args.reason;
      return { kind: "timesheet_submit", params: {}, payload };
    },
  );

  const requestsOnly: Access = { agentRequests: true };

  defineTool(
    ctx,
    "list_agent_requests",
    {
      title: "List approval requests",
      description:
        "Lists the approval requests filed from the user's connections, newest first, with their status: pending, " +
        "approved, declined, expired or failed.",
      inputSchema: {
        ...workspaceArg,
        status: z.enum(["pending", "executing", "approved", "declined", "expired", "failed"]).optional().describe("Default: all."),
      },
      annotations: READ,
      access: requestsOnly,
    },
    async (args, session) => {
      const { base } = await session.wsPath(args.workspace);
      const res = await session.client.get<{ items?: AgentRequest[] | null }>(`${base}/agent-requests`, { status: args.status });
      const items = res.items ?? [];
      const text =
        items.length === 0
          ? "No approval requests."
          : items
              .map((r) => `- ${r.summary ? untrusted("summary", r.summary) : r.kind} — ${r.status} (id ${r.id})${r.status === "pending" && r.approvalUrl ? ` ${r.approvalUrl}` : ""}`)
              .join("\n");
      return result(text, { items: items.map(requestRow) }, ctx.token());
    },
  );

  defineTool(
    ctx,
    "get_agent_request",
    {
      title: "Get approval request",
      description:
        "One approval request and what became of it: still waiting, approved and carried out, declined, expired, " +
        "or refused by OpsTracking when it ran.",
      inputSchema: { ...workspaceArg, id: z.string().min(1).describe("The request id a request_* tool returned.") },
      annotations: READ,
      access: requestsOnly,
    },
    async (args, session) => {
      const { base } = await session.wsPath(args.workspace);
      if (!isUuid(args.id)) throw new ResolveError(`"${args.id}" is not a request id. list_agent_requests shows them.`);
      const { request: r } = await session.client.get<{ request: AgentRequest }>(`${base}/agent-requests/${args.id.trim()}`);
      const text = [outcome(r), ...requestLines(r)].filter(Boolean).join("\n");
      return result(text, { request: requestRow(r) }, ctx.token());
    },
  );
}
