import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { TIER_A_SCOPES, TIER_B_SCOPES } from "../src/access.js";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import {
  BASE,
  baseRoutes,
  CL1,
  connect,
  M_SARA,
  me,
  ME,
  P1,
  projectP1,
  textOf,
  writes,
  WS1,
  type Call,
  type Route,
} from "./helpers.js";

/**
 * The approval-request tools (§4 Stage 2, §8.6): each files the target route's
 * own body with its route parameters, and none ever reports the act as done.
 */

const ws = `/ws/${WS1}`;
const REQ = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const R_EMP = "e2222222-2222-4222-8222-222222222222";
const R_ADMIN = "e3333333-3333-4333-8333-333333333333";
const R_CLIENT = "e4444444-4444-4444-8444-444444444444";
const K_JANE = "f4444444-4444-4444-8444-444444444444";
const K_BOB = "f5555555-5555-4555-8555-555555555555";
const M_JANE = "b9999999-9999-4999-8999-999999999999";
const INV1 = "f6666666-6666-4666-8666-666666666666";
const APPROVAL_URL = `${BASE}/approvals/agent/${REQ}?ws=${WS1}`;

const approver = { ...me, token: { id: "t1", name: "Claude on test", scopes: [...TIER_A_SCOPES, ...TIER_B_SCOPES], expiresAt: null } };

/** A fake agent-request endpoint: echoes the filing back as a pending request, the way §8.3 describes. */
function filing(needsPassword = false): Route {
  return {
    method: "POST",
    path: `${ws}/agent-requests`,
    reply: (c: Call) => ({
      status: 202,
      body: {
        request: {
          id: REQ,
          kind: (c.body as { kind: string }).kind,
          status: "pending",
          summary: "Invite Ann Lee to Delivery as Employee",
          display: [
            { label: "Recipient", value: "ann@acme.test" },
            { label: "Role", value: "Employee" },
          ],
          approvalUrl: APPROVAL_URL,
          createdAt: "2026-09-26T10:00:00Z",
          expiresAt: "2026-09-27T10:00:00Z",
          decidedAt: null,
          result: null,
          needsPassword,
          tokenName: "Claude on test",
        },
      },
    }),
  };
}

function routes(extra: Route[] = []): Route[] {
  return [
    { method: "GET", path: "/auth/me", reply: { body: approver } },
    {
      method: "GET",
      path: `${ws}/projects/${P1}`,
      reply: {
        body: {
          ...projectP1,
          memberList: [...projectP1.memberList, { id: M_JANE, name: "Jane Doe", email: "jane@globex.test", isClient: true }],
        },
      },
    },
    ...extra,
    ...baseRoutes(),
    filing(),
    {
      method: "GET",
      path: `${ws}/roles`,
      reply: {
        body: {
          groups: [
            {
              title: "System roles",
              roles: [
                { id: R_ADMIN, key: "r_wsadmin", name: "Workspace Admin" },
                { id: R_EMP, key: "r_employee", name: "Employee" },
                { id: R_CLIENT, key: "r_client", name: "Client", external: true },
              ],
            },
          ],
        },
      },
    },
    {
      method: "GET",
      path: `${ws}/employees`,
      reply: { body: { rows: [{ id: M_SARA, name: "Sara Khan", email: "sara@acme.test" }, { id: ME, name: "Wali Ahmed" }], total: 2 } },
    },
    { method: "GET", path: `${ws}/clients`, reply: { body: { rows: [{ id: CL1, name: "Globex" }], total: 1 } } },
    {
      method: "GET",
      path: `${ws}/clients/${CL1}`,
      reply: {
        body: {
          id: CL1,
          name: "Globex",
          contactList: [
            { id: K_JANE, name: "Jane Doe", email: "jane@globex.test", orgMemberId: M_JANE },
            { id: K_BOB, name: "Bob Stone", email: "bob@globex.test" },
          ],
        },
      },
    },
    { method: "GET", path: `${ws}/invoices`, reply: { body: { rows: [{ id: INV1, number: "INV-0042", client: { id: CL1, name: "Globex" } }], total: 1 } } },
  ];
}

/** What every filed request's answer must and must not say. */
function assertWaiting(r: CallToolResult): void {
  assert.equal(r.isError, undefined, textOf(r));
  const t = textOf(r);
  assert.match(t, /^Filed for approval — nothing has changed yet\./);
  assert.ok(t.includes(APPROVAL_URL), "gives the approval link");
  assert.match(t, /Never say it is done/);
  // Nothing the user reads says the act happened.
  const forUser = t.split("(For the assistant")[0];
  assert.doesNotMatch(forUser, /\b(has been|was|were) (sent|invited|added|removed|assigned|submitted|paid|granted|changed)\b/i);
  assert.doesNotMatch(forUser, /\b(done|completed|successful(ly)?)\b/i);
  assert.equal((r.structuredContent as { waitingForApproval: boolean }).waitingForApproval, true);
}

const filed = (calls: Call[]) => writes(calls).filter((c) => c.path === `${ws}/agent-requests`).map((c) => c.body);

describe("approval requests are filed, never done", () => {
  it("request_workspace_invite resolves the role and files the invite route's body", async () => {
    const { call, calls, close } = await connect(routes());
    const r = await call("request_workspace_invite", { email: "ann@acme.test", firstName: "Ann", lastName: "Lee", role: "employee" });
    assertWaiting(r);
    assert.deepEqual(filed(calls), [
      { kind: "workspace_invite", params: {}, payload: { email: "ann@acme.test", firstName: "Ann", lastName: "Lee", wsRoleId: R_EMP } },
    ]);
    // What OpsTracking computed is marked as workspace data; the labels are its own.
    assert.match(textOf(r), /- Recipient: <workspace-data field="Recipient">ann@acme\.test<\/workspace-data>/);
    assert.match(textOf(r), /Filed by: Claude on test/);
    // Only the requests route was written to.
    assert.equal(writes(calls).length, 1);
    await close();
  });

  it("request_client_invite needs a contact who already has portal access", async () => {
    const { call, calls, close } = await connect(routes());
    assertWaiting(await call("request_client_invite", { project: "WEB", person: "jane@globex.test" }));
    const bob = await call("request_client_invite", { project: "WEB", person: "Bob Stone" });
    assert.match(textOf(bob), /no portal access yet\. File request_portal_access/);
    assert.deepEqual(filed(calls), [{ kind: "client_invite", params: { uuid: P1 }, payload: { clientMemberUuid: M_JANE } }]);
    await close();
  });

  it("request_portal_access names the client, the contact, a client-team role and the projects", async () => {
    const { call, calls, close } = await connect(routes());
    assertWaiting(await call("request_portal_access", { client: "Globex", contact: "Bob Stone", role: "Client", projects: ["WEB", P1] }));
    const staffRole = await call("request_portal_access", { client: "Globex", contact: "Bob Stone", role: "Employee", projects: ["WEB"] });
    assert.match(textOf(staffRole), /No client-team role/);
    assert.deepEqual(filed(calls), [
      { kind: "portal_access", params: { uuid: CL1, contactUuid: K_BOB }, payload: { wsRoleId: R_CLIENT, projectIds: [P1] } },
    ]);
    await close();
  });

  it("request_project_member_change files add, update and remove as their own kinds", async () => {
    const { call, calls, close } = await connect(routes());
    assertWaiting(await call("request_project_member_change", { project: "WEB", action: "add", people: ["Sara Khan", "me"], billable: true }));
    assertWaiting(
      await call("request_project_member_change", { project: "WEB", action: "update", person: "sara@acme.test", weeklyHours: 20, rate: 45 }),
    );
    assertWaiting(await call("request_project_member_change", { project: "WEB", action: "remove", person: "Sara Khan" }));
    const empty = await call("request_project_member_change", { project: "WEB", action: "update", person: "Sara Khan" });
    assert.match(textOf(empty), /needs at least one field/);
    assert.deepEqual(filed(calls), [
      { kind: "project_member_add", params: { uuid: P1 }, payload: { memberUuids: [M_SARA, ME], billable: true } },
      { kind: "project_member_update", params: { uuid: P1, memberUuid: M_SARA }, payload: { requiredHours: "20", rateOverride: "45.00" } },
      { kind: "project_member_remove", params: { uuid: P1, memberUuid: M_SARA }, payload: {} },
    ]);
    await close();
  });

  it("request_client_access sets switches for a client-side member, or revokes their access", async () => {
    const { call, calls, close } = await connect(routes());
    assertWaiting(await call("request_client_access", { project: "WEB", person: "Jane Doe", action: "set", invoicesVisible: true, ratesVisible: false }));
    assertWaiting(await call("request_client_access", { project: "WEB", person: "Jane Doe", action: "revoke" }));
    const staff = await call("request_client_access", { project: "WEB", person: "Sara Khan", action: "revoke" });
    assert.equal(staff.isError, true, "only client-side members");
    assert.deepEqual(filed(calls), [
      { kind: "client_access_set", params: { uuid: P1 }, payload: { clientMemberId: M_JANE, invoicesVisible: true, ratesVisible: false } },
      { kind: "client_access_revoke", params: { uuid: P1, clientMemberId: M_JANE }, payload: {} },
    ]);
    await close();
  });

  it("request_role_assignment, request_invoice_send, request_invoice_paid and request_timesheet_submit", async () => {
    const { call, calls, close } = await connect(routes([{ method: "POST", path: `${ws}/agent-requests`, reply: filing(true).reply }]));
    const role = await call("request_role_assignment", { person: "Sara Khan", role: "Workspace Admin" });
    assertWaiting(role);
    assert.match(textOf(role), /Approving it asks for the user's password\./);
    assertWaiting(await call("request_invoice_send", { invoice: "INV-0042" }));
    assertWaiting(await call("request_invoice_paid", { invoice: INV1 }));
    assertWaiting(await call("request_timesheet_submit", { week: "2026-09-24", projects: ["WEB"] }));
    assert.deepEqual(filed(calls), [
      { kind: "member_role_assign", params: { memberUuid: M_SARA }, payload: { wsRoleId: R_ADMIN } },
      { kind: "invoice_send", params: { uuid: INV1 }, payload: {} },
      { kind: "invoice_pay", params: { uuid: INV1 }, payload: {} },
      { kind: "timesheet_submit", params: {}, payload: { week: "2026-09-21", projectUuids: [P1] } },
    ]);
    await close();
  });

  it("every request tool's description says it does not do the act", async () => {
    const { client, close } = await connect(routes());
    const tools = (await client.listTools()).tools.filter((t) => t.name.startsWith("request_"));
    assert.equal(tools.length, 9);
    for (const t of tools) {
      assert.match(t.description ?? "", /APPROVAL REQUEST: this does NOT do the act/, t.name);
      assert.match(t.description ?? "", /explicit confirmation/, t.name);
      assert.equal(t.annotations?.readOnlyHint, false, t.name);
      assert.equal(t.annotations?.destructiveHint, false, t.name);
    }
    await close();
  });
});

describe("following a request", () => {
  const stored = (status: string, extra: Record<string, unknown> = {}) => ({
    id: REQ,
    kind: "invoice_send",
    status,
    summary: "Send INV-0042 to Globex",
    display: [{ label: "Invoice", value: "INV-0042" }],
    approvalUrl: APPROVAL_URL,
    tokenName: "Claude on test",
    ...extra,
  });

  it("get_agent_request says approved only when OpsTracking carried it out", async () => {
    let current = stored("pending");
    const { call, close } = await connect(
      routes([{ method: "GET", path: `${ws}/agent-requests/${REQ}`, reply: () => ({ body: { request: current } }) }]),
    );
    assert.match(textOf(await call("get_agent_request", { id: REQ })), /^Waiting for the user's approval — nothing has changed yet\./);
    current = stored("approved", { result: { status: 200 } });
    assert.match(textOf(await call("get_agent_request", { id: REQ })), /^Approved by the user and carried out by OpsTracking\./);
    current = stored("declined");
    assert.match(textOf(await call("get_agent_request", { id: REQ })), /^Declined by the user — nothing was changed\./);
    current = stored("failed", { result: { status: 409, code: "not_draft", message: "Only a draft can be sent." } });
    const failed = textOf(await call("get_agent_request", { id: REQ }));
    assert.match(failed, /refused to carry it out: <workspace-data field="error">Only a draft can be sent\.<\/workspace-data> \[not_draft\]/);
    assert.match(failed, /Nothing was changed/);
    const bad = await call("get_agent_request", { id: "../../x" });
    assert.match(textOf(bad), /is not a request id/);
    await close();
  });

  it("list_agent_requests passes the status filter and links the pending ones", async () => {
    const { call, calls, close } = await connect(
      routes([{ method: "GET", path: `${ws}/agent-requests`, reply: { body: { items: [stored("pending"), stored("expired")] } } }]),
    );
    const t = textOf(await call("list_agent_requests", { status: "pending" }));
    assert.equal(calls.at(-1)?.query.status, "pending");
    assert.match(t, /- <workspace-data field="summary">Send INV-0042 to Globex<\/workspace-data> — pending \(id .*\) http/);
    assert.match(t, /— expired \(id [^)]+\)$/m);
    await close();
  });

  it("surfaces the approval errors verbatim", async () => {
    const { call, close } = await connect(
      routes([
        {
          method: "GET",
          path: `${ws}/agent-requests/${REQ}`,
          reply: { status: 404, body: { error: { code: "agent_request_not_found", message: "That request doesn't exist or isn't yours." } } },
        },
        {
          method: "POST",
          path: `${ws}/agent-requests`,
          reply: { status: 403, body: { error: { code: "token_scope", message: "This token can't do that. Create a token with the “Send invoices and mark them paid (you approve each one)” permission in Settings → API tokens." } } },
        },
      ]),
    );
    const nf = await call("get_agent_request", { id: REQ });
    assert.equal(nf.isError, true);
    assert.match(textOf(nf), /That request doesn't exist or isn't yours\. \[agent_request_not_found\]/);
    const scope = await call("request_invoice_send", { invoice: "INV-0042" });
    assert.equal(scope.isError, true);
    assert.match(textOf(scope), /“Send invoices and mark them paid \(you approve each one\)” permission in Settings → API tokens\. \[token_scope\]/);
    await close();
  });
});
