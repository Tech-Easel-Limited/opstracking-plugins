import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { createServer } from "../src/server.js";
import {
  baseRoutes,
  C_DONE,
  C_PROG,
  CL1,
  connect,
  M_ALI_H,
  M_SARA,
  ME,
  P1,
  T1,
  taskT1,
  textOf,
  TOKEN,
  writes,
  WS1,
  WS2,
  type Route,
} from "./helpers.js";

const ws = `/ws/${WS1}`;

const created = (extra: Record<string, unknown> = {}) => ({ status: 201, body: { ...taskT1, ...extra } });

describe("tool catalogue", () => {
  it("marks reads read-only and writes non-destructive, and tells the model to confirm writes", async () => {
    const { client, close } = await connect(baseRoutes());
    const { tools } = await client.listTools();
    const byName = new Map(tools.map((t) => [t.name, t]));
    const reads = [
      "whoami", "list_projects", "get_project", "list_project_columns", "list_project_members", "list_tasks", "get_task",
      "list_task_comments", "list_clients", "get_client", "list_time_entries", "list_invoices", "get_invoice", "list_employees",
      "preview_invoice", "connection_status", "list_departments", "list_teams", "list_assets", "list_agent_requests",
      "get_agent_request",
    ];
    const writeTools = [
      "create_task", "update_task", "set_task_assignees", "add_task_comment", "bulk_update_tasks", "set_task_parent",
      "log_time", "update_time_entry", "start_timer", "stop_timer",
      "create_invoice_draft", "update_invoice_draft", "duplicate_invoice",
      "create_project", "update_project", "set_project_status", "archive_project", "create_project_column", "update_project_column",
      "create_department", "update_department", "archive_department", "restore_department",
      "create_team", "update_team", "archive_team", "restore_team",
      "create_client", "update_client", "archive_client", "restore_client", "add_client_contact", "update_client_contact",
      "create_asset", "update_asset",
    ];
    // The fixture's token holds every direct-change scope and no approval
    // scope, so no request_* tool is listed.
    assert.deepEqual([...byName.keys()].sort(), [...reads, ...writeTools, "connect"].sort());
    const connectTool = byName.get("connect");
    assert.equal(connectTool?.annotations?.readOnlyHint, false);
    assert.equal(connectTool?.annotations?.destructiveHint, false);
    for (const name of reads) assert.equal(byName.get(name)?.annotations?.readOnlyHint, true, name);
    for (const name of writeTools) {
      const t = byName.get(name);
      assert.equal(t?.annotations?.readOnlyHint, false, name);
      assert.equal(t?.annotations?.destructiveHint, false, name);
      assert.match(t?.description ?? "", /explicit confirmation/, name);
    }
    assert.equal(byName.get("update_task")?.annotations?.idempotentHint, true);
    assert.equal(byName.get("set_task_assignees")?.annotations?.idempotentHint, true);
    assert.equal(byName.get("create_task")?.annotations?.idempotentHint, false);
    assert.equal(byName.get("log_time")?.annotations?.idempotentHint, false);
    // Nothing that deletes, sends, approves or manages people is exposed.
    for (const name of byName.keys()) assert.doesNotMatch(name, /delete|remove|send|void|approve|reject|submit|role|permission|billing/);
    const { prompts } = await client.listPrompts();
    assert.deepEqual(prompts.map((p) => p.name).sort(), ["daily-standup", "triage-bug-report"]);
    await close();
  });

  it("answers every tool with how to connect when unconfigured", async () => {
    const { server, configError } = createServer({
      env: { OPSTRACKING_URL: "https://a.neoeasel.com", OPSTRACKING_CONFIG: "/nonexistent/opstracking.json" },
    });
    assert.match(configError?.message ?? "", /API token is not set/);
    const { Client } = await import("@modelcontextprotocol/sdk/client/index.js");
    const { InMemoryTransport } = await import("@modelcontextprotocol/sdk/inMemory.js");
    const [a, b] = InMemoryTransport.createLinkedPair();
    const client = new Client({ name: "t", version: "0" });
    await Promise.all([server.connect(b), client.connect(a)]);
    const r = await client.callTool({ name: "list_projects", arguments: {} });
    assert.equal(r.isError, true);
    const t = textOf(r as never);
    assert.match(t, /not connected yet \(The OpsTracking API token is not set\)/);
    // An address is known (from the environment), so connect reuses it.
    assert.match(t, /Call the `connect` tool — it reuses the saved address https:\/\/a\.neoeasel\.com/);
    assert.match(t, /Never ask the user for an API token/);
    await client.close();
  });
});

describe("reads", () => {
  it("whoami lists workspaces, roles and permissions", async () => {
    const { call, close } = await connect(baseRoutes());
    const r = await call("whoami");
    assert.match(textOf(r), /Signed in as Wali Ahmed \(@wali\) in Amento Tech/);
    assert.match(textOf(r), /Delivery \(.*\) \[default\] — role Project Manager, tracks time/);
    const s = r.structuredContent as {
      memberId: string;
      workspaces: Array<{ permissions: unknown[] }>;
      token: { name: string; scopes: string[] };
    };
    assert.equal(s.memberId, ME);
    assert.deepEqual(s.workspaces[0].permissions[6], { category: "tasks", actions: ["view", "add", "edit", "delete", "assign", "status"], extras: [], scope: "" });
    assert.deepEqual(s.workspaces[1].permissions, []);
    assert.equal(s.token.name, "Claude on test");
    assert.ok(s.token.scopes.includes("tasks:write"));
    await close();
  });

  it("list_tasks maps friendly filters onto the API's query", async () => {
    const routes: Route[] = [
      ...baseRoutes(),
      { method: "GET", path: `${ws}/tasks`, reply: { body: { rows: [taskT1], total: 60, page: 2, size: 25 } } },
    ];
    const { call, calls, close } = await connect(routes);
    const r = await call("list_tasks", {
      project: "web",
      status: "in progress",
      assignee: "sara@acme.test",
      priority: "High",
      overdue: true,
      sort: "due",
      page: 2,
    });
    const q = calls.find((c) => c.path === `${ws}/tasks`)?.query;
    assert.deepEqual(q, {
      projectUuid: P1,
      columnUuid: C_PROG,
      assigneeMemberUuid: M_SARA,
      priority: "High",
      overdue: "true",
      sort: "due",
      page: "2",
      size: "25",
    });
    assert.match(textOf(r), /WEB-12 · <workspace-data field="title">Fix login redirect<\/workspace-data>/);
    assert.match(textOf(r), /Showing 26–26 of 60 \(page 2 of 3\)\. More results: call again with page=3\./);
    assert.equal((r.structuredContent as { hasMore: boolean }).hasMore, true);
    await close();
  });

  it("list_tasks resolves 'me' without a project and refuses a column name without one", async () => {
    const routes: Route[] = [...baseRoutes(), { method: "GET", path: `${ws}/tasks`, reply: { body: { rows: [], total: 0 } } }];
    const { call, calls, close } = await connect(routes);
    await call("list_tasks", { assignee: "me" });
    assert.equal(calls.find((c) => c.path === `${ws}/tasks`)?.query.assigneeMemberUuid, ME);
    const r = await call("list_tasks", { status: "Done" });
    assert.equal(r.isError, true);
    assert.match(textOf(r), /needs `project` too/);
    await close();
  });

  it("get_task accepts a handle and a uuid", async () => {
    const { call, calls, close } = await connect(baseRoutes());
    const r = await call("get_task", { task: "WEB-12" });
    assert.match(textOf(r), /WEB-12 · <workspace-data field="title">Fix login redirect<\/workspace-data>/);
    assert.equal(calls.at(-1)?.path, `${ws}/tasks/WEB-12`);
    await call("get_task", { task: T1 });
    assert.equal(calls.at(-1)?.path, `${ws}/tasks/${T1}`);
    const bad = await call("get_task", { task: "the login bug" });
    assert.equal(bad.isError, true);
    await close();
  });

  it("list_task_comments reads the thread from the task detail", async () => {
    const { call, close } = await connect(baseRoutes());
    const r = await call("list_task_comments", { task: "WEB-12" });
    assert.match(textOf(r), /Sara Khan.*\n?Seen on Safari/s);
    await close();
  });

  it("list_task_comments renders a GitHub system note, not a blank comment from someone", async () => {
    const withNote = {
      ...taskT1,
      commentList: [
        ...taskT1.commentList,
        {
          id: "k2",
          author: null,
          body: "",
          createdAt: "2026-09-21T10:00:00Z",
          system: { source: "github", event: "pr_merged", label: "PR #92 merged into main", url: "https://github.com/acme/web/pull/92" },
        },
      ],
    };
    const { call, close } = await connect([
      { method: "GET", path: new RegExp(`^/ws/${WS1}/tasks/(WEB-12|${T1})$`, "i"), reply: { body: withNote } },
      ...baseRoutes(),
    ]);
    const r = await call("list_task_comments", { task: "WEB-12" });
    const text = textOf(r);
    assert.match(text, /GitHub: PR #92 merged into main \(https:\/\/github\.com\/acme\/web\/pull\/92\)/);
    assert.doesNotMatch(text, /someone/);
    assert.match(text, /Sara Khan/);
    await close();
  });

  it("uses the workspace argument", async () => {
    const routes: Route[] = [
      { method: "GET", path: "/auth/me", reply: { body: (await import("./helpers.js")).me } },
      { method: "GET", path: `/ws/${WS2}/clients`, reply: { body: { rows: [{ id: CL1, name: "Globex" }], total: 1 } } },
    ];
    const { call, calls, close } = await connect(routes);
    const r = await call("list_clients", { workspace: "Sales" });
    assert.equal(r.isError, undefined);
    assert.equal(calls.at(-1)?.path, `/ws/${WS2}/clients`);
    await close();
  });

  it("list_time_entries walks each week in a range and totals it", async () => {
    const entry = (id: string, date: string, minutes: number) => ({ id, date, minutes, project: "Website Redesign", projectId: P1 });
    const routes: Route[] = [
      ...baseRoutes(),
      {
        method: "GET",
        path: `${ws}/timesheets/entries`,
        reply: (c) => ({
          body:
            c.query.week === "2026-09-14"
              ? { rows: [entry("e0", "2026-09-13", 999), entry("e1", "2026-09-17", 90)], total: 2 }
              : { rows: [entry("e2", "2026-09-21", 30)], total: 1 },
        }),
      },
    ];
    const { call, calls, close } = await connect(routes);
    const r = await call("list_time_entries", { from: "2026-09-16", to: "2026-09-22" });
    const weeks = calls.filter((c) => c.path.endsWith("/timesheets/entries")).map((c) => c.query.week);
    assert.deepEqual(weeks, ["2026-09-14", "2026-09-21"]);
    const s = r.structuredContent as { totalMinutes: number; total: number };
    assert.equal(s.totalMinutes, 120);
    assert.equal(s.total, 2);
    assert.match(textOf(r), /2h in 2 entries/);
    await close();
  });
});

describe("writes build exactly the request the API expects", () => {
  it("create_task: resolves project, column, people and converts hours to minutes", async () => {
    const routes: Route[] = [...baseRoutes(), { method: "POST", path: `${ws}/projects/${P1}/tasks`, reply: created() }];
    const { call, calls, close } = await connect(routes);
    const r = await call("create_task", {
      project: "Website Redesign",
      title: "  Fix login redirect ",
      description: "## Steps\n1. Sign in",
      type: "Bug",
      priority: "Urgent",
      status: "In Progress",
      startOn: "2026-09-23",
      dueOn: "2026-09-30",
      effortHours: 1.5,
      assignees: ["Sara Khan", "me", "ali.hassan@acme.test"],
      tags: ["auth", "safari"],
    });
    assert.equal(r.isError, undefined, textOf(r));
    const [post] = writes(calls);
    assert.equal(post.path, `${ws}/projects/${P1}/tasks`);
    assert.deepEqual(post.body, {
      title: "Fix login redirect",
      desc: "## Steps\n1. Sign in",
      type: "Bug",
      priority: "Urgent",
      columnUuid: C_PROG,
      startOn: "2026-09-23",
      dueOn: "2026-09-30",
      estimateMinutes: 90,
      assigneeUuids: [M_SARA, ME, M_ALI_H],
      tags: ["auth", "safari"],
    });
    assert.match(textOf(r), /^Created:/);
    await close();
  });

  it("create_task: minimal body, and a subtask names its parent", async () => {
    const routes: Route[] = [...baseRoutes(), { method: "POST", path: `${ws}/projects/${P1}/tasks`, reply: created() }];
    const { call, calls, close } = await connect(routes);
    await call("create_task", { project: "WEB", title: "Write tests", parent: "web-12" });
    assert.deepEqual(writes(calls)[0].body, { title: "Write tests", parentUuid: T1 });
    await close();
  });

  it("create_task: an ambiguous assignee or near-miss project writes nothing", async () => {
    const { call, calls, close } = await connect(baseRoutes());
    const a = await call("create_task", { project: "WEB", title: "x", assignees: ["Ali Raza"] });
    assert.equal(a.isError, true);
    assert.match(textOf(a), /matches more than one project member/);
    const b = await call("create_task", { project: "Website", title: "x" });
    assert.equal(b.isError, true);
    assert.match(textOf(b), /Did you mean: Website Redesign \[WEB\].*; Website Maintenance \[WM\]/);
    const c = await call("create_task", { project: "WEB", title: "x", status: "Doing" });
    assert.match(textOf(c), /No status column matches "Doing"\. Available: To Do; In Progress; Done/);
    assert.equal(writes(calls).length, 0);
    await close();
  });

  it("update_task: PATCHes only what changed, moves by column, clears a date, then PUTs assignees", async () => {
    const routes: Route[] = [
      ...baseRoutes(),
      { method: "PATCH", path: `${ws}/tasks/${T1}`, reply: { body: { ...taskT1, warning: { code: "wip_exceeded", message: "Done is over its limit" } } } },
      { method: "PUT", path: `${ws}/tasks/${T1}/assignees`, reply: { body: taskT1 } },
    ];
    const { call, calls, close } = await connect(routes);
    const r = await call("update_task", { task: "WEB-12", status: "done", dueOn: null, effortHours: 2, assignees: ["Sara Khan"] });
    assert.equal(r.isError, undefined, textOf(r));
    const [patch, put] = writes(calls);
    assert.equal(patch.method, "PATCH");
    assert.equal(patch.path, `${ws}/tasks/${T1}`, "writes use the canonical uuid, not the handle");
    assert.deepEqual(patch.body, { columnUuid: C_DONE, dueOn: "", estimateMinutes: 120 });
    assert.equal(put.method, "PUT");
    assert.deepEqual(put.body, { memberUuids: [M_SARA] });
    assert.match(textOf(r), /Warning: Done is over its limit/);
    await close();
  });

  it("update_task: refuses an empty change", async () => {
    const { call, calls, close } = await connect(baseRoutes());
    const r = await call("update_task", { task: "WEB-12" });
    assert.match(textOf(r), /Nothing to update/);
    assert.equal(writes(calls).length, 0);
    await close();
  });

  it("set_task_assignees: an empty list unassigns everyone", async () => {
    const routes: Route[] = [...baseRoutes(), { method: "PUT", path: `${ws}/tasks/${T1}/assignees`, reply: { body: taskT1 } }];
    const { call, calls, close } = await connect(routes);
    await call("set_task_assignees", { task: "WEB-12", assignees: [] });
    assert.deepEqual(writes(calls)[0].body, { memberUuids: [] });
    await close();
  });

  it("add_task_comment: posts markdown, optionally as a reply", async () => {
    const routes: Route[] = [
      ...baseRoutes(),
      { method: "POST", path: `${ws}/tasks/${T1}/comments`, reply: { status: 201, body: { id: "k9", author: { id: ME, name: "Wali" }, body: "x" } } },
    ];
    const { call, calls, close } = await connect(routes);
    await call("add_task_comment", { task: "WEB-12", body: "**Fixed** in #42" });
    await call("add_task_comment", { task: "WEB-12", body: "Thanks", replyTo: "k1" });
    const [a, b] = writes(calls);
    assert.deepEqual(a.body, { body: "**Fixed** in #42" });
    assert.deepEqual(b.body, { body: "Thanks", parentId: "k1" });
    await close();
  });

  it("log_time: against a task takes the task's project and never composes a task", async () => {
    const routes: Route[] = [
      ...baseRoutes(),
      {
        method: "POST",
        path: `${ws}/timesheets/entries`,
        reply: (c) => ({ status: 201, body: { id: "e1", ...(c.body as object), project: "Website Redesign" } }),
      },
    ];
    const { call, calls, close } = await connect(routes);
    const r = await call("log_time", { task: "WEB-12", date: "2026-09-22", hours: 1.25, note: "Debugged redirect", billable: false });
    assert.equal(r.isError, undefined, textOf(r));
    assert.deepEqual(writes(calls)[0].body, {
      date: "2026-09-22",
      projectUuid: P1,
      taskUuid: T1,
      minutes: 75,
      mode: "duration",
      notes: "Debugged redirect",
      billable: false,
    });
    await call("log_time", { project: "Website Redesign", date: "2026-09-22", minutes: 30 });
    assert.deepEqual(writes(calls)[1].body, { date: "2026-09-22", projectUuid: P1, minutes: 30, mode: "duration" });
    for (const w of writes(calls)) assert.ok(!("taskTitle" in (w.body as object)));
    await close();
  });

  it("log_time: needs exactly one duration and something to log against", async () => {
    const { call, calls, close } = await connect(baseRoutes());
    assert.match(textOf(await call("log_time", { task: "WEB-12", hours: 1, minutes: 60 })), /exactly one/);
    assert.match(textOf(await call("log_time", { task: "WEB-12" })), /exactly one/);
    assert.match(textOf(await call("log_time", { hours: 1 })), /pass `task` or `project`/);
    assert.match(textOf(await call("log_time", { task: "WEB-12", project: "Mobile App", hours: 1 })), /not Mobile App/);
    assert.equal(writes(calls).length, 0);
    await close();
  });

  it("create_invoice_draft: a draft only — send is false, no number, no re-billing", async () => {
    const routes: Route[] = [
      ...baseRoutes(),
      { method: "GET", path: `${ws}/clients`, reply: { body: { rows: [{ id: CL1, name: "Globex Corporation", short: "Globex" }], total: 1 } } },
      { method: "POST", path: `${ws}/invoices`, reply: { status: 201, body: { id: "i1", number: "INV-0042", status: "Draft", amount: "1200.00", currency: "USD" } } },
    ];
    const { call, calls, close } = await connect(routes);
    const r = await call("create_invoice_draft", {
      client: "Globex",
      projects: ["WEB"],
      source: "employee",
      from: "2026-09-01",
      to: "2026-09-30",
      notes: "September",
    });
    assert.equal(r.isError, undefined, textOf(r));
    const [post] = writes(calls);
    assert.equal(post.path, `${ws}/invoices`);
    assert.deepEqual(post.body, {
      clientUuid: CL1,
      source: "employee",
      projectUuids: [P1],
      from: "2026-09-01",
      to: "2026-09-30",
      notes: "September",
      send: false,
    });
    assert.match(textOf(r), /not sent/);
    await close();
  });

  it("create_invoice_draft: custom lines are sent as decimal strings", async () => {
    const routes: Route[] = [
      ...baseRoutes(),
      { method: "GET", path: `${ws}/clients/${CL1}`, reply: { body: { id: CL1, name: "Globex" } } },
      { method: "POST", path: `${ws}/invoices`, reply: { status: 201, body: { id: "i2", status: "Draft" } } },
    ];
    const { call, calls, close } = await connect(routes);
    await call("create_invoice_draft", { client: CL1, source: "custom", lines: [{ name: "Audit", detail: "Q3", hours: 10, rate: 85.5 }] });
    assert.deepEqual(writes(calls)[0].body, {
      clientUuid: CL1,
      source: "custom",
      lines: [{ name: "Audit", sub: "Q3", hours: "10.00", rate: "85.50" }],
      send: false,
    });
    const bad = await call("create_invoice_draft", { client: CL1, source: "custom" });
    assert.match(textOf(bad), /needs `lines`/);
    await close();
  });

  it("preview_invoice: posts to /invoices/preview without `send`", async () => {
    const routes: Route[] = [
      ...baseRoutes(),
      { method: "GET", path: `${ws}/clients/${CL1}`, reply: { body: { id: CL1, name: "Globex" } } },
      {
        method: "POST",
        path: `${ws}/invoices/preview`,
        reply: { body: { items: [{ name: "Website Redesign", hours: "10.00", rate: "50.00", amount: "500.00" }], total: "500.00", currency: "USD", pulledEntries: 4, excluded: { pending: [{}, {}], rejected: null, billed: [{}] }, issues: [] } },
      },
    ];
    const { call, calls, close } = await connect(routes);
    const r = await call("preview_invoice", { client: CL1, projects: [P1] });
    assert.deepEqual(writes(calls)[0].body, { clientUuid: CL1, source: "team", projectUuids: [P1] });
    assert.match(textOf(r), /nothing saved/);
    assert.match(textOf(r), /Left out: 2 pending/);
    await close();
  });
});

describe("errors and limits", () => {
  it("a read-only token's 403 is explained, and the token is never echoed", async () => {
    const routes: Route[] = [
      ...baseRoutes(),
      {
        method: "POST",
        path: `${ws}/projects/${P1}/tasks`,
        reply: { status: 403, body: { error: { code: "token_read_only", message: "This token is read-only." } } },
      },
    ];
    const { call, close } = await connect(routes);
    const r = await call("create_task", { project: "WEB", title: "x" });
    assert.equal(r.isError, true);
    const text = textOf(r);
    assert.match(text, /This token is read-only\. \[token_read_only\]/);
    assert.match(text, /needs a token created with write access/);
    assert.ok(!text.includes(TOKEN));
    await close();
  });

  it("an invalid token's 401 surfaces on the first call", async () => {
    const { call, close } = await connect([
      { method: "GET", path: "/auth/me", reply: { status: 401, body: { error: { code: "invalid_token", message: "Invalid or expired token." } } } },
    ]);
    const r = await call("list_projects");
    assert.equal(r.isError, true);
    assert.match(textOf(r), /did not accept the API token: Invalid or expired token\. \[invalid_token\]/);
    await close();
  });

  it("list results are paged at 25 by default and capped at 100", async () => {
    const routes: Route[] = [...baseRoutes()];
    const { call, calls, close } = await connect(routes);
    await call("list_projects");
    assert.equal(calls.at(-1)?.query.size, "25");
    const r = await call("list_projects", { size: 500 });
    assert.equal(r.isError, true);
    await close();
  });
});
