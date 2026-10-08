import { ApiError, type OpsTrackingClient } from "./client.js";
import type {
  Asset,
  BoardColumn,
  Client,
  Contact,
  Department,
  Employee,
  Invoice,
  List,
  Page,
  Project,
  ProjectDetail,
  ProjectMember,
  Role,
  Team,
} from "./types.js";

/**
 * Turning what a person says ("the Website project", "Done", "Sara") into the
 * uuids the API speaks.
 *
 * The rule throughout: an exact match (ignoring case) is used; two exact
 * matches, or none, is an error that lists the candidates. A near miss is
 * offered as a suggestion, never silently taken — writing to the wrong
 * project because its name was close is worse than asking.
 */

export class ResolveError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ResolveError";
  }
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
export const isUuid = (s: string): boolean => UUID.test(s.trim());

/** CAT-12 — a project key, a dash, the per-project number. */
export const TASK_HANDLE = /^[A-Za-z][A-Za-z0-9]{1,5}-\d{1,9}$/;

const norm = (s: string) => s.trim().toLowerCase().replace(/\s+/g, " ");

export type Candidate<T> = { item: T; label: string; keys: string[] };

export function choose<T>(
  kind: string,
  input: string,
  candidates: Candidate<T>[],
): T {
  const want = norm(input);
  const exact = candidates.filter((c) => c.keys.some((k) => k && norm(k) === want));
  if (exact.length === 1) return exact[0].item;
  if (exact.length > 1) {
    throw new ResolveError(
      `"${input}" matches more than one ${kind}: ${exact.map((c) => c.label).join("; ")}. ` +
        `Ask the user which one they mean, then pass its id.`,
    );
  }
  const partial = candidates.filter((c) => c.keys.some((k) => k && (norm(k).includes(want) || want.includes(norm(k)))));
  if (partial.length > 0) {
    const shown = partial.slice(0, 10).map((c) => c.label);
    const more = partial.length > shown.length ? ` (and ${partial.length - shown.length} more)` : "";
    throw new ResolveError(
      `No ${kind} is named exactly "${input}". Did you mean: ${shown.join("; ")}${more}? ` +
        `Confirm with the user, then pass the exact name or id.`,
    );
  }
  if (candidates.length === 0) throw new ResolveError(`No ${kind} matches "${input}" — there are none available.`);
  const shown = candidates.slice(0, 20).map((c) => c.label);
  const more = candidates.length > shown.length ? ` (and ${candidates.length - shown.length} more)` : "";
  throw new ResolveError(`No ${kind} matches "${input}". Available: ${shown.join("; ")}${more}.`);
}

/** Reads every page of a list endpoint, up to a hard ceiling. */
export async function listAll<T>(
  client: OpsTrackingClient,
  path: string,
  query: Record<string, string | number | undefined> = {},
  maxPages = 10,
): Promise<T[]> {
  const out: T[] = [];
  for (let page = 1; page <= maxPages; page++) {
    const res = await client.get<Page<T>>(path, { ...query, page, size: 100 });
    const rows = res?.rows ?? [];
    out.push(...rows);
    if (rows.length < 100 || out.length >= (res?.total ?? 0)) break;
  }
  return out;
}

const projectLabel = (p: Project) => `${p.name}${p.key ? ` [${p.key}]` : ""} (${p.id})`;

/** A project by uuid, key (CAT) or exact name. */
export async function resolveProject(client: OpsTrackingClient, base: string, input: string): Promise<Project> {
  const value = input.trim();
  if (value === "") throw new ResolveError("A project is required.");
  if (isUuid(value)) return client.get<ProjectDetail>(`${base}/projects/${value}`);
  const all = await listAll<Project>(client, `${base}/projects`, { tab: "all" });
  return choose("project", value, all.map((p) => ({ item: p, label: projectLabel(p), keys: [p.name, p.key ?? ""] })));
}

/** The project detail, which carries the roster (`memberList`). */
export async function projectDetail(client: OpsTrackingClient, base: string, input: string): Promise<ProjectDetail> {
  const p = await resolveProject(client, base, input);
  if ("memberList" in p) return p as ProjectDetail;
  return client.get<ProjectDetail>(`${base}/projects/${p.id}`);
}

export async function listColumns(client: OpsTrackingClient, base: string, projectId: string): Promise<BoardColumn[]> {
  return (await client.get<BoardColumn[]>(`${base}/projects/${projectId}/columns`)) ?? [];
}

/** A board column (a task status) by uuid or exact name, within one project. */
export async function resolveColumn(
  client: OpsTrackingClient,
  base: string,
  projectId: string,
  input: string,
): Promise<BoardColumn> {
  const cols = await listColumns(client, base, projectId);
  const value = input.trim();
  if (isUuid(value)) {
    const hit = cols.find((c) => c.id.toLowerCase() === value.toLowerCase());
    if (hit) return hit;
  }
  return choose("status column", value, cols.map((c) => ({ item: c, label: c.name, keys: [c.name] })));
}

/**
 * People on a project's roster, by uuid, email or exact name. "me" is the
 * caller. Only roster members can be assigned — the API refuses anyone else.
 */
export function resolveMembers(roster: ProjectMember[], inputs: string[], myMemberId?: string): ProjectMember[] {
  const out: ProjectMember[] = [];
  for (const raw of inputs) {
    const value = raw.trim();
    if (value === "") continue;
    let hit: ProjectMember | undefined;
    if (norm(value) === "me") {
      hit = roster.find((m) => m.id === myMemberId);
      if (!hit) throw new ResolveError(`You are not on this project's roster, so "me" cannot be assigned here.`);
    } else if (isUuid(value)) {
      hit = roster.find((m) => m.id.toLowerCase() === value.toLowerCase());
      if (!hit) throw new ResolveError(`Member ${value} is not on this project's roster. Only project members can be assigned.`);
    } else {
      hit = choose(
        "project member",
        value,
        roster.map((m) => ({ item: m, label: `${m.name}${m.email ? ` <${m.email}>` : ""}`, keys: [m.name, m.email ?? ""] })),
      );
    }
    if (!out.some((m) => m.id === hit.id)) out.push(hit);
  }
  return out;
}

/** A client by uuid, exact name or short name. */
export async function resolveClient(client: OpsTrackingClient, base: string, input: string): Promise<Client> {
  const value = input.trim();
  if (value === "") throw new ResolveError("A client is required.");
  if (isUuid(value)) return client.get<Client>(`${base}/clients/${value}`);
  const all = await listAll<Client>(client, `${base}/clients`, { status: "all" });
  return choose("client", value, all.map((c) => ({ item: c, label: `${c.name} (${c.id})`, keys: [c.name, c.short ?? ""] })));
}

/**
 * Anyone in the workspace by uuid, email or exact name — for filters that are
 * not tied to one project. Reads the employee directory, which needs the
 * employees.view grant; without it the caller is told to use "me" or a uuid.
 */
export async function resolvePerson(
  client: OpsTrackingClient,
  base: string,
  input: string,
  myMemberId: () => Promise<string>,
): Promise<string> {
  const value = input.trim();
  if (norm(value) === "me") return myMemberId();
  if (isUuid(value)) return value;
  let people: Employee[];
  try {
    people = await listAll<Employee>(client, `${base}/employees`, { q: value }, 3);
  } catch (err) {
    if (err instanceof ApiError && err.status === 403) {
      throw new ResolveError(
        `Your role cannot read the people directory, so "${value}" cannot be looked up by name. ` +
          `Use "me", pass a member id, or narrow by project so the project roster can be used.`,
      );
    }
    throw err;
  }
  return choose(
    "person",
    value,
    people.map((p) => ({ item: p, label: `${p.name}${p.email ? ` <${p.email}>` : ""}`, keys: [p.name, p.email ?? ""] })),
  ).id;
}

/** A department by uuid or exact name, archived ones included. */
export async function resolveDepartment(client: OpsTrackingClient, base: string, input: string): Promise<Department> {
  const value = input.trim();
  if (value === "") throw new ResolveError("A department is required.");
  if (isUuid(value)) return client.get<Department>(`${base}/departments/${value}`);
  const all = (await client.get<List<Department>>(`${base}/departments`, { status: "all" }))?.rows ?? [];
  return choose("department", value, all.map((d) => ({ item: d, label: `${d.name} (${d.id})`, keys: [d.name] })));
}

/** A team by uuid or exact name, archived ones included. */
export async function resolveTeam(client: OpsTrackingClient, base: string, input: string): Promise<Team> {
  const value = input.trim();
  if (value === "") throw new ResolveError("A team is required.");
  if (isUuid(value)) return client.get<Team>(`${base}/teams/${value}`);
  const all = (await client.get<List<Team>>(`${base}/teams`, { status: "all" }))?.rows ?? [];
  return choose(
    "team",
    value,
    all.map((t) => ({ item: t, label: `${t.name}${t.department?.name ? ` in ${t.department.name}` : ""} (${t.id})`, keys: [t.name] })),
  );
}

/** An invoice's uuid, from its uuid or its number. */
export async function resolveInvoice(client: OpsTrackingClient, base: string, input: string): Promise<string> {
  const value = input.trim();
  if (isUuid(value)) return value;
  const res = await client.get<Page<Invoice>>(`${base}/invoices`, { q: value, page: 1, size: 100 });
  return choose(
    "invoice",
    value,
    (res.rows ?? []).map((i) => ({ item: i, label: `${i.number ?? "(no number)"} · ${i.client?.name ?? ""} (${i.id})`, keys: [i.number ?? ""] })),
  ).id;
}

/** An asset by uuid or its asset number (the tag on the device). */
export async function resolveAsset(client: OpsTrackingClient, base: string, input: string): Promise<Asset> {
  const value = input.trim();
  if (value === "") throw new ResolveError("An asset is required.");
  if (isUuid(value)) return client.get<Asset>(`${base}/assets/${value}`);
  const res = await client.get<Page<Asset>>(`${base}/assets`, { q: value, tab: "All", page: 1, size: 100 });
  return choose(
    "asset",
    value,
    (res.rows ?? []).map((a) => ({ item: a, label: `${a.number ?? ""} ${a.label ?? ""} (${a.id})`.trim(), keys: [a.number ?? "", a.serial ?? ""] })),
  );
}

/** One of a client's contacts by uuid, email or exact name. */
export function resolveContact(contacts: Contact[], input: string): Contact {
  const value = input.trim();
  if (isUuid(value)) {
    const hit = contacts.find((c) => c.id.toLowerCase() === value.toLowerCase());
    if (hit) return hit;
  }
  return choose(
    "contact",
    value,
    contacts.map((c) => ({ item: c, label: `${c.name ?? ""}${c.email ? ` <${c.email}>` : ""} (${c.id})`, keys: [c.name ?? "", c.email ?? ""] })),
  );
}

/**
 * The workspace's roles: the full list when the caller may read it
 * (GET /roles, wsroles.view), else the roles they may hand out on an invite.
 * Without either, a role has to be given by id.
 */
async function workspaceRoles(client: OpsTrackingClient, base: string): Promise<Role[] | undefined> {
  try {
    const res = await client.get<{ groups?: Array<{ roles?: Role[] | null }> | null }>(`${base}/roles`);
    return (res.groups ?? []).flatMap((g) => g.roles ?? []);
  } catch (err) {
    if (!(err instanceof ApiError) || err.status !== 403) throw err;
  }
  try {
    return (await client.get<{ rows?: Role[] | null }>(`${base}/employees/invite/roles`)).rows ?? [];
  } catch (err) {
    if (err instanceof ApiError && err.status === 403) return undefined;
    throw err;
  }
}

/** A workspace role by uuid or exact name; `external` limits it to the client-team roles. */
export async function resolveRole(
  client: OpsTrackingClient,
  base: string,
  input: string,
  which: "internal" | "external" | "any" = "any",
): Promise<Role> {
  const value = input.trim();
  if (value === "") throw new ResolveError("A role is required.");
  const roles = await workspaceRoles(client, base);
  if (roles === undefined) {
    if (isUuid(value)) return { id: value, name: value };
    throw new ResolveError(`Your role cannot list the workspace's roles, so "${value}" cannot be looked up by name. Pass the role's id.`);
  }
  const external = (r: Role) => r.external === true || (r.key ?? "").startsWith("r_client");
  const pool = roles.filter((r) => which === "any" || (which === "external") === external(r));
  if (isUuid(value)) {
    const hit = pool.find((r) => r.id.toLowerCase() === value.toLowerCase());
    if (hit) return hit;
  }
  return choose(which === "external" ? "client-team role" : "role", value, pool.map((r) => ({ item: r, label: `${r.name} (${r.id})`, keys: [r.name] })));
}
