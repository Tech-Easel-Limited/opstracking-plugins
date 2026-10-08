import { z } from "zod";
import { readOf, writeOf } from "../access.js";
import { hasMore, pagingLine, untrusted } from "../format.js";
import { resolveClient, resolveInvoice, resolveProject, ResolveError } from "../resolve.js";
import type { Session } from "../session.js";
import type { Invoice, InvoiceDetail, InvoiceItem, InvoicePreview, Page } from "../types.js";
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

function invoiceRow(i: Invoice) {
  return {
    id: i.id,
    number: i.number ?? "",
    client: i.client?.name ?? "",
    clientId: i.client?.id ?? "",
    projects: (i.projects ?? []).map((p) => p.name ?? p.id),
    status: i.label || i.status || "",
    issued: i.issued ?? "",
    due: i.due ?? "",
    hours: i.hours ?? "",
    amount: i.amount ?? "",
    currency: i.currency ?? "",
  };
}

function itemRow(it: InvoiceItem) {
  return { name: it.name ?? "", detail: it.sub ?? "", hours: it.hours ?? "", rate: it.rate ?? "", amount: it.amount ?? "" };
}

const itemsText = (items: InvoiceItem[] | null | undefined, currency: string) =>
  (items ?? []).map(
    (it) =>
      `- ${untrusted("line", it.name)}${it.sub ? ` (${untrusted("line detail", it.sub)})` : ""}: ` +
      `${it.hours ? `${it.hours}h × ${it.rate} = ` : ""}${currency} ${it.amount}`,
  );

const lineArg = z.object({
  name: z.string().min(1).describe("Line description."),
  detail: z.string().optional().describe("Second line under the description."),
  hours: z.number().positive().optional(),
  rate: z.number().positive().optional().describe("Rate per hour, in the invoice currency."),
});

const draftArgs = {
  ...workspaceArg,
  client: z.string().min(1).describe("Client uuid, exact name or short name."),
  projects: z
    .array(z.string().min(1))
    .optional()
    .describe("Projects whose approved hours to bill (uuid, key or exact name). All must share one currency."),
  source: z
    .enum(["team", "employee", "custom"])
    .optional()
    .describe("team = lines per project/team (default); employee = a line per person; custom = your own `lines`."),
  from: dateArg.optional().describe("Start of the period whose approved hours are pulled. Default: 6 days before the issue date."),
  to: dateArg.optional().describe("End of the period. Default: the issue date."),
  issueOn: dateArg.optional().describe("Default today."),
  dueOn: dateArg.optional().describe("Default: the issue date."),
  billTo: z.string().optional(),
  notes: z.string().optional(),
  lines: z.array(lineArg).optional().describe("Hand-written lines; only with source=custom."),
};

type DraftArgs = {
  client: string;
  projects?: string[];
  source?: "team" | "employee" | "custom";
  from?: string;
  to?: string;
  issueOn?: string;
  dueOn?: string;
  billTo?: string;
  notes?: string;
  lines?: Array<{ name: string; detail?: string; hours?: number; rate?: number }>;
};

/** Hand-written lines as the API takes them: decimal strings. */
function linesBody(lines: NonNullable<DraftArgs["lines"]>): Array<Record<string, string>> {
  return lines.map((l) => {
    const line: Record<string, string> = { name: l.name };
    if (l.detail) line.sub = l.detail;
    if (l.hours !== undefined) line.hours = l.hours.toFixed(2);
    if (l.rate !== undefined) line.rate = l.rate.toFixed(2);
    return line;
  });
}

/**
 * The builder payload the invoice create and preview endpoints share
 * (service.InvoiceInput). Deliberately never carries `number` (a custom number
 * is a sender's decision) or `includeInvoiced` (re-billing hours another
 * invoice holds). `send` is set by the caller, and only ever to false.
 */
async function draftBody(session: Session, base: string, args: DraftArgs): Promise<{ body: Record<string, unknown>; summary: string }> {
  const source = args.source ?? "team";
  if (source === "custom" && (!args.lines || args.lines.length === 0)) {
    throw new ResolveError("A custom invoice needs `lines`.");
  }
  if (source !== "custom" && args.lines && args.lines.length > 0) {
    throw new ResolveError("`lines` are only used with source=custom; team and employee invoices bill approved hours.");
  }
  if (args.from && args.to && args.from > args.to) throw new ResolveError("`from` must be on or before `to`.");

  const client = await resolveClient(session.client, base, args.client);
  const projects = [];
  for (const p of args.projects ?? []) projects.push(await resolveProject(session.client, base, p));

  const body: Record<string, unknown> = { clientUuid: client.id, source };
  if (projects.length > 0) body.projectUuids = projects.map((p) => p.id);
  if (args.from) body.from = args.from;
  if (args.to) body.to = args.to;
  if (args.issueOn) body.issueOn = args.issueOn;
  if (args.dueOn) body.dueOn = args.dueOn;
  if (args.billTo !== undefined) body.billTo = args.billTo;
  if (args.notes !== undefined) body.notes = args.notes;
  if (args.lines && args.lines.length > 0) body.lines = linesBody(args.lines);
  const summary = `client ${client.name}${projects.length ? `, projects ${projects.map((p) => p.name).join(", ")}` : ""}, source ${source}`;
  return { body, summary };
}

/** One invoice as get_invoice and the draft writes answer it. */
function invoiceResult(inv: InvoiceDetail, heading: string | undefined, token?: string) {
  const row = invoiceRow(inv);
  const text = [
    heading ?? "",
    `Invoice ${row.number || "(no number)"} — ${row.status} (id ${inv.id})`,
    `Client: ${untrusted("client", row.client)}${row.projects.length ? ` · Projects: ${row.projects.map((p) => untrusted("project", p)).join(", ")}` : ""}`,
    `Issued ${row.issued || "—"} · Due ${row.due || "—"}${inv.from ? ` · Period ${inv.from} → ${inv.to}` : ""}`,
    "",
    ...itemsText(inv.items, row.currency),
    "",
    `Subtotal ${row.currency} ${inv.subtotal ?? "0.00"} · Discount ${inv.discount ?? "0.00"} · Tax ${inv.tax ?? "0.00"}% · Total ${row.currency} ${row.amount}`,
    inv.notes ? `Notes: ${untrusted("notes", inv.notes)}` : "",
  ]
    .filter((l, i, a) => l !== "" || (a[i - 1] ?? "") !== "")
    .join("\n");
  return result(
    text,
    {
      invoice: {
        ...row,
        subtotal: inv.subtotal ?? "",
        discount: inv.discount ?? "",
        tax: inv.tax ?? "",
        adjustment: inv.adjustment ?? "",
        from: inv.from ?? "",
        to: inv.to ?? "",
        billTo: inv.billTo ?? "",
        notes: inv.notes ?? "",
        items: (inv.items ?? []).map(itemRow),
      },
    },
    token,
  );
}

export function registerInvoiceTools(ctx: ToolContext): void {
  defineTool(
    ctx,
    "list_invoices",
    {
      title: "List invoices",
      description: "Lists invoices with search, status, client, project and date filters, plus the outstanding/overdue/draft totals.",
      inputSchema: {
        ...workspaceArg,
        q: z.string().optional().describe("Search text (number, client)."),
        status: z.enum(["Draft", "Sent", "Paid", "Overdue"]).optional(),
        client: z.string().optional().describe("Client uuid or exact name."),
        project: z.string().optional().describe("Project uuid, key or exact name."),
        from: dateArg.optional(),
        to: dateArg.optional(),
        sort: z.string().optional().describe("Sort column, e.g. issued, due, amount, number."),
        dir: z.enum(["asc", "desc"]).optional(),
        ...pagingArgs,
      },
      annotations: READ,
      access: readOf("invoicing"),
    },
    async (args, session) => {
      const { base } = await session.wsPath(args.workspace);
      const { page, size } = pageOf(args);
      const client = args.client ? (await resolveClient(session.client, base, args.client)).id : undefined;
      const project = args.project ? (await resolveProject(session.client, base, args.project)).id : undefined;
      const res = await session.client.get<Page<Invoice> & { stats?: Record<string, unknown>; tabs?: Record<string, number> }>(
        `${base}/invoices`,
        { q: args.q, tab: args.status, client, project, from: args.from, to: args.to, sort: args.sort, dir: args.dir, page, size },
      );
      const rows = (res.rows ?? []).map(invoiceRow);
      const paging = { page, size, total: res.total ?? rows.length, shown: rows.length };
      const s = res.stats as { currency?: string; outstanding?: string; overdue?: string; draft?: string } | undefined;
      const text = [
        s ? `Outstanding ${s.currency ?? ""} ${s.outstanding ?? "0.00"} · overdue ${s.overdue ?? "0.00"} · in drafts ${s.draft ?? "0.00"}` : "",
        ...rows.map(
          (i) =>
            `- ${i.number || "(no number)"} · ${untrusted("client", i.client)} — ${i.status} · ${i.currency} ${i.amount}` +
            ` · issued ${i.issued || "—"}, due ${i.due || "—"} (id ${i.id})`,
        ),
        pagingLine(paging),
      ]
        .filter(Boolean)
        .join("\n");
      return result(
        text,
        { rows, total: paging.total, page, size, hasMore: hasMore(paging), stats: res.stats ?? null, tabs: res.tabs ?? null },
        ctx.token(),
      );
    },
  );

  defineTool(
    ctx,
    "get_invoice",
    {
      title: "Get invoice",
      description: "One invoice with its line items, totals, period and notes.",
      inputSchema: { ...workspaceArg, invoice: z.string().min(1).describe("Invoice uuid or invoice number.") },
      annotations: READ,
      access: readOf("invoicing"),
    },
    async (args, session) => {
      const { base } = await session.wsPath(args.workspace);
      const id = await resolveInvoice(session.client, base, args.invoice);
      const inv = await session.client.get<InvoiceDetail>(`${base}/invoices/${id}`);
      return invoiceResult(inv, undefined, ctx.token());
    },
  );

  defineTool(
    ctx,
    "preview_invoice",
    {
      title: "Preview invoice",
      description:
        "Computes what an invoice draft would contain — lines, totals, and hours left out (pending, rejected, already " +
        "invoiced) — WITHOUT saving anything. Use it to show the user the draft before create_invoice_draft. " +
        "The server exposes this as a POST, so it is offered only to a connection allowed to save invoice drafts, " +
        "even though it changes nothing.",
      inputSchema: draftArgs,
      annotations: { readOnlyHint: true, openWorldHint: false },
      access: writeOf("invoices:draft", ["invoicing", "add"]),
    },
    async (args, session) => {
      const { base } = await session.wsPath(args.workspace);
      const { body, summary } = await draftBody(session, base, args);
      const p = await session.client.post<InvoicePreview>(`${base}/invoices/preview`, body);
      const cur = p.currency ?? "";
      const excluded = Object.fromEntries(
        Object.entries(p.excluded ?? {}).map(([k, v]) => [k, Array.isArray(v) ? v.length : 0]),
      ) as Record<string, number>;
      const text = [
        `Preview (${summary}) — nothing saved.`,
        ...itemsText(p.items, cur),
        `Hours ${p.hours ?? "0"} · Subtotal ${cur} ${p.subtotal ?? "0.00"} · Total ${cur} ${p.total ?? "0.00"} · ${p.pulledEntries ?? 0} time entries pulled`,
        Object.entries(excluded).some(([k, n]) => k !== "billed" && n > 0)
          ? `Left out: ${Object.entries(excluded).filter(([k, n]) => k !== "billed" && n > 0).map(([k, n]) => `${n} ${k}`).join(", ")}`
          : "",
        (p.issues ?? []).length > 0 ? `Issues before it could be sent: ${(p.issues ?? []).join("; ")}` : "",
      ]
        .filter(Boolean)
        .join("\n");
      return result(
        text,
        {
          items: (p.items ?? []).map(itemRow),
          hours: p.hours ?? "",
          subtotal: p.subtotal ?? "",
          total: p.total ?? "",
          currency: cur,
          pulledEntries: p.pulledEntries ?? 0,
          excludedCounts: excluded,
          issues: p.issues ?? [],
          request: body,
        },
        ctx.token(),
      );
    },
  );

  defineTool(
    ctx,
    "create_invoice_draft",
    {
      title: "Create invoice draft",
      description:
        "Saves a new invoice as a DRAFT for a client, billing the approved hours of the chosen projects over a period " +
        "(or hand-written lines with source=custom). It is never sent: sending, numbering, marking paid and voiding " +
        "stay in the OpsTracking app. Run preview_invoice first and show the user the result. " +
        CONFIRM_FIRST,
      inputSchema: draftArgs,
      annotations: writeHints(false),
      access: writeOf("invoices:draft", ["invoicing", "add"]),
    },
    async (args, session) => {
      const { base } = await session.wsPath(args.workspace);
      const { body, summary } = await draftBody(session, base, args);
      body.send = false;
      const inv = await session.client.post<InvoiceDetail>(`${base}/invoices`, body);
      const row = invoiceRow(inv);
      const text = [
        `Draft invoice ${row.number || ""} created (${summary}) — not sent (id ${inv.id}).`,
        ...itemsText(inv.items, row.currency),
        `Total ${row.currency} ${row.amount}. Review and send it from the OpsTracking app.`,
      ].join("\n");
      return result(text, { invoice: { ...row, items: (inv.items ?? []).map(itemRow) } }, ctx.token());
    },
  );
  const invoiceArg = z.string().min(1).describe("Invoice uuid or invoice number.");

  defineTool(
    ctx,
    "update_invoice_draft",
    {
      title: "Update invoice draft",
      description:
        "Changes a DRAFT invoice: dates, billing period, projects, bill-to, notes, discount, tax, or (for a custom " +
        "invoice) its lines. Only the fields given change; the draft is rebuilt and re-priced by the server, and a " +
        "changed period or project list re-pulls the approved hours. It stays a draft — never sent, never " +
        "renumbered. Run preview_invoice with the new values first when the lines will change. " +
        CONFIRM_FIRST,
      inputSchema: {
        ...workspaceArg,
        invoice: invoiceArg,
        projects: draftArgs.projects,
        from: draftArgs.from,
        to: draftArgs.to,
        issueOn: draftArgs.issueOn,
        dueOn: draftArgs.dueOn,
        billTo: draftArgs.billTo,
        notes: draftArgs.notes,
        discount: z.number().min(0).optional().describe("Discount, in the invoice currency."),
        tax: z.number().min(0).max(100).optional().describe("Tax percentage."),
        lines: draftArgs.lines.describe("Replaces all lines; only on a custom invoice."),
      },
      annotations: writeHints(true),
      access: writeOf("invoices:draft", ["invoicing", "edit"]),
    },
    async (args, session) => {
      const { base } = await session.wsPath(args.workspace);
      const id = await resolveInvoice(session.client, base, args.invoice);
      const cur = await session.client.get<InvoiceDetail>(`${base}/invoices/${id}`);
      if ((cur.status ?? "") !== "Draft") {
        throw new ResolveError(`Invoice ${cur.number || id} is ${cur.label || cur.status || "not a draft"}; only drafts can be changed here.`);
      }
      if (args.lines && cur.source !== "custom") {
        throw new ResolveError("`lines` only apply to a custom invoice; team and employee invoices bill approved hours.");
      }
      const from = args.from ?? cur.from ?? "";
      const to = args.to ?? cur.to ?? "";
      if (from && to && from > to) throw new ResolveError("`from` must be on or before `to`.");
      const projectUuids = [];
      if (args.projects) for (const p of args.projects) projectUuids.push((await resolveProject(session.client, base, p)).id);

      // The PATCH rebuilds the whole draft from its body (service.InvoiceInput),
      // so every field not being changed is sent back as it stands. Never a
      // number (keeps the draft's own) and never `send: true`.
      const body: Record<string, unknown> = {
        clientUuid: cur.client?.id ?? "",
        projectUuids: args.projects ? projectUuids : (cur.projects ?? []).map((p) => p.id),
        source: cur.source ?? "team",
        issueOn: args.issueOn ?? cur.issued ?? "",
        dueOn: args.dueOn ?? cur.due ?? "",
        from,
        to,
        billTo: args.billTo ?? cur.billTo ?? "",
        notes: args.notes ?? cur.notes ?? "",
        adjustment: cur.adjustment ?? "",
        discount: args.discount !== undefined ? args.discount.toFixed(2) : (cur.discount ?? ""),
        tax: args.tax !== undefined ? String(args.tax) : (cur.tax ?? ""),
        payOnline: cur.payOnline ?? false,
        payUrl: cur.payUrl ?? "",
        template: cur.template ?? "",
        includeInvoiced: cur.includeInvoiced ?? false,
        rebillReason: cur.rebillReason ?? "",
        // "Pro-rate partial periods" for Fixed Price projects: left out, an
        // older server read it as off and re-priced the draft.
        prorateFixed: cur.prorateFixed ?? false,
        send: false,
      };
      if (cur.source === "custom") {
        body.lines = args.lines
          ? linesBody(args.lines)
          : (cur.items ?? []).map((it) => ({ name: it.name ?? "", sub: it.sub ?? "", hours: it.hours ?? "", rate: it.rate ?? "" }));
      }
      const inv = await session.client.patch<InvoiceDetail>(`${base}/invoices/${id}`, body);
      return invoiceResult(inv, "Draft updated — not sent. Review and send it from the OpsTracking app.", ctx.token());
    },
  );

  defineTool(
    ctx,
    "duplicate_invoice",
    {
      title: "Duplicate invoice",
      description:
        "Copies an invoice into a new DRAFT with the same client, projects and lines — for a recurring bill. The " +
        "copy is never sent. " +
        CONFIRM_FIRST,
      inputSchema: { ...workspaceArg, invoice: invoiceArg },
      annotations: writeHints(false),
      access: writeOf("invoices:draft", ["invoicing", "add"]),
    },
    async (args, session) => {
      const { base } = await session.wsPath(args.workspace);
      const id = await resolveInvoice(session.client, base, args.invoice);
      const inv = await session.client.post<InvoiceDetail>(`${base}/invoices/${id}/duplicate`);
      return invoiceResult(inv, "Draft copy created — not sent. Review and send it from the OpsTracking app.", ctx.token());
    },
  );
}
