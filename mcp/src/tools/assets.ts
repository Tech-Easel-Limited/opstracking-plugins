import { z } from "zod";
import { readOf, writeOf } from "../access.js";
import { hasMore, pagingLine, untrusted } from "../format.js";
import { resolveAsset, resolveDepartment, resolvePerson, ResolveError } from "../resolve.js";
import type { Session } from "../session.js";
import type { Asset, Page } from "../types.js";
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

/**
 * The asset register: laptops, phones, licences — who holds each one, and its
 * state. A change of holder or status is recorded in the asset's history by
 * the server; deleting stays in the app.
 */

const ASSET_TYPES = ["Laptop", "Desktop", "Monitor", "Phone", "Tablet", "Peripheral", "Software", "Other"] as const;
const ASSET_STATUSES = ["Available", "Repair", "Lost", "Retired"] as const;

function assetRow(a: Asset) {
  return {
    id: a.id,
    number: a.number ?? "",
    label: a.label ?? "",
    brand: a.brand ?? "",
    model: a.model ?? "",
    type: a.type ?? "",
    serial: a.serial ?? "",
    specs: a.specsSummary ?? "",
    description: a.desc ?? "",
    status: a.status ?? "",
    archived: a.archived ?? false,
    holder: a.holder?.name ?? "",
    holderId: a.holder?.id ?? "",
    department: a.department?.name ?? "",
    purchased: a.purchased ?? "",
    warranty: a.warranty ?? "",
  };
}

const assetLine = (a: ReturnType<typeof assetRow>) =>
  `${a.number} · ${untrusted("asset", a.label || `${a.brand} ${a.model}`.trim())} — ${a.type} · ${a.status}` +
  `${a.archived ? " (archived)" : ""}${a.holder ? ` · held by ${a.holder}` : ""}` +
  `${a.department ? ` · ${untrusted("department", a.department)}` : ""}${a.serial ? ` · serial ${untrusted("serial", a.serial)}` : ""}` +
  ` (id ${a.id})`;

const assetFields = {
  brand: z.string().min(1).max(100).optional(),
  model: z.string().min(1).max(200).optional(),
  type: z.enum(ASSET_TYPES).optional(),
  serial: z.string().min(1).max(100).optional(),
  description: z.string().max(5000).optional(),
  specs: z.record(z.string(), z.string()).optional().describe('Spec sheet, e.g. {"CPU": "M3", "RAM": "16 GB"}.'),
  purchased: dateArg.optional().describe("Purchase date."),
  warranty: dateArg.optional().describe("Warranty end date."),
  cost: z.number().min(0).optional().describe("Purchase cost, in the workspace currency."),
  department: z.string().min(1).optional().describe("Owning department — uuid or exact name."),
  holder: z.string().min(1).optional().describe("Who holds it: 'me', exact name, email or member uuid."),
};

type AssetFields = {
  brand?: string;
  model?: string;
  type?: (typeof ASSET_TYPES)[number];
  serial?: string;
  description?: string;
  specs?: Record<string, string>;
  purchased?: string;
  warranty?: string;
  cost?: number;
  department?: string;
  holder?: string;
};

async function assetBody(session: Session, base: string, args: AssetFields): Promise<Record<string, unknown>> {
  const body: Record<string, unknown> = {};
  if (args.brand !== undefined) body.brand = args.brand.trim();
  if (args.model !== undefined) body.model = args.model.trim();
  if (args.type) body.type = args.type;
  if (args.serial !== undefined) body.serial = args.serial.trim();
  if (args.description !== undefined) body.desc = args.description;
  if (args.specs) body.specs = args.specs;
  if (args.purchased) body.purchased = args.purchased;
  if (args.warranty) body.warranty = args.warranty;
  if (args.cost !== undefined) body.cost = args.cost.toFixed(2);
  if (args.department) body.departmentUuid = (await resolveDepartment(session.client, base, args.department)).id;
  if (args.holder) body.holderUuid = await resolvePerson(session.client, base, args.holder, () => session.myMemberId());
  return body;
}

export function registerAssetTools(ctx: ToolContext): void {
  defineTool(
    ctx,
    "list_assets",
    {
      title: "List assets",
      description: "Lists the workspace's assets (devices, licences) with holder and status; search, status, type and paging.",
      inputSchema: {
        ...workspaceArg,
        q: z.string().optional().describe("Search text (number, brand, model, holder)."),
        status: z.enum(["All", "Available", "Assigned", "Repair", "Lost", "Retired", "Archived"]).optional().describe("Default All."),
        type: z.enum(ASSET_TYPES).optional(),
        department: z.string().optional().describe("Only this department's assets — uuid or exact name."),
        ...pagingArgs,
      },
      annotations: READ,
      access: readOf("assets"),
    },
    async (args, session) => {
      const { base } = await session.wsPath(args.workspace);
      const { page, size } = pageOf(args);
      const department = args.department ? (await resolveDepartment(session.client, base, args.department)).id : undefined;
      const res = await session.client.get<Page<Asset>>(`${base}/assets`, {
        q: args.q,
        tab: args.status,
        type: args.type,
        department,
        page,
        size,
      });
      const rows = (res.rows ?? []).map(assetRow);
      const paging = { page, size, total: res.total ?? rows.length, shown: rows.length };
      const text = [...rows.map((a) => `- ${assetLine(a)}`), pagingLine(paging)].join("\n");
      return result(text, { rows, total: paging.total, page, size, hasMore: hasMore(paging) }, ctx.token());
    },
  );

  defineTool(
    ctx,
    "create_asset",
    {
      title: "Create asset",
      description:
        "Registers an asset. Brand, model and serial are required; the asset number is assigned by the server " +
        "unless given. Naming a holder hands it to them. " +
        CONFIRM_FIRST,
      inputSchema: {
        ...workspaceArg,
        ...assetFields,
        brand: z.string().min(1).max(100),
        model: z.string().min(1).max(200),
        serial: z.string().min(1).max(100),
        number: z.string().min(1).max(40).optional().describe("Asset number (the tag). Default: the next one."),
      },
      annotations: writeHints(false),
      access: writeOf("assets:write", ["assets", "add"]),
    },
    async (args, session) => {
      const { base } = await session.wsPath(args.workspace);
      const body = await assetBody(session, base, args);
      if (args.number) body.number = args.number.trim();
      const a = assetRow(await session.client.post<Asset>(`${base}/assets`, body));
      return result(`Created: ${assetLine(a)}`, { asset: a }, ctx.token());
    },
  );

  defineTool(
    ctx,
    "update_asset",
    {
      title: "Update asset",
      description:
        "Changes an asset's details, its holder (handing it over is recorded in its history) or its status " +
        "(Available, Repair, Lost, Retired). Only the fields given change. " +
        CONFIRM_FIRST,
      inputSchema: {
        ...workspaceArg,
        asset: z.string().min(1).describe("Asset uuid, number or serial."),
        ...assetFields,
        status: z.enum(ASSET_STATUSES).optional(),
        note: z.string().max(2000).optional().describe("A note for the asset's history, e.g. why it changed hands."),
      },
      annotations: writeHints(true),
      access: writeOf("assets:write", ["assets", "edit"]),
    },
    async (args, session) => {
      const { base } = await session.wsPath(args.workspace);
      const current = await resolveAsset(session.client, base, args.asset);
      const body = await assetBody(session, base, args);
      if (args.status) body.status = args.status;
      if (Object.keys(body).length === 0) throw new ResolveError("Nothing to update: pass at least one field to change.");
      if (args.note !== undefined) body.note = args.note;
      const a = assetRow(await session.client.patch<Asset>(`${base}/assets/${current.id}`, body));
      return result(`Updated: ${assetLine(a)}`, { asset: a }, ctx.token());
    },
  );
}
