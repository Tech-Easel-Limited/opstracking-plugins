import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { allows, holdingsOf, TIER_A_SCOPES, TIER_B_SCOPES, writeOf } from "../src/access.js";
import { createServer } from "../src/server.js";
import type { Me } from "../src/types.js";
import { baseRoutes, connect, FULL_PERMS, me, textOf, type Route } from "./helpers.js";

/** The fixture's `/api/auth/me`, with this token and these grants in the first workspace. */
function meWith(opts: {
  scopes?: string[] | null;
  perms?: Array<{ cat: string; enabled: boolean; acts: string[] }>;
  orgRole?: number;
  legacy?: boolean;
}): Me {
  const base = structuredClone(me) as Me;
  base.workspaces = [{ ...base.workspaces![0], perms: opts.perms ?? FULL_PERMS }, base.workspaces![1]];
  if (opts.orgRole !== undefined) base.orgs = base.orgs.map((o) => ({ ...o, orgRole: opts.orgRole }));
  if (opts.legacy) delete base.token;
  else base.token = { id: "t1", name: "Claude on test", scopes: opts.scopes ?? [...TIER_A_SCOPES], expiresAt: null };
  return base;
}

const routesFor = (body: Me): Route[] => [{ method: "GET", path: "/auth/me", reply: { body } }, ...baseRoutes()];

async function listed(body: Me): Promise<Set<string>> {
  const { client, close } = await connect(routesFor(body));
  const { tools } = await client.listTools();
  await close();
  return new Set(tools.map((t) => t.name));
}

const REQUEST_TOOLS = [
  "request_workspace_invite",
  "request_client_invite",
  "request_portal_access",
  "request_project_member_change",
  "request_client_access",
  "request_role_assignment",
  "request_invoice_send",
  "request_invoice_paid",
  "request_timesheet_submit",
];

describe("which tools are listed", () => {
  it("follows the token's scopes and the person's permissions together", async () => {
    const names = await listed(
      meWith({ scopes: ["tasks:write", "projects:write"], perms: [{ cat: "tasks", enabled: true, acts: ["view", "add", "edit"] }] }),
    );
    // Held scope and held grant.
    for (const n of ["create_task", "update_task", "add_task_comment", "bulk_update_tasks", "set_task_parent"]) assert.ok(names.has(n), n);
    // Scope held, grant not: tasks.assign, projects.*.
    for (const n of ["set_task_assignees", "create_project", "update_project_column"]) assert.ok(!names.has(n), n);
    // Grant not held: the read is not listed either.
    for (const n of ["list_projects", "list_clients", "list_invoices", "list_assets"]) assert.ok(!names.has(n), n);
    // Grant held, scope not: no time or invoice writes.
    for (const n of ["log_time", "create_invoice_draft", "preview_invoice"]) assert.ok(!names.has(n), n);
    for (const n of ["whoami", "connect", "connection_status", "list_tasks", "get_task", "list_agent_requests"]) assert.ok(names.has(n), n);
    for (const n of REQUEST_TOOLS) assert.ok(!names.has(n), n);
  });

  it("lists no write tool for a read-only connection", async () => {
    const names = await listed(meWith({ scopes: [] }));
    for (const n of ["create_task", "log_time", "create_invoice_draft", "preview_invoice", "create_asset", "create_client"]) {
      assert.ok(!names.has(n), n);
    }
    assert.ok(names.has("list_invoices") && names.has("get_task") && names.has("list_departments"));
  });

  it("lists a request tool only with its approval scope and the grant its route needs", async () => {
    const all = await listed(meWith({ scopes: [...TIER_A_SCOPES, ...TIER_B_SCOPES] }));
    for (const n of REQUEST_TOOLS) assert.ok(all.has(n), n);

    const noInvite = await listed(
      meWith({
        scopes: [...TIER_B_SCOPES],
        perms: FULL_PERMS.filter((p) => p.cat !== "employees" && p.cat !== "wsaccess" && p.cat !== "wsroles"),
        orgRole: 4,
      }),
    );
    assert.ok(!noInvite.has("request_workspace_invite"), "needs employees.add");
    assert.ok(!noInvite.has("request_role_assignment"), "needs wsaccess/wsroles assign");
    assert.ok(noInvite.has("request_invoice_send"));
    assert.ok(noInvite.has("request_timesheet_submit"));
    // Tier B scopes never list a direct write.
    assert.ok(!noInvite.has("create_task"));

    // The invite route stands behind employees.view as well as .add.
    const addOnly = await listed(
      meWith({ scopes: ["people:invite"], perms: [{ cat: "employees", enabled: true, acts: ["add"] }] }),
    );
    assert.ok(!addOnly.has("request_workspace_invite"));

    // An organization owner may assign roles whatever their seat holds.
    const owner = await listed(meWith({ scopes: ["roles:assign"], perms: [], orgRole: 1 }));
    assert.ok(owner.has("request_role_assignment"));
  });

  it("treats a token on an OpsTracking without scoped tokens as the direct-change scopes, with no approvals", async () => {
    const names = await listed(meWith({ legacy: true }));
    assert.ok(names.has("create_project") && names.has("log_time") && names.has("create_asset"));
    for (const n of [...REQUEST_TOOLS, "list_agent_requests", "get_agent_request"]) assert.ok(!names.has(n), n);
  });

  it("lists every tool when /api/auth/me fails, so each can say what is wrong", async () => {
    const { client, call, close } = await connect([
      { method: "GET", path: "/auth/me", reply: { status: 401, body: { error: { code: "invalid_token", message: "Invalid or expired token." } } } },
    ]);
    const names = new Set((await client.listTools()).tools.map((t) => t.name));
    for (const n of [...REQUEST_TOOLS, "create_project", "list_assets"]) assert.ok(names.has(n), n);
    const r = await call("request_invoice_send", { invoice: "INV-1" });
    assert.match(textOf(r), /did not accept the API token/);
    await close();
  });

  it("lists every tool while not connected, each answering how to connect", async () => {
    const { server } = createServer({ env: { OPSTRACKING_CONFIG: "/nonexistent/opstracking.json" } });
    const { Client } = await import("@modelcontextprotocol/sdk/client/index.js");
    const { InMemoryTransport } = await import("@modelcontextprotocol/sdk/inMemory.js");
    const [a, b] = InMemoryTransport.createLinkedPair();
    const client = new Client({ name: "t", version: "0" });
    await Promise.all([server.connect(b), client.connect(a)]);
    const names = new Set((await client.listTools()).tools.map((t) => t.name));
    for (const n of [...REQUEST_TOOLS, "create_project", "update_invoice_draft", "list_agent_requests"]) assert.ok(names.has(n), n);
    const r = await client.callTool({ name: "request_timesheet_submit", arguments: {} });
    assert.equal(r.isError, true);
    assert.match(textOf(r as never), /OpsTracking is not connected yet/);
    await client.close();
  });

  it("re-decides when permissions change, with one tools/list_changed", async () => {
    let body = meWith({ scopes: ["tasks:write"] });
    const { client, gate, close } = await connect([{ method: "GET", path: "/auth/me", reply: () => ({ body }) }, ...baseRoutes()]);
    const { ToolListChangedNotificationSchema } = await import("@modelcontextprotocol/sdk/types.js");
    let notices = 0;
    client.setNotificationHandler(ToolListChangedNotificationSchema, () => {
      notices++;
    });
    assert.ok(!(await client.listTools()).tools.some((t) => t.name === "create_project"));

    body = meWith({ scopes: ["tasks:write", "projects:write"] });
    await gate.refresh();
    await new Promise((r) => setTimeout(r, 20));
    assert.equal(notices, 1, "six tools appear; the client hears once");
    assert.ok((await client.listTools()).tools.some((t) => t.name === "create_project"));

    // Nothing changed: nothing is sent.
    await gate.refresh();
    await new Promise((r) => setTimeout(r, 20));
    assert.equal(notices, 1);
    await close();
  });

  it("allows() reads each grant from the seat's enabled matrix only", () => {
    const held = holdingsOf(meWith({ perms: [{ cat: "projects", enabled: false, acts: ["view", "add"] }] }));
    assert.equal(allows(writeOf("projects:write", ["projects", "add"]), held), false, "a disabled category grants nothing");
    const other = holdingsOf(meWith({ perms: [{ cat: "projects", enabled: true, acts: ["view", "add"] }] }));
    assert.equal(allows(writeOf("projects:write", ["projects", "add"]), other), true);
    assert.equal(allows(writeOf("projects:write", ["projects", "archive"]), other), false);
    assert.equal(holdingsOf(meWith({ scopes: ["tasks:write", "not:a-scope"] })).scopes.size, 1);
  });
});

describe("whoami shows what the connection may change", () => {
  it("names the direct and the approved scopes in the approval page's words", async () => {
    const { call, close } = await connect(routesFor(meWith({ scopes: ["tasks:write", "invoices:send"] })));
    const t = textOf(await call("whoami"));
    assert.match(t, /Connection: Claude on test/);
    assert.match(t, /Changes it can make: Tasks — create, edit, assign, comment \(tasks:write\)/);
    assert.match(t, /Changes the user approves in the app: Send invoices and mark them paid \(you approve each one\) \(invoices:send\)/);
    await close();
  });

  it("says read only, and says when the server predates scopes", async () => {
    const ro = await connect(routesFor(meWith({ scopes: [] })));
    assert.match(textOf(await ro.call("whoami")), /Changes allowed: none — this connection is read only\./);
    await ro.close();
    const legacy = await connect(routesFor(meWith({ legacy: true })));
    assert.match(textOf(await legacy.call("whoami")), /predates per-permission connections/);
    await legacy.close();
  });
});
