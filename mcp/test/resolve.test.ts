import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { choose, resolveMembers, ResolveError } from "../src/resolve.js";
import { Session } from "../src/session.js";
import { BASE, fakeApi, M_ALI_H, M_SARA, me, ME, projectP1, TOKEN, WS1, WS2 } from "./helpers.js";

const cands = [
  { item: 1, label: "Website Redesign [WEB]", keys: ["Website Redesign", "WEB"] },
  { item: 2, label: "Website Maintenance [WM]", keys: ["Website Maintenance", "WM"] },
  { item: 3, label: "Mobile App [MOB]", keys: ["Mobile App", "MOB"] },
];

describe("choose", () => {
  it("takes an exact match on any key, ignoring case and spacing", () => {
    assert.equal(choose("project", "website  redesign", cands), 1);
    assert.equal(choose("project", "mob", cands), 3);
  });

  it("refuses a near miss and names the candidates", () => {
    assert.throws(
      () => choose("project", "Website", cands),
      (e: unknown) =>
        e instanceof ResolveError &&
        /No project is named exactly "Website"\. Did you mean: Website Redesign \[WEB\]; Website Maintenance \[WM\]/.test(e.message),
    );
  });

  it("refuses two exact matches", () => {
    const dup = [...cands, { item: 4, label: "Mobile App (archived)", keys: ["Mobile App"] }];
    assert.throws(() => choose("project", "Mobile App", dup), /matches more than one project: Mobile App \[MOB\]; Mobile App \(archived\)/);
  });

  it("lists what exists when nothing is close", () => {
    assert.throws(() => choose("project", "Payroll", cands), /No project matches "Payroll"\. Available: Website Redesign/);
    assert.throws(() => choose("project", "Payroll", []), /there are none available/);
  });
});

describe("resolveMembers", () => {
  const roster = projectP1.memberList;

  it("resolves by name, email, uuid and 'me', without duplicates", () => {
    const got = resolveMembers(roster, ["Sara Khan", "ali.hassan@acme.test", M_SARA, "me"], ME).map((m) => m.id);
    assert.deepEqual(got, [M_SARA, M_ALI_H, ME]);
  });

  it("refuses an ambiguous name and shows the emails that tell them apart", () => {
    assert.throws(
      () => resolveMembers(roster, ["Ali Raza"], ME),
      /matches more than one project member: Ali Raza <ali\.raza@acme\.test>; Ali Raza <ali\.hassan@acme\.test>/,
    );
  });

  it("refuses someone off the roster", () => {
    assert.throws(() => resolveMembers(roster, ["Sara"], ME), /Did you mean: Sara Khan/);
    assert.throws(() => resolveMembers(roster, ["cccccccc-cccc-4ccc-8ccc-cccccccccccc"], ME), /not on this project's roster/);
    assert.throws(() => resolveMembers(roster.slice(0, 1), ["me"], ME), /not on this project's roster/);
  });
});

describe("workspace resolution", () => {
  const session = (defaultWorkspace?: string) => {
    const api = fakeApi([{ method: "GET", path: "/auth/me", reply: { body: me } }]);
    return { api, s: new Session({ baseUrl: BASE, token: TOKEN, defaultWorkspace }, api.fetch) };
  };

  it("defaults to the first workspace", async () => {
    assert.equal((await session().s.workspace()).id, WS1);
  });

  it("uses OPSTRACKING_WORKSPACE by name, and a tool argument over it", async () => {
    const { s } = session("sales");
    assert.equal((await s.workspace()).id, WS2);
    assert.equal((await s.workspace("Delivery")).id, WS1);
    assert.equal((await s.workspace(WS1)).id, WS1);
  });

  it("refuses an unknown workspace and lists the real ones", async () => {
    const { s } = session();
    await assert.rejects(s.workspace("Finance"), /No workspace matches "Finance"\. Available: Delivery .*; Sales/);
    await assert.rejects(s.workspace("33333333-3333-4333-8333-333333333333"), /No workspace with id/);
  });

  it("caches /auth/me between calls", async () => {
    const { s, api } = session();
    await s.workspace();
    await s.workspace("Sales");
    assert.equal(await s.myMemberId(), ME);
    assert.equal(api.calls.length, 1);
  });
});
