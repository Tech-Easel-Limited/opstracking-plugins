import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { request } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "node:test";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import type { FetchLike } from "../src/client.js";
import { clientLabel, MAX_FAILED_POSTS, openCommand, PendingConnect } from "../src/connect.js";
import { createServer } from "../src/server.js";
import { baseRoutes, fakeApi, me, textOf, TOKEN } from "./helpers.js";

const OTHER_TOKEN = `otk_${"f".repeat(32)}_${"Z".repeat(43)}`;
const ADDRESS = "https://amento-tech.neoeasel.com";

function tempConfig(initial?: Record<string, string>): string {
  const path = join(mkdtempSync(join(tmpdir(), "otk-connect-")), "config.json");
  if (initial) writeFileSync(path, JSON.stringify(initial));
  return path;
}

/** What the browser does after approval: POST the fragment's values to the callback. */
async function approve(authorizeUrl: string, body: Record<string, string>, headers: Record<string, string> = {}) {
  const callback = new URL(authorizeUrl).searchParams.get("callback")!;
  const res = await fetch(callback, {
    method: "POST",
    headers: { "Content-Type": "application/json", ...headers },
    body: JSON.stringify(body),
  });
  return { status: res.status, body: (await res.json()) as { ok: boolean; message: string; cancelled?: boolean } };
}

function stateOf(authorizeUrl: string): string {
  return new URL(authorizeUrl).searchParams.get("state")!;
}

/** A raw request, for the headers `fetch` will not let a test set (Host). */
function rawGet(port: number, host: string): Promise<number> {
  return new Promise((resolve, reject) => {
    const req = request({ host: "127.0.0.1", port, path: "/callback", method: "GET", headers: { Host: host } }, (res) => {
      res.resume();
      resolve(res.statusCode ?? 0);
    });
    req.on("error", reject);
    req.end();
  });
}

/** A fake OpsTracking that knows exactly one token, on the given origins. */
function apiFor(token: string, origins: string[] = [ADDRESS]) {
  const seen: string[] = [];
  const fetchImpl: FetchLike = async (input, init) => {
    seen.push(input);
    const url = new URL(input);
    const auth = new Headers(init.headers).get("authorization");
    if (!origins.includes(url.origin) || auth !== `Bearer ${token}`) {
      return new Response(JSON.stringify({ error: { code: "invalid_token", message: "Invalid or expired token." } }), {
        status: 401,
      });
    }
    return new Response(JSON.stringify(me), { status: 200 });
  };
  return { fetch: fetchImpl, seen };
}

async function start(opts: Partial<Parameters<typeof PendingConnect.start>[0]> & { configPath: string }) {
  let saved: { url: string; token: string } | undefined;
  const pending = await PendingConnect.start({
    address: ADDRESS,
    fetch: apiFor(TOKEN).fetch,
    client: "wali-mbp",
    app: "Claude",
    onConnected: (s) => (saved = s),
    ...opts,
  });
  return { pending, saved: () => saved };
}

describe("opening the browser", () => {
  const url = "https://amento-tech.neoeasel.com/connect/ai?callback=x&state=y&client=z&app=Cursor";

  it("uses each platform's opener with the URL as one argument, never through a shell", () => {
    assert.deepEqual(openCommand("darwin", url), { command: "open", args: [url] });
    assert.deepEqual(openCommand("linux", url), { command: "xdg-open", args: [url] });
    assert.deepEqual(openCommand("freebsd", url), { command: "xdg-open", args: [url] });
    // Not `cmd /c start`: cmd would split the URL at every `&`.
    assert.deepEqual(openCommand("win32", url), { command: "rundll32", args: ["url.dll,FileProtocolHandler", url] });
  });

  it("refuses anything but an http(s) address", () => {
    assert.throws(() => openCommand("darwin", "file:///etc/passwd"));
    assert.throws(() => openCommand("win32", "calc.exe"));
  });

  it("labels the machine harmlessly", () => {
    assert.equal(clientLabel("Walis-MacBook-Pro.local"), "Walis-MacBook-Pro");
    assert.equal(clientLabel("<script>x</script>"), "scriptxscript");
    assert.equal(clientLabel(""), "this computer");
    assert.ok(clientLabel("a".repeat(100)).length <= 40);
  });
});

describe("the loopback listener", () => {
  it("builds the authorize URL on the given address with a loopback callback and a 32-byte state", async () => {
    const { pending } = await start({ configPath: tempConfig() });
    const u = new URL(pending.authorizeUrl);
    assert.equal(u.origin, ADDRESS);
    // The neutral path; /connect/claude still serves the page for older plugins.
    assert.equal(u.pathname, "/connect/ai");
    assert.equal(u.searchParams.get("callback"), `http://127.0.0.1:${pending.port}/callback`);
    assert.match(u.searchParams.get("state")!, /^[A-Za-z0-9_-]{43}$/);
    assert.equal(u.searchParams.get("client"), "wali-mbp");
    assert.equal(u.searchParams.get("app"), "Claude");
    pending.close();
  });

  it("serves a self-contained page with a strict CSP and no token in it", async () => {
    const { pending } = await start({ configPath: tempConfig() });
    const res = await fetch(`http://127.0.0.1:${pending.port}/callback`);
    assert.equal(res.status, 200);
    const csp = res.headers.get("content-security-policy") ?? "";
    assert.match(csp, /default-src 'none'/);
    assert.match(csp, /connect-src 'self'/);
    assert.match(csp, /script-src 'nonce-/);
    assert.equal(res.headers.get("referrer-policy"), "no-referrer");
    assert.equal(res.headers.get("cache-control"), "no-store");
    const html = await res.text();
    assert.match(html, /history\.replaceState/);
    assert.doesNotMatch(html, /https?:\/\/(?!127\.0\.0\.1)/, "no external resource");
    pending.close();
  });

  it("answers only its own Host (DNS rebinding) and only its own Origin", async () => {
    const { pending } = await start({ configPath: tempConfig() });
    assert.equal(await rawGet(pending.port, `127.0.0.1:${pending.port}`), 200);
    assert.equal(await rawGet(pending.port, `evil.example:${pending.port}`), 421);
    assert.equal(await rawGet(pending.port, `localhost:${pending.port}`), 421);
    const r = await approve(pending.authorizeUrl, { state: pending.state, token: TOKEN }, { Origin: "https://evil.example" });
    assert.equal(r.status, 403);
    pending.close();
  });

  it("refuses a mismatched state and saves nothing", async () => {
    const configPath = tempConfig();
    const { pending, saved } = await start({ configPath });
    const r = await approve(pending.authorizeUrl, { state: "x".repeat(43), token: TOKEN, url: ADDRESS });
    assert.equal(r.status, 400);
    assert.equal(r.body.ok, false);
    assert.match(r.body.message, /doesn't match/);
    assert.equal(saved(), undefined);
    assert.throws(() => readFileSync(configPath), /ENOENT/);
    assert.equal(pending.open, true);
    pending.close();
  });

  it("refuses a token of the wrong shape without sending it anywhere", async () => {
    const api = apiFor(TOKEN);
    const { pending, saved } = await start({ configPath: tempConfig(), fetch: api.fetch });
    const r = await approve(pending.authorizeUrl, { state: pending.state, token: "otk_short", url: ADDRESS });
    assert.equal(r.status, 400);
    assert.match(r.body.message, /does not look like an OpsTracking API token/);
    assert.doesNotMatch(r.body.message, /otk_short/);
    assert.deepEqual(api.seen, []);
    assert.equal(saved(), undefined);
    pending.close();
  });

  it("refuses a non-https, non-local suggested address and never sends the token there", async () => {
    const api = apiFor(TOKEN, []);
    const { pending, saved } = await start({ configPath: tempConfig(), fetch: api.fetch });
    for (const url of ["http://evil.example", "https://evil.example/path", "javascript:alert(1)"]) {
      const r = await approve(pending.authorizeUrl, { state: pending.state, token: TOKEN, url });
      assert.equal(r.status, 400, url);
      assert.equal(r.body.ok, false);
    }
    assert.ok(api.seen.every((u) => !u.includes("evil.example")));
    assert.equal(saved(), undefined);
    pending.close();
  });

  it("closes after five refused posts", async () => {
    const { pending } = await start({ configPath: tempConfig() });
    for (let i = 0; i < MAX_FAILED_POSTS; i++) {
      await approve(pending.authorizeUrl, { state: "wrong", token: TOKEN });
    }
    assert.equal(await pending.done, "failed");
    await assert.rejects(approve(pending.authorizeUrl, { state: pending.state, token: TOKEN }));
  });

  it("on success proves the token, saves it 0600 on the opened address, and closes", async () => {
    const configPath = tempConfig({ url: ADDRESS, token: OTHER_TOKEN, workspace: "Delivery" });
    const api = apiFor(TOKEN);
    const { pending, saved } = await start({ configPath, fetch: api.fetch });
    // The page suggests the main domain; the address that was opened wins.
    const r = await approve(pending.authorizeUrl, { state: pending.state, token: TOKEN, url: "https://neoeasel.com" });
    assert.equal(r.status, 200);
    assert.equal(r.body.ok, true);
    assert.equal(r.body.message, "Connected as wali in Amento Tech — you can close this tab and return to Claude.");
    assert.doesNotMatch(JSON.stringify(r.body), /otk_/);
    assert.deepEqual(saved(), { url: ADDRESS, token: TOKEN });
    // Replaces the previous token; the default workspace stays with its address.
    assert.deepEqual(JSON.parse(readFileSync(configPath, "utf8")), { url: ADDRESS, token: TOKEN, workspace: "Delivery" });
    if (process.platform !== "win32") assert.equal(statSync(configPath).mode & 0o777, 0o600);
    assert.deepEqual(api.seen, [`${ADDRESS}/api/auth/me`]);
    assert.equal(await pending.done, "connected");
    // Single use.
    await assert.rejects(approve(pending.authorizeUrl, { state: pending.state, token: TOKEN }));
  });

  it("falls back to the page's address only when the opened one refuses the token", async () => {
    const configPath = tempConfig({ url: ADDRESS, token: OTHER_TOKEN, workspace: "Delivery" });
    const api = apiFor(TOKEN, ["https://neoeasel.com"]);
    const { pending, saved } = await start({ configPath, fetch: api.fetch });
    const r = await approve(pending.authorizeUrl, { state: pending.state, token: TOKEN, url: "https://neoeasel.com" });
    assert.equal(r.body.ok, true);
    assert.deepEqual(saved(), { url: "https://neoeasel.com", token: TOKEN });
    // Another address: the old default workspace does not come along.
    assert.deepEqual(JSON.parse(readFileSync(configPath, "utf8")), { url: "https://neoeasel.com", token: TOKEN });
    await pending.done;
  });

  it("keeps nothing when OpsTracking refuses the token", async () => {
    const configPath = tempConfig();
    const { pending, saved } = await start({ configPath, fetch: apiFor(OTHER_TOKEN).fetch });
    const r = await approve(pending.authorizeUrl, { state: pending.state, token: TOKEN, url: ADDRESS });
    assert.equal(r.status, 400);
    assert.match(r.body.message, /Invalid or expired token\. Nothing was saved/);
    assert.doesNotMatch(r.body.message, /otk_/);
    assert.equal(saved(), undefined);
    assert.throws(() => readFileSync(configPath), /ENOENT/);
    pending.close();
  });

  it("closes on a cancel carrying the right state", async () => {
    const { pending, saved } = await start({ configPath: tempConfig() });
    const r = await approve(pending.authorizeUrl, { state: pending.state, error: "cancelled" });
    assert.equal(r.body.cancelled, true);
    assert.equal(await pending.done, "cancelled");
    assert.equal(saved(), undefined);
  });

  it("closes itself when nobody approves in time", async () => {
    const { pending } = await start({ configPath: tempConfig(), timeoutMs: 30 });
    // The listener and its timer are unref'd — they never keep a process
    // alive on their own — so something here has to while the test waits.
    const keepAlive = setInterval(() => undefined, 1000);
    try {
      assert.equal(await pending.done, "timeout");
    } finally {
      clearInterval(keepAlive);
    }
    await assert.rejects(fetch(`http://127.0.0.1:${pending.port}/callback`));
  });
});

describe("the connect tool", () => {
  async function serve(env: NodeJS.ProcessEnv, fetchImpl: FetchLike, clientName = "claude-code") {
    const opened: string[] = [];
    const { server, connection } = createServer({
      env,
      fetch: fetchImpl,
      timeoutMs: 2000,
      opener: async (url) => {
        opened.push(url);
        return true;
      },
      client: "wali-mbp",
    });
    const [a, b] = InMemoryTransport.createLinkedPair();
    const client = new Client({ name: clientName, version: "0" });
    await Promise.all([server.connect(b), client.connect(a)]);
    const call = async (name: string, args: Record<string, unknown> = {}) =>
      (await client.callTool({ name, arguments: args })) as CallToolResult;
    return {
      call,
      opened,
      close: async () => {
        connection.closePending();
        await client.close();
      },
    };
  }

  it("asks for the address when none is saved or passed, and opens no browser", async () => {
    const t = await serve({ OPSTRACKING_CONFIG: tempConfig() }, fakeApi(baseRoutes()).fetch);
    const r = await t.call("connect");
    assert.notEqual(r.isError, true);
    assert.match(textOf(r), /No OpsTracking address is saved yet\. Ask the user in the chat: "What's your OpsTracking address\?/);
    assert.match(textOf(r), /https:\/\/amento-tech\.neoeasel\.com/);
    assert.doesNotMatch(textOf(r), /neoeasel\.com\/connect/);
    assert.deepEqual(t.opened, []);

    // Every other tool says the same thing: ask for the address, then connect.
    const other = await t.call("list_projects");
    assert.equal(other.isError, true);
    assert.match(textOf(other), /Ask the user in the chat: "What's your OpsTracking address\?/);
    assert.match(textOf(other), /call the `connect` tool with the address they give/);
    assert.match(textOf(other), /browser window will open/);
    assert.match(textOf(other), /Never ask the user for an API token/);
    assert.deepEqual(t.opened, []);
    await t.close();
  });

  it("refuses an address that is not one, without opening anything", async () => {
    const t = await serve({ OPSTRACKING_CONFIG: tempConfig() }, fakeApi(baseRoutes()).fetch);
    const r = await t.call("connect", { address: "http://amento-tech.neoeasel.com" });
    assert.equal(r.isError, true);
    assert.match(textOf(r), /must use https/);
    assert.match(textOf(r), /Ask the user again/);
    assert.deepEqual(t.opened, []);
    await t.close();
  });

  it("reuses the saved address when none is passed", async () => {
    const configPath = tempConfig({ url: ADDRESS });
    const t = await serve({ OPSTRACKING_CONFIG: configPath }, fakeApi(baseRoutes()).fetch);
    const r = await t.call("connect");
    assert.match(textOf(r), /I've opened OpsTracking \(https:\/\/amento-tech\.neoeasel\.com\) in your browser/);
    assert.equal(t.opened.length, 1);
    assert.ok(t.opened[0].startsWith(`${ADDRESS}/connect/ai?callback=http%3A%2F%2F127.0.0.1%3A`));
    assert.equal(new URL(t.opened[0]).searchParams.get("app"), "Claude");
    await t.close();
  });

  it("takes a passed address over the saved one, saves it on success, and works without a restart", async () => {
    const configPath = tempConfig({ url: "https://old.neoeasel.com" });
    const api = fakeApi(baseRoutes());
    const t = await serve({ OPSTRACKING_CONFIG: configPath }, api.fetch);
    assert.equal((await t.call("whoami")).isError, true);

    const r = await t.call("connect", { address: "http://localhost:3000/" });
    assert.equal(t.opened.length, 1);
    assert.ok(t.opened[0].startsWith("http://localhost:3000/connect/ai?"));
    assert.equal((r.structuredContent as { address: string }).address, "http://localhost:3000");

    const ok = await approve(t.opened[0], { state: stateOf(t.opened[0]), token: TOKEN, url: "http://localhost:3000" });
    assert.equal(ok.body.ok, true);
    assert.deepEqual(JSON.parse(readFileSync(configPath, "utf8")), { url: "http://localhost:3000", token: TOKEN });

    const who = await t.call("whoami");
    assert.notEqual(who.isError, true);
    assert.match(textOf(who), /Signed in as Wali Ahmed/);
    await t.close();
  });

  it("says it is already connected unless asked to reconnect", async () => {
    const configPath = tempConfig({ url: ADDRESS, token: TOKEN });
    const t = await serve({ OPSTRACKING_CONFIG: configPath }, fakeApi(baseRoutes()).fetch);
    const r = await t.call("connect");
    assert.match(textOf(r), /Already connected to OpsTracking at https:\/\/amento-tech\.neoeasel\.com as wali in Amento Tech/);
    assert.match(textOf(r), /\/opstracking:setup/);
    assert.deepEqual(t.opened, []);

    await t.call("connect", { reconnect: true });
    assert.equal(t.opened.length, 1);
    // A newer connect replaces the pending one.
    await t.call("connect", { address: ADDRESS, reconnect: true });
    assert.equal(t.opened.length, 2);
    const first = await approve(t.opened[0], { state: stateOf(t.opened[0]), token: TOKEN }).catch(() => "closed");
    assert.equal(first, "closed");
    await t.close();
  });

  it("connection_status reports the saved address and who, opening nothing", async () => {
    const none = await serve({ OPSTRACKING_CONFIG: tempConfig() }, fakeApi(baseRoutes()).fetch);
    const r0 = await none.call("connection_status");
    assert.deepEqual(r0.structuredContent, { address: null, connected: false, who: null });
    await none.close();

    const t = await serve({ OPSTRACKING_CONFIG: tempConfig({ url: ADDRESS, token: TOKEN }) }, fakeApi(baseRoutes()).fetch);
    const r = await t.call("connection_status");
    assert.deepEqual(r.structuredContent, { address: ADDRESS, connected: true, who: "wali in Amento Tech" });
    assert.doesNotMatch(textOf(r), /otk_/);
    assert.deepEqual(t.opened, []);
    await t.close();

    const bad = await serve({ OPSTRACKING_CONFIG: tempConfig({ url: ADDRESS, token: TOKEN }) }, apiFor(OTHER_TOKEN).fetch);
    const r2 = await bad.call("connection_status");
    assert.equal((r2.structuredContent as { connected: boolean }).connected, false);
    assert.match(textOf(r2), /The saved token does not work/);
    await bad.close();
  });

  it("narrows the tool list to what was approved once connected, and tells the client", async () => {
    const { ToolListChangedNotificationSchema } = await import("@modelcontextprotocol/sdk/types.js");
    const readOnly = { ...me, token: { id: "t9", name: "Claude on wali-mbp", scopes: [], expiresAt: null } };
    const api = fakeApi([{ method: "GET", path: "/auth/me", reply: { body: readOnly } }, ...baseRoutes()]);
    const opened: string[] = [];
    const { server, connection } = createServer({
      env: { OPSTRACKING_CONFIG: tempConfig() },
      fetch: api.fetch,
      timeoutMs: 2000,
      opener: async (url) => {
        opened.push(url);
        return true;
      },
      client: "wali-mbp",
    });
    const [a, b] = InMemoryTransport.createLinkedPair();
    const client = new Client({ name: "claude-code", version: "0" });
    await Promise.all([server.connect(b), client.connect(a)]);
    let changed!: () => void;
    const listChanged = new Promise<void>((resolve) => (changed = resolve));
    client.setNotificationHandler(ToolListChangedNotificationSchema, () => changed());

    // Not connected: everything is listed, each tool answering how to connect.
    assert.ok((await client.listTools()).tools.some((t) => t.name === "create_task"));

    await client.callTool({ name: "connect", arguments: { address: ADDRESS } });
    const ok = await approve(opened[0], { state: stateOf(opened[0]), token: TOKEN, url: ADDRESS });
    assert.equal(ok.body.ok, true);
    await listChanged;
    const names = (await client.listTools()).tools.map((t) => t.name);
    assert.ok(!names.includes("create_task"), "a read-only approval lists no write tool");
    assert.ok(names.includes("list_tasks") && names.includes("whoami") && names.includes("connect"));
    connection.closePending();
    await client.close();
  });

  it("opens the browser when the saved token no longer works", async () => {
    const configPath = tempConfig({ url: ADDRESS, token: TOKEN });
    const t = await serve({ OPSTRACKING_CONFIG: configPath }, apiFor(OTHER_TOKEN).fetch);
    await t.call("connect");
    assert.equal(t.opened.length, 1);
    await t.close();
  });
});
