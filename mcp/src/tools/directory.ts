import { z } from "zod";
import { readOf, writeOf } from "../access.js";
import { hasMore, pagingLine, untrusted } from "../format.js";
import { resolveClient, resolveContact, ResolveError } from "../resolve.js";
import type { Client, ClientDetail, Contact, Employee, Page } from "../types.js";
import {
  CONFIRM_FIRST,
  defineTool,
  pageOf,
  pagingArgs,
  READ,
  result,
  workspaceArg,
  writeHints,
  type ToolContext,
} from "./common.js";

/** Clients and people: the two directories a workspace keeps. */

function clientRow(c: Client) {
  return {
    id: c.id,
    name: c.name,
    short: c.short ?? "",
    status: c.status ?? "",
    industry: c.industry ?? "",
    country: c.country ?? "",
    currency: c.currency ?? "",
    terms: c.terms ?? "",
    projects: c.projects ?? 0,
    primaryContact: c.contact ? { name: c.contact.name ?? "", email: c.contact.email ?? "" } : null,
  };
}

function contactRow(k: Contact) {
  return {
    id: k.id,
    name: k.name ?? "",
    email: k.email ?? "",
    phone: k.phone ?? "",
    title: k.title ?? "",
    isPrimary: k.isPrimary ?? false,
    status: k.status ?? "",
    portalMemberId: k.orgMemberId ?? "",
  };
}

/** A contact as one line: every part of it was typed by somebody, so every part is marked. */
function contactLine(k: ReturnType<typeof contactRow>): string {
  return (
    `${untrusted("contact name", k.name)}${k.email ? ` ${untrusted("contact email", `<${k.email}>`)}` : ""}` +
    `${k.title ? ` · ${untrusted("contact title", k.title)}` : ""}${k.phone ? ` · ${untrusted("contact phone", k.phone)}` : ""}` +
    `${k.isPrimary ? " [primary]" : ""}${k.portalMemberId ? " [portal access]" : ""}`
  );
}

/** One client as get_client and every client write answer it. */
function clientResult(c: ClientDetail, heading: string | undefined, token?: string) {
  const contacts = (c.contactList ?? []).map(contactRow);
  const projects = (c.projectList ?? []).map((p) => ({ id: p.id, name: p.name ?? "" }));
  const row = clientRow(c);
  const text = [
    heading ?? "",
    `${untrusted("client", c.name)}${row.short ? ` (${untrusted("short name", row.short)})` : ""} — ${row.status} (id ${c.id})`,
    c.legalName ? `Legal name: ${untrusted("legal name", c.legalName)}` : "",
    row.industry ? `Industry: ${untrusted("industry", row.industry)}` : "",
    `Currency: ${row.currency}${row.terms ? ` · Terms: ${row.terms}` : ""}`,
    c.billingEmail ? `Billing email: ${untrusted("billing email", c.billingEmail)}` : "",
    c.address ? `Address: ${untrusted("address", c.address)}` : "",
    `Contacts: ${contacts.map((k) => `${contactLine(k)} (id ${k.id})`).join(", ") || "none"}`,
    `Projects: ${projects.map((p) => untrusted("project", p.name)).join(", ") || "none"}`,
    c.notes ? `\nNotes:\n${untrusted("notes", c.notes)}` : "",
  ]
    .filter(Boolean)
    .join("\n");
  return result(
    text,
    {
      client: {
        ...row,
        legalName: c.legalName ?? "",
        billingEmail: c.billingEmail ?? "",
        site: c.site ?? "",
        address: c.address ?? "",
        notes: c.notes ?? "",
      },
      contacts,
      projects,
    },
    token,
  );
}

function employeeRow(e: Employee) {
  return {
    id: e.id,
    name: e.name,
    email: e.email ?? "",
    designation: e.designation ?? "",
    department: e.department ?? "",
    team: e.team ?? "",
    role: e.role ?? "",
    status: e.status ?? "",
    projects: e.projects ?? 0,
  };
}

export function registerDirectoryTools(ctx: ToolContext): void {
  defineTool(
    ctx,
    "list_clients",
    {
      title: "List clients",
      description: "Lists the workspace's clients, with search, a status filter and paging.",
      inputSchema: {
        ...workspaceArg,
        q: z.string().optional().describe("Search text."),
        status: z.enum(["all", "active", "inactive", "archived"]).optional().describe("Default all."),
        ...pagingArgs,
      },
      annotations: READ,
      access: readOf("clients"),
    },
    async (args, session) => {
      const { base } = await session.wsPath(args.workspace);
      const { page, size } = pageOf(args);
      const res = await session.client.get<Page<Client>>(`${base}/clients`, { q: args.q, status: args.status, page, size });
      const rows = (res.rows ?? []).map(clientRow);
      const paging = { page, size, total: res.total ?? rows.length, shown: rows.length };
      const text = [
        ...rows.map(
          (c) =>
            `- ${untrusted("client", c.name)}${c.short ? ` (${untrusted("short name", c.short)})` : ""} — ${c.status}` +
            ` · ${c.projects} project(s) · ${c.currency} (id ${c.id})`,
        ),
        pagingLine(paging),
      ].join("\n");
      return result(text, { rows, total: paging.total, page, size, hasMore: hasMore(paging) }, ctx.token());
    },
  );

  defineTool(
    ctx,
    "get_client",
    {
      title: "Get client",
      description: "One client's details: contacts, billing identity and projects.",
      inputSchema: { ...workspaceArg, client: z.string().min(1).describe("Client uuid, exact name or short name.") },
      annotations: READ,
      access: readOf("clients"),
    },
    async (args, session) => {
      const { base } = await session.wsPath(args.workspace);
      const found = await resolveClient(session.client, base, args.client);
      const c = await session.client.get<ClientDetail>(`${base}/clients/${found.id}`);
      return clientResult(c, undefined, ctx.token());
    },
  );

  defineTool(
    ctx,
    "list_employees",
    {
      title: "List people",
      description:
        "Lists people in the workspace directory (name, email, designation, department, team, role). " +
        "Needs the employees view permission.",
      inputSchema: {
        ...workspaceArg,
        q: z.string().optional().describe("Search text (name or email)."),
        status: z.string().optional().describe("Status filter, e.g. Active."),
        ...pagingArgs,
      },
      annotations: READ,
      access: readOf("employees"),
    },
    async (args, session) => {
      const { base } = await session.wsPath(args.workspace);
      const { page, size } = pageOf(args);
      const res = await session.client.get<Page<Employee>>(`${base}/employees`, { q: args.q, status: args.status, page, size });
      const rows = (res.rows ?? []).map(employeeRow);
      const paging = { page, size, total: res.total ?? rows.length, shown: rows.length };
      const text = [
        ...rows.map(
          (e) =>
            `- ${e.name || "(name hidden)"}${e.email ? ` <${e.email}>` : ""}` +
            `${e.designation ? ` — ${e.designation}` : ""}${e.team ? ` · ${e.team}` : ""}${e.role ? ` · ${e.role}` : ""} (id ${e.id})`,
        ),
        pagingLine(paging),
      ].join("\n");
      return result(text, { rows, total: paging.total, page, size, hasMore: hasMore(paging) }, ctx.token());
    },
  );
  const clientArg = z.string().min(1).describe("Client uuid, exact name or short name.");
  const TERMS = ["Due on receipt", "Net 15", "Net 30", "Net 45", "Net 60"] as const;
  const clientFields = {
    short: z.string().max(20).optional().describe("Short name, e.g. an abbreviation."),
    industry: z.string().max(100).optional(),
    site: z.string().max(300).optional().describe("Website."),
    address: z.string().max(1000).optional(),
    notes: z.string().max(10_000).optional(),
    companyEmail: z.string().email().optional(),
    companyPhone: z.string().max(40).optional(),
    timezone: z.string().max(60).optional().describe("IANA name, e.g. Europe/London."),
    legalName: z.string().max(200).optional(),
    taxId: z.string().max(60).optional(),
    billingEmail: z.string().email().optional().describe("Where invoices go."),
    terms: z.enum(TERMS).optional().describe("Payment terms. Default Net 30."),
  };
  type ClientFields = { [K in keyof typeof clientFields]?: string };
  const clientBody = (args: ClientFields & { name?: string; country?: string }) => {
    const body: Record<string, unknown> = {};
    if (args.name !== undefined) body.name = args.name.trim();
    if (args.country !== undefined) body.country = args.country;
    for (const key of Object.keys(clientFields) as Array<keyof ClientFields>) {
      if (args[key] !== undefined) body[key] = args[key];
    }
    return body;
  };
  const contactFields = {
    email: z.string().email().optional(),
    phone: z.string().max(40).optional(),
    title: z.string().max(100).optional().describe("Their job at the client, e.g. Head of Product."),
    isPrimary: z.boolean().optional().describe("Make this the client's primary contact."),
  };

  defineTool(
    ctx,
    "create_client",
    {
      title: "Create client",
      description:
        "Adds a client to the workspace, optionally with its primary contact. The client bills in the workspace's " +
        "currency. Adding a contact gives them no access: portal access is its own, approved request " +
        "(request_portal_access). " +
        CONFIRM_FIRST,
      inputSchema: {
        ...workspaceArg,
        name: z.string().min(1).max(200),
        country: z.string().min(1).max(100).describe("Country, as the app lists it (e.g. United Kingdom)."),
        ...clientFields,
        primaryContact: z
          .object({ name: z.string().min(1).max(200), ...contactFields })
          .omit({ isPrimary: true })
          .optional(),
      },
      annotations: writeHints(false),
      access: writeOf("clients:write", ["clients", "add"]),
    },
    async (args, session) => {
      const { base } = await session.wsPath(args.workspace);
      const body = clientBody(args);
      if (args.primaryContact) body.primaryContact = { ...args.primaryContact, name: args.primaryContact.name.trim() };
      const c = await session.client.post<ClientDetail>(`${base}/clients`, body);
      return clientResult(c, "Created:", ctx.token());
    },
  );

  defineTool(
    ctx,
    "update_client",
    {
      title: "Update client",
      description: "Changes a client's details. Only the fields given change. " + CONFIRM_FIRST,
      inputSchema: {
        ...workspaceArg,
        client: clientArg,
        name: z.string().min(1).max(200).optional(),
        country: z.string().min(1).max(100).optional(),
        ...clientFields,
      },
      annotations: writeHints(true),
      access: writeOf("clients:write", ["clients", "edit"]),
    },
    async (args, session) => {
      const { base } = await session.wsPath(args.workspace);
      const found = await resolveClient(session.client, base, args.client);
      const body = clientBody(args);
      if (Object.keys(body).length === 0) throw new ResolveError("Nothing to update: pass at least one field to change.");
      const c = await session.client.patch<ClientDetail>(`${base}/clients/${found.id}`, body);
      return clientResult(c, "Updated:", ctx.token());
    },
  );

  for (const [name, verb, act, done] of [
    ["archive_client", "Archive", "archive", "Archived:"],
    ["restore_client", "Restore", "restore", "Restored:"],
  ] as const) {
    defineTool(
      ctx,
      name,
      {
        title: `${verb} client`,
        description:
          (act === "archive"
            ? "Archives a client: it leaves the active list, and nothing is deleted — restore_client brings it back. "
            : "Brings an archived client back to the active list. ") + CONFIRM_FIRST,
        inputSchema: { ...workspaceArg, client: clientArg },
        annotations: writeHints(true),
        access: writeOf("clients:write", ["clients", act]),
      },
      async (args, session) => {
        const { base } = await session.wsPath(args.workspace);
        const found = await resolveClient(session.client, base, args.client);
        const c = await session.client.post<ClientDetail>(`${base}/clients/${found.id}/${act}`);
        return clientResult(c, done, ctx.token());
      },
    );
  }

  defineTool(
    ctx,
    "add_client_contact",
    {
      title: "Add client contact",
      description:
        "Adds a contact person to a client. It gives them no access to anything; portal access is a separate, " +
        "approved request (request_portal_access). " +
        CONFIRM_FIRST,
      inputSchema: { ...workspaceArg, client: clientArg, name: z.string().min(1).max(200), ...contactFields },
      annotations: writeHints(false),
      access: writeOf("clients:write", ["clients", "edit"]),
    },
    async (args, session) => {
      const { base } = await session.wsPath(args.workspace);
      const found = await resolveClient(session.client, base, args.client);
      const body: Record<string, unknown> = { name: args.name.trim() };
      for (const key of ["email", "phone", "title", "isPrimary"] as const) if (args[key] !== undefined) body[key] = args[key];
      const k = contactRow(await session.client.post<Contact>(`${base}/clients/${found.id}/contacts`, body));
      return result(
        `Contact added to ${untrusted("client", found.name)}: ${contactLine(k)} (contact id ${k.id}).`,
        { clientId: found.id, contact: k },
        ctx.token(),
      );
    },
  );

  defineTool(
    ctx,
    "update_client_contact",
    {
      title: "Update client contact",
      description: "Changes one of a client's contacts. Only the fields given change. " + CONFIRM_FIRST,
      inputSchema: {
        ...workspaceArg,
        client: clientArg,
        contact: z.string().min(1).describe("Contact uuid, email or exact name (see get_client)."),
        name: z.string().min(1).max(200).optional(),
        ...contactFields,
      },
      annotations: writeHints(true),
      access: writeOf("clients:write", ["clients", "edit"]),
    },
    async (args, session) => {
      const { base } = await session.wsPath(args.workspace);
      const found = await resolveClient(session.client, base, args.client);
      const detail = await session.client.get<ClientDetail>(`${base}/clients/${found.id}`);
      const contact = resolveContact(detail.contactList ?? [], args.contact);
      const body: Record<string, unknown> = {};
      if (args.name !== undefined) body.name = args.name.trim();
      for (const key of ["email", "phone", "title", "isPrimary"] as const) if (args[key] !== undefined) body[key] = args[key];
      if (Object.keys(body).length === 0) throw new ResolveError("Nothing to update: pass at least one field to change.");
      const k = contactRow(await session.client.patch<Contact>(`${base}/clients/${found.id}/contacts/${contact.id}`, body));
      return result(
        `Contact updated on ${untrusted("client", detail.name)}: ${contactLine(k)} (contact id ${k.id}).`,
        { clientId: found.id, contact: k },
        ctx.token(),
      );
    },
  );
}
