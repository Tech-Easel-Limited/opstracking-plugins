import type { RegisteredTool } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { Me, MeWorkspace } from "./types.js";

/**
 * Which tools the model is shown.
 *
 * A token carries two narrowings of its owner's authority
 * (docs/plans/MCP-EXPANSION.md §8): the scopes the person ticked when they
 * approved the connection, which govern writes only, and their own role in
 * each workspace. OpsTracking enforces both on every request; this module
 * only keeps the tool list honest, so the model never sees a tool it cannot
 * use. Both are read from `GET /api/auth/me`: `token.scopes`, and the
 * permission grants of every workspace seat.
 */

/** Tier A: the tool calls the route directly (§3). */
export const TIER_A_SCOPES = [
  "projects:write",
  "structure:write",
  "clients:write",
  "tasks:write",
  "time:write",
  "invoices:draft",
  "assets:write",
] as const;

/** Tier B: the tool files a request the person approves in the app (§3). */
export const TIER_B_SCOPES = ["people:invite", "projects:roster", "roles:assign", "invoices:send", "time:submit"] as const;

export type Scope = (typeof TIER_A_SCOPES)[number] | (typeof TIER_B_SCOPES)[number];

/** The approval page's own words for each scope (§8.1), so whoami matches what the person ticked. */
export const SCOPE_LABELS: Record<Scope, string> = {
  "projects:write": "Projects — create, edit, archive, board columns",
  "structure:write": "Departments and teams",
  "clients:write": "Clients and contacts",
  "tasks:write": "Tasks — create, edit, assign, comment",
  "time:write": "Your time entries and timer",
  "invoices:draft": "Invoice drafts",
  "assets:write": "Assets",
  "people:invite": "Invite people (you approve each one)",
  "projects:roster": "Project members and client sharing (you approve each change)",
  "roles:assign": "Assign workspace roles (you approve each one)",
  "invoices:send": "Send invoices and mark them paid (you approve each one)",
  "time:submit": "Submit your timesheet (you approve it)",
};

const KNOWN = new Set<string>([...TIER_A_SCOPES, ...TIER_B_SCOPES]);
const isScope = (s: string): s is Scope => KNOWN.has(s);

/** A permission-matrix cell: category and act, as `/api/auth/me` names them (`["tasks", "edit"]`). */
export type Grant = readonly [category: string, action: string];

/**
 * What a tool needs. Every field narrows; an empty object is "always shown".
 */
export type Access = {
  /** The scope the token must hold. Reads have none (MX-9). */
  scope?: Scope;
  /** Grants any one of which, in any workspace seat, lets the person do this. */
  anyOf?: readonly Grant[];
  /** Grants that same seat must hold as well — a route behind two gates (the employee invite). */
  allOf?: readonly Grant[];
  /** Organization owners and admins may do this whatever their seat holds (role assignment). */
  orgGovernors?: boolean;
  /** Needs the agent-request API, which only an OpsTracking with scoped tokens has. */
  agentRequests?: boolean;
};

export const ALWAYS: Access = {};

/** A read: the view grant of one category. */
export const readOf = (category: string): Access => ({ anyOf: [[category, "view"]] });

/** A write: the scope, and any one of the grants. */
export const writeOf = (scope: Scope, ...anyOf: Grant[]): Access => ({ scope, anyOf });

/** What the token and its owner hold, as one `/api/auth/me` answer says. */
type Holdings = {
  scopes: ReadonlySet<Scope>;
  /** False on an OpsTracking that predates scoped tokens. */
  scoped: boolean;
  seats: MeWorkspace[];
  governsOrg: boolean;
};

const ORG_OWNER = 1;
const ORG_ADMIN = 2;

export function holdingsOf(me: Me): Holdings {
  const org = me.orgs?.find((o) => o.id === me.currentOrg?.id) ?? me.orgs?.[0];
  const governsOrg = org?.orgRole === ORG_OWNER || org?.orgRole === ORG_ADMIN;
  const seats = me.workspaces ?? [];
  if (!me.token) {
    // An OpsTracking without scoped tokens: every write token there is what
    // MX-7 maps an existing write token to — the Tier A scopes — and there is
    // no agent-request API. A read token's writes are refused by the server
    // (`token_read_only`), as they always were.
    return { scopes: new Set(TIER_A_SCOPES), scoped: false, seats, governsOrg };
  }
  const scopes = new Set((me.token.scopes ?? []).filter(isScope));
  return { scopes, scoped: true, seats, governsOrg };
}

const holds = (seat: MeWorkspace, [category, action]: Grant): boolean =>
  (seat.perms ?? []).some((p) => p.cat === category && p.enabled && (p.acts ?? []).includes(action));

export function allows(access: Access, held: Holdings): boolean {
  if (access.agentRequests && !held.scoped) return false;
  if (access.scope && !held.scopes.has(access.scope)) return false;
  const grants = access.anyOf ?? [];
  const also = access.allOf ?? [];
  if (grants.length === 0 && also.length === 0) return true;
  if (access.orgGovernors && held.governsOrg) return true;
  return held.seats.some(
    (seat) => (grants.length === 0 || grants.some((g) => holds(seat, g))) && also.every((g) => holds(seat, g)),
  );
}

type Gated = { tool: RegisteredTool; access: Access };

/**
 * Shows and hides the registered tools.
 *
 * Every tool is registered once, at start-up, and starts shown: without a
 * working connection each one answers how to connect, which is the only place
 * the person looking at the chat will see that. Once `/api/auth/me` answers,
 * each tool is shown exactly when the token and its owner allow it, through
 * the SDK's own enable/disable — which sends `notifications/tools/list_changed`
 * (debounced into one, src/server.ts). A failed `/api/auth/me` shows everything
 * again, so the tools can say what went wrong.
 */
export class ToolGate {
  private readonly tools = new Map<string, Gated>();
  private readonly load: () => Promise<Me | undefined>;
  private queue: Promise<void> = Promise.resolve();

  constructor(load: () => Promise<Me | undefined>) {
    this.load = load;
  }

  add(name: string, tool: RegisteredTool, access: Access): void {
    this.tools.set(name, { tool, access });
  }

  /** Shows the tools this `/api/auth/me` allows, or every tool without one. */
  apply(me: Me | undefined): void {
    const held = me ? holdingsOf(me) : undefined;
    for (const { tool, access } of this.tools.values()) {
      const want = held ? allows(access, held) : true;
      if (tool.enabled === want) continue;
      if (want) tool.enable();
      else tool.disable();
    }
  }

  /**
   * Re-reads `/api/auth/me` and applies it. Refreshes run one after another,
   * so the last one to finish is the last one asked for.
   */
  refresh(): Promise<void> {
    this.queue = this.queue.then(async () => this.apply(await this.load().catch(() => undefined)));
    return this.queue;
  }
}
