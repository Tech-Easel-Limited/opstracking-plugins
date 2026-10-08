import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import { TIER_A_SCOPES } from "../src/access.js";
import type { FetchLike } from "../src/client.js";
import type { Config } from "../src/config.js";
import { createServer } from "../src/server.js";

export const TOKEN = `otk_${"0123456789abcdef".repeat(2)}_${"Ab9".repeat(13)}-_Zq`;
export const BASE = "https://acme.neoeasel.com";

export const WS1 = "11111111-1111-4111-8111-111111111111";
export const WS2 = "22222222-2222-4222-8222-222222222222";
export const ME = "99999999-9999-4999-8999-999999999999";
export const P1 = "a1111111-1111-4111-8111-111111111111";
export const P2 = "a2222222-2222-4222-8222-222222222222";
export const P3 = "a3333333-3333-4333-8333-333333333333";
export const C_TODO = "c1111111-1111-4111-8111-111111111111";
export const C_PROG = "c2222222-2222-4222-8222-222222222222";
export const C_DONE = "c3333333-3333-4333-8333-333333333333";
export const M_SARA = "b1111111-1111-4111-8111-111111111111";
export const M_ALI_R = "b2222222-2222-4222-8222-222222222222";
export const M_ALI_H = "b3333333-3333-4333-8333-333333333333";
export const T1 = "d1111111-1111-4111-8111-111111111111";
export const CL1 = "e1111111-1111-4111-8111-111111111111";

/** Every act of every category a seat can hold — a Workspace Admin's matrix. */
export const FULL_PERMS = [
  ["overview", ["view", "export"]],
  ["departments", ["view", "add", "edit", "archive", "restore", "delete", "export"]],
  ["teams", ["view", "add", "edit", "archive", "restore", "delete", "assign", "export"]],
  ["employees", ["view", "add", "edit", "archive", "restore", "delete", "export"]],
  ["clients", ["view", "add", "edit", "archive", "restore", "delete", "status", "export"]],
  ["projects", ["view", "add", "edit", "archive", "restore", "delete", "assign", "status", "export"]],
  ["tasks", ["view", "add", "edit", "delete", "assign", "status"]],
  ["timesheets", ["view", "add", "edit", "delete", "approve", "reject", "export"]],
  ["invoicing", ["view", "add", "edit", "export", "settings"]],
  ["reports", ["view", "add", "export"]],
  ["assets", ["view", "add", "edit", "archive", "restore", "delete", "assign", "export"]],
  ["wsaccess", ["view", "assign"]],
  ["wsroles", ["view", "add", "edit", "delete", "assign"]],
  ["settings", ["view", "edit"]],
  ["wsModules", ["view", "edit"]],
  ["wsNotifications", ["view", "edit"]],
  ["audit", ["view", "export"]],
].map(([cat, acts]) => ({ cat: cat as string, enabled: true, acts: acts as string[], extras: [] as string[] }));

export const me = {
  user: { id: "u1", username: "wali" },
  profile: { firstName: "Wali", lastName: "Ahmed" },
  currentOrg: { id: "o1", name: "Amento Tech", slug: "amento-tech" },
  orgs: [{ id: "o1", name: "Amento Tech", slug: "amento-tech", memberId: ME, orgRole: 1, status: "Active" }],
  workspaces: [
    {
      id: WS1,
      name: "Delivery",
      role: { id: "r1", key: "r_pm", name: "Project Manager" },
      perms: FULL_PERMS,
      granted: 3,
      total: 10,
      memberType: "staff",
      tracksTime: true,
    },
    { id: WS2, name: "Sales", role: { id: "r2", name: "Viewer" }, perms: [], granted: 0, total: 10, memberType: "staff", tracksTime: false },
  ],
  needsOrg: false,
  // A connection approved with every direct-change scope, as an existing
  // write token is mapped (MX-7).
  token: { id: "t1", name: "Claude on test", scopes: [...TIER_A_SCOPES] as string[], expiresAt: "2026-12-25T00:00:00Z" },
};

export const projects = [
  { id: P1, name: "Website Redesign", key: "WEB", status: "Active", client: { id: CL1, name: "Globex" } },
  { id: P2, name: "Website Maintenance", key: "WM", status: "Active" },
  { id: P3, name: "Mobile App", key: "MOB", status: "Paused" },
];

export const projectP1 = {
  ...projects[0],
  memberList: [
    { id: M_SARA, name: "Sara Khan", email: "sara@acme.test" },
    { id: M_ALI_R, name: "Ali Raza", email: "ali.raza@acme.test" },
    { id: M_ALI_H, name: "Ali Raza", email: "ali.hassan@acme.test" },
    { id: ME, name: "Wali Ahmed", email: "wali@acme.test" },
  ],
};

export const columnsP1 = [
  { id: C_TODO, name: "To Do", position: 0, tasks: 3 },
  { id: C_PROG, name: "In Progress", position: 1, tasks: 1 },
  { id: C_DONE, name: "Done", position: 2, tasks: 5, done: true },
];

export const taskT1 = {
  id: T1,
  title: "Fix login redirect",
  desc: "Broken after deploy",
  project: { id: P1, name: "Website Redesign" },
  column: { id: C_TODO, name: "To Do" },
  priority: "High",
  type: "Bug",
  key: "WEB",
  number: 12,
  assignees: [{ id: M_SARA, name: "Sara Khan" }],
  tags: ["auth"],
  commentList: [{ id: "k1", author: { id: M_SARA, name: "Sara Khan" }, body: "Seen on Safari", createdAt: "2026-09-20T10:00:00Z" }],
};

export type Call = {
  method: string;
  path: string;
  query: Record<string, string>;
  headers: Record<string, string>;
  body: unknown;
};

export type Reply = { status?: number; body?: unknown; headers?: Record<string, string>; raw?: string };
export type Route = { method: string; path: string | RegExp; reply: Reply | ((call: Call) => Reply) };

/**
 * A fake OpsTracking. Routes match on method and the path under /api; the
 * first match wins. Every call is recorded so a test can assert the exact
 * request a tool made. An unmatched call answers 599 so it fails loudly.
 */
export function fakeApi(routes: Route[]) {
  const calls: Call[] = [];
  const fetchImpl: FetchLike = async (input, init) => {
    const url = new URL(input);
    const path = url.pathname.replace(/^\/api/, "");
    const headers: Record<string, string> = {};
    new Headers(init.headers).forEach((v, k) => (headers[k] = v));
    const call: Call = {
      method: init.method ?? "GET",
      path,
      query: Object.fromEntries(url.searchParams),
      headers,
      body: typeof init.body === "string" ? JSON.parse(init.body) : undefined,
    };
    calls.push(call);
    const route = routes.find(
      (r) => r.method === call.method && (typeof r.path === "string" ? r.path === path : r.path.test(path)),
    );
    const reply: Reply = route
      ? typeof route.reply === "function"
        ? route.reply(call)
        : route.reply
      : { status: 599, body: { error: { code: "unrouted", message: `no route for ${call.method} ${path}` } } };
    const text = reply.raw ?? (reply.body === undefined ? "" : JSON.stringify(reply.body));
    return new Response(text === "" ? null : text, { status: reply.status ?? 200, headers: reply.headers });
  };
  return { calls, fetch: fetchImpl };
}

/** The routes almost every tool needs: who am I, the projects, P1's detail and columns. */
export function baseRoutes(): Route[] {
  const ws = `/ws/${WS1}`;
  return [
    { method: "GET", path: "/auth/me", reply: { body: me } },
    { method: "GET", path: `${ws}/projects`, reply: { body: { rows: projects, total: projects.length, page: 1, size: 100, tabs: {} } } },
    { method: "GET", path: `${ws}/projects/${P1}`, reply: { body: projectP1 } },
    { method: "GET", path: `${ws}/projects/${P1}/columns`, reply: { body: columnsP1 } },
    { method: "GET", path: new RegExp(`^${ws}/tasks/(WEB-12|${T1})$`, "i"), reply: { body: taskT1 } },
  ];
}

/**
 * A server on the fake API, connected to an in-memory client. It waits for
 * the first look at `/api/auth/me`, so the tool list is already the one the
 * token and its owner allow when the test starts.
 */
export async function connect(routes: Route[], config: Partial<Config> = {}) {
  const api = fakeApi(routes);
  const { server, gate } = createServer({ config: { baseUrl: BASE, token: TOKEN, ...config }, fetch: api.fetch, timeoutMs: 2000 });
  const [clientSide, serverSide] = InMemoryTransport.createLinkedPair();
  const client = new Client({ name: "test", version: "0" });
  await Promise.all([server.connect(serverSide), client.connect(clientSide)]);
  await gate.refresh();
  const call = async (name: string, args: Record<string, unknown> = {}) =>
    (await client.callTool({ name, arguments: args })) as CallToolResult;
  return { client, call, calls: api.calls, gate, close: () => client.close() };
}

export function textOf(r: CallToolResult): string {
  return r.content.map((c) => (c.type === "text" ? c.text : "")).join("\n");
}

/** The calls that change something. */
export const writes = (calls: Call[]) => calls.filter((c) => c.method !== "GET");
