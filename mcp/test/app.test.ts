import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, describe, it } from "node:test";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import { appFromClientName, appFromSlug, appNoun, appSlug, setupCommand } from "../src/app.js";
import type { FetchLike } from "../src/client.js";
import { configFilePath, configReadPath } from "../src/config.js";
import { PendingConnect } from "../src/connect.js";
import { createServer } from "../src/server.js";
import { takeAppFlag } from "../src/setup.js";
import { me, textOf, TOKEN } from "./helpers.js";

const CURSOR_TOKEN = `otk_${"c".repeat(32)}_${"C".repeat(43)}`;
const ADDRESS = "https://amento-tech.neoeasel.com";

describe("which app is asking", () => {
  it("names the app from the client's self-reported name", () => {
    assert.equal(appFromClientName("claude-code"), "Claude");
    assert.equal(appFromClientName("claude-ai"), "Claude");
    assert.equal(appFromClientName("Claude Desktop"), "Claude");
    assert.equal(appFromClientName("cursor-vscode"), "Cursor");
    assert.equal(appFromClientName("Cursor"), "Cursor");
    assert.equal(appFromClientName("vscode"), "AI assistant");
    assert.equal(appFromClientName(""), "AI assistant");
    assert.equal(appFromClientName(undefined), "AI assistant");
  });

  it("gives Claude and Cursor their own settings file, and nothing else one", () => {
    assert.equal(appSlug("Claude"), "claude");
    assert.equal(appSlug("Cursor"), "cursor");
    assert.equal(appSlug("AI assistant"), undefined);
    assert.equal(appSlug(undefined), undefined);
  });

  it("words the app for sentences and its setup command", () => {
    assert.equal(appNoun("Cursor"), "Cursor");
    assert.equal(appNoun("AI assistant"), "your AI assistant");
    assert.equal(appNoun(undefined), "your AI assistant");
    assert.equal(setupCommand("Claude"), "/opstracking:setup");
    assert.equal(setupCommand("Cursor"), "/opstracking-setup");
    assert.equal(setupCommand(undefined), "the OpsTracking setup command");
  });

  it("reads --app on the command line and refuses an unknown one", () => {
    assert.deepEqual(takeAppFlag(["--app", "cursor", "set", "url", "x"]), { app: "Cursor", rest: ["set", "url", "x"] });
    assert.deepEqual(takeAppFlag(["set", "--app=Claude"]), { app: "Claude", rest: ["set"] });
    assert.deepEqual(takeAppFlag(["set", "url"]), { app: undefined, rest: ["set", "url"] });
    assert.equal(appFromSlug("vscode"), undefined);
    assert.throws(() => takeAppFlag(["--app", "vscode"]), /Unknown app "vscode"/);
    assert.throws(() => takeAppFlag(["--app"]), /Unknown app/);
  });
});

/**
 * Per-app settings files live in the real home folder, so these tests point
 * HOME (which os.homedir() reads) at a temporary one for their duration.
 */
describe("per-app settings files", () => {
  let home = "";
  let savedHome: string | undefined;
  before(() => {
    savedHome = process.env.HOME;
  });
  after(() => {
    if (savedHome === undefined) delete process.env.HOME;
    else process.env.HOME = savedHome;
  });
  function freshHome(files: Record<string, unknown> = {}): string {
    home = mkdtempSync(join(tmpdir(), "otk-home-"));
    process.env.HOME = home;
    mkdirSync(join(home, ".opstracking"), { recursive: true });
    for (const [name, body] of Object.entries(files)) {
      writeFileSync(join(home, ".opstracking", name), JSON.stringify(body));
    }
    return join(home, ".opstracking");
  }
  const readJson = (path: string) => JSON.parse(readFileSync(path, "utf8")) as Record<string, string>;

  it("writes to <app>.json, the shared config.json without an app, and OPSTRACKING_CONFIG over both", () => {
    const dir = freshHome();
    assert.equal(configFilePath({}, "claude"), join(dir, "claude.json"));
    assert.equal(configFilePath({}, "cursor"), join(dir, "cursor.json"));
    assert.equal(configFilePath({}), join(dir, "config.json"));
    assert.equal(configFilePath({ OPSTRACKING_CONFIG: "/tmp/x.json" }, "cursor"), "/tmp/x.json");
    assert.equal(configReadPath({ OPSTRACKING_CONFIG: "/tmp/x.json" }, "cursor"), "/tmp/x.json");
  });

  it("reads the shared file until the app has its own", () => {
    const dir = freshHome({ "config.json": { url: ADDRESS, token: TOKEN } });
    assert.equal(configReadPath({}, "cursor"), join(dir, "config.json"));
    writeFileSync(join(dir, "cursor.json"), JSON.stringify({ url: ADDRESS, token: CURSOR_TOKEN }));
    assert.equal(configReadPath({}, "cursor"), join(dir, "cursor.json"));
    assert.equal(configReadPath({}, "claude"), join(dir, "config.json"));
    assert.equal(configReadPath({}), join(dir, "config.json"));
  });

  /** A fake OpsTracking that knows the given tokens. */
  function api(tokens: string[]): FetchLike {
    return async (_input, init) => {
      const auth = new Headers(init.headers).get("authorization") ?? "";
      if (!tokens.some((t) => auth === `Bearer ${t}`)) {
        return new Response(JSON.stringify({ error: { code: "invalid_token", message: "Invalid or expired token." } }), {
          status: 401,
        });
      }
      return new Response(JSON.stringify(me), { status: 200 });
    };
  }

  async function serve(clientName: string, fetchImpl: FetchLike) {
    const opened: string[] = [];
    const { server, connection } = createServer({
      env: {},
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

  it("keeps an existing connection working: Cursor reads the shared file until it connects", async () => {
    freshHome({ "config.json": { url: ADDRESS, token: TOKEN, workspace: "Delivery" } });
    const t = await serve("cursor-vscode", api([TOKEN]));
    const status = await t.call("connection_status");
    assert.deepEqual(status.structuredContent, { address: ADDRESS, connected: true, who: "wali in Amento Tech" });
    const again = await t.call("connect");
    assert.match(textOf(again), /Already connected .* run \/opstracking-setup/);
    assert.deepEqual(t.opened, []);
    await t.close();
  });

  it("connecting Cursor writes cursor.json and leaves Claude's settings alone", async () => {
    const dir = freshHome({
      "config.json": { url: ADDRESS, token: TOKEN, workspace: "Delivery" },
      "claude.json": { url: ADDRESS, token: TOKEN },
    });
    const t = await serve("cursor-vscode", api([TOKEN, CURSOR_TOKEN]));
    await t.call("connect", { reconnect: true });
    assert.equal(t.opened.length, 1);
    const u = new URL(t.opened[0]);
    assert.equal(u.pathname, "/connect/ai");
    assert.equal(u.searchParams.get("app"), "Cursor");
    assert.equal(u.searchParams.get("client"), "wali-mbp");

    const callback = u.searchParams.get("callback")!;
    const res = await fetch(callback, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ state: u.searchParams.get("state"), token: CURSOR_TOKEN, url: ADDRESS }),
    });
    const body = (await res.json()) as { ok: boolean; message: string };
    assert.equal(body.ok, true);
    assert.match(body.message, /return to Cursor\.$/);

    // The new token went to Cursor's own file — the default workspace carried
    // over from the shared one — and nobody else's file changed.
    assert.deepEqual(readJson(join(dir, "cursor.json")), { url: ADDRESS, token: CURSOR_TOKEN, workspace: "Delivery" });
    assert.deepEqual(readJson(join(dir, "claude.json")), { url: ADDRESS, token: TOKEN });
    assert.deepEqual(readJson(join(dir, "config.json")), { url: ADDRESS, token: TOKEN, workspace: "Delivery" });
    await t.close();

    // Claude, on the same machine, still uses its own connection.
    const c = await serve("claude-code", api([TOKEN]));
    assert.equal((await c.call("connection_status")).structuredContent?.connected, true);
    await c.close();
  });

  it("an unrecognised client keeps using the shared file", async () => {
    const dir = freshHome();
    const t = await serve("some-other-client", api([TOKEN]));
    await t.call("connect", { address: ADDRESS });
    const u = new URL(t.opened[0]);
    assert.equal(u.searchParams.get("app"), "AI assistant");
    const res = await fetch(u.searchParams.get("callback")!, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ state: u.searchParams.get("state"), token: TOKEN, url: ADDRESS }),
    });
    assert.match(((await res.json()) as { message: string }).message, /return to your AI assistant\.$/);
    assert.deepEqual(readJson(join(dir, "config.json")), { url: ADDRESS, token: TOKEN });
    assert.equal(existsSync(join(dir, "claude.json")), false);
    assert.equal(existsSync(join(dir, "cursor.json")), false);
    await t.close();
  });
});

describe("the callback page names the app", () => {
  it("says Cursor for Cursor and a generic assistant otherwise", async () => {
    const dir = mkdtempSync(join(tmpdir(), "otk-page-"));
    for (const [app, title, heading] of [
      ["Cursor", "<title>OpsTracking for Cursor</title>", "Connecting Cursor…"],
      [undefined, "<title>OpsTracking</title>", "Connecting your AI assistant…"],
    ] as const) {
      const pending = await PendingConnect.start({
        address: ADDRESS,
        configPath: join(dir, "config.json"),
        app,
        onConnected: () => undefined,
      });
      const html = await (await fetch(`http://127.0.0.1:${pending.port}/callback`)).text();
      assert.ok(html.includes(title), title);
      assert.ok(html.includes(heading), heading);
      assert.doesNotMatch(html, /Claude/);
      pending.close();
    }
  });
});
