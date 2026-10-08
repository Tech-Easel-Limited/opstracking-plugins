import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { ApiError, OpsTrackingClient, type FetchLike } from "../src/client.js";
import { BASE, fakeApi, TOKEN } from "./helpers.js";

const err = (status: number, code: string, message: string, headers?: Record<string, string>) => ({
  status,
  body: { error: { code, message } },
  headers,
});

async function failureOf(p: Promise<unknown>): Promise<ApiError> {
  try {
    await p;
  } catch (e) {
    assert.ok(e instanceof ApiError, `expected ApiError, got ${String(e)}`);
    return e;
  }
  assert.fail("expected the request to fail");
}

describe("OpsTrackingClient", () => {
  it("sends the bearer token, JSON headers and the /api prefix", async () => {
    const api = fakeApi([{ method: "POST", path: "/ws/x/things", reply: { status: 201, body: { ok: true } } }]);
    const c = new OpsTrackingClient({ baseUrl: BASE, token: TOKEN }, api.fetch);
    assert.deepEqual(await c.post("/ws/x/things", { a: 1 }), { ok: true });
    const [call] = api.calls;
    assert.equal(call.headers.authorization, `Bearer ${TOKEN}`);
    assert.equal(call.headers["content-type"], "application/json");
    assert.equal(call.headers.accept, "application/json");
    assert.deepEqual(call.body, { a: 1 });
  });

  it("sends no Content-Type on a GET and drops empty query values", async () => {
    const api = fakeApi([{ method: "GET", path: "/ws/x/things", reply: { body: [] } }]);
    const c = new OpsTrackingClient({ baseUrl: BASE, token: TOKEN }, api.fetch);
    await c.get("/ws/x/things", { q: "", page: 2, flag: undefined, other: null });
    assert.equal(api.calls[0].headers["content-type"], undefined);
    assert.deepEqual(api.calls[0].query, { page: "2" });
  });

  it("maps each refusal to a clear message carrying the server's own words", async () => {
    const cases: Array<[number, string, string, RegExp]> = [
      [401, "invalid_token", "The token is not valid.", /did not accept the API token: The token is not valid\. \[invalid_token\].*API tokens/],
      [403, "token_read_only", "This token can only read.", /This token can only read\..*read-only.*write access/],
      [403, "token_forbidden", "Tokens cannot do that.", /Tokens cannot do that\..*in the OpsTracking app/],
      [403, "forbidden", "You do not have permission to do that", /Permission denied: You do not have permission/],
      [403, "module_disabled", "This module is disabled", /module is turned off/],
      [404, "not_found", "Not found", /Not found: Not found/],
      [409, "conflict", "Already exists.", /Conflict: Already exists\./],
      [422, "invalid", "Bad thing.", /could not process the request: Bad thing\./],
      [400, "invalid_date", "Enter a valid date.", /rejected the request: Enter a valid date\./],
    ];
    for (const [status, code, message, expected] of cases) {
      const api = fakeApi([{ method: "GET", path: "/x", reply: err(status, code, message) }]);
      const e = await failureOf(new OpsTrackingClient({ baseUrl: BASE, token: TOKEN }, api.fetch).get("/x"));
      assert.equal(e.status, status);
      assert.equal(e.code, code);
      assert.equal(e.serverMessage, message);
      assert.match(e.message, expected);
    }
  });

  it("surfaces the scope, write-budget and approval-request refusals verbatim, with what to do next", async () => {
    const scopeMsg = "This token can't do that. Create a token with the “Assets” permission in Settings → API tokens.";
    const cases: Array<[number, string, string, RegExp[]]> = [
      [403, "token_scope", scopeMsg, [/Assets” permission in Settings → API tokens\. \[token_scope\]/, /reconnect: true/, /ticks it/, /Never ask the user for a token/]],
      [
        429,
        "token_write_budget",
        "This token has made too many changes for now. Try again later.",
        [/too many changes for now\. Try again later\. \[token_write_budget\]/, /do not retry in a loop/],
      ],
      [404, "agent_request_not_found", "That request doesn't exist or isn't yours.", [/isn't yours\. \[agent_request_not_found\]/, /list_agent_requests/]],
      [409, "agent_request_closed", "This request was already decided or has expired.", [/has expired\. \[agent_request_closed\]/, /File a new request/]],
      [400, "agent_request_kind", "That kind of request isn't supported.", [/isn't supported\. \[agent_request_kind\]/]],
    ];
    for (const [status, code, message, expected] of cases) {
      const api = fakeApi([{ method: "POST", path: "/x", reply: err(status, code, message) }]);
      const e = await failureOf(new OpsTrackingClient({ baseUrl: BASE, token: TOKEN }, api.fetch).post("/x", {}));
      assert.equal(e.code, code);
      assert.equal(e.serverMessage, message);
      assert.ok(e.message.includes(message), `${code}: the server's words, verbatim`);
      for (const re of expected) assert.match(e.message, re, code);
    }
    const api = fakeApi([{ method: "POST", path: "/x", reply: err(429, "token_write_budget", "Too many.", { "retry-after": "40" }) }]);
    const e = await failureOf(new OpsTrackingClient({ baseUrl: BASE, token: TOKEN }, api.fetch).post("/x", {}));
    assert.match(e.message, /Try again in 40 seconds/);
  });

  it("reports Retry-After on 429", async () => {
    const api = fakeApi([{ method: "GET", path: "/x", reply: err(429, "rate_limited", "Slow down.", { "retry-after": "12" }) }]);
    const e = await failureOf(new OpsTrackingClient({ baseUrl: BASE, token: TOKEN }, api.fetch).get("/x"));
    assert.match(e.message, /Rate limited.*Slow down\..*12 seconds/);
  });

  it("retries a GET once on 502/503/504, and never retries a write", async () => {
    let n = 0;
    const flaky = fakeApi([
      { method: "GET", path: "/x", reply: () => (++n === 1 ? { status: 503, raw: "<html>down</html>" } : { body: { ok: 1 } }) },
      { method: "POST", path: "/x", reply: { status: 503, raw: "<html>down</html>" } },
    ]);
    const c = new OpsTrackingClient({ baseUrl: BASE, token: TOKEN }, flaky.fetch);
    assert.deepEqual(await c.get("/x"), { ok: 1 });
    assert.equal(flaky.calls.length, 2);
    const e = await failureOf(c.post("/x", {}));
    assert.equal(e.status, 503);
    assert.equal(flaky.calls.filter((k) => k.method === "POST").length, 1);

    const down = fakeApi([{ method: "GET", path: "/y", reply: { status: 504 } }]);
    await failureOf(new OpsTrackingClient({ baseUrl: BASE, token: TOKEN }, down.fetch).get("/y"));
    assert.equal(down.calls.length, 2, "one retry, not more");
  });

  it("times out", async () => {
    const hang: FetchLike = (_url, init) =>
      new Promise((_resolve, reject) => {
        init.signal?.addEventListener("abort", () => reject(init.signal?.reason));
      });
    const e = await failureOf(new OpsTrackingClient({ baseUrl: BASE, token: TOKEN }, hang, 50).get("/slow"));
    assert.equal(e.code, "timeout");
    assert.match(e.message, /did not answer GET \/slow/);
  });

  it("never lets the token into an error, even when the server echoes it", async () => {
    const api = fakeApi([{ method: "GET", path: "/x", reply: err(401, "invalid_token", `Token ${TOKEN} was revoked`) }]);
    const e = await failureOf(new OpsTrackingClient({ baseUrl: BASE, token: TOKEN }, api.fetch).get("/x"));
    assert.ok(!e.message.includes(TOKEN));
    assert.ok(!e.serverMessage.includes(TOKEN));

    const broken: FetchLike = async () => {
      throw new TypeError("fetch failed", { cause: { code: `ECONNREFUSED Bearer ${TOKEN}` } });
    };
    const net = await failureOf(new OpsTrackingClient({ baseUrl: BASE, token: TOKEN }, broken).get("/x"));
    assert.equal(net.code, "network");
    assert.ok(!net.message.includes(TOKEN));
  });

  it("explains a non-JSON success (wrong host)", async () => {
    const api = fakeApi([{ method: "GET", path: "/x", reply: { raw: "<!doctype html>" } }]);
    const e = await failureOf(new OpsTrackingClient({ baseUrl: BASE, token: TOKEN }, api.fetch).get("/x"));
    assert.equal(e.code, "invalid_response");
  });
});
