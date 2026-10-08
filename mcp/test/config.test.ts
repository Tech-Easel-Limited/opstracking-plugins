import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  ConfigError,
  configFilePath,
  loadConfig,
  parseBaseUrl,
  parseToken,
  readConfigFile,
} from "../src/config.js";
import { redact } from "../src/redact.js";
import { TOKEN } from "./helpers.js";

describe("config", () => {
  it("accepts an https origin and strips the trailing slash", () => {
    assert.equal(parseBaseUrl("https://acme.neoeasel.com/"), "https://acme.neoeasel.com");
    assert.equal(parseBaseUrl("  https://acme.neoeasel.com  "), "https://acme.neoeasel.com");
  });

  it("allows http only for localhost and *.localhost", () => {
    assert.equal(parseBaseUrl("http://localhost:3000"), "http://localhost:3000");
    assert.equal(parseBaseUrl("http://acme.localhost:3000"), "http://acme.localhost:3000");
    assert.throws(() => parseBaseUrl("http://acme.neoeasel.com"), /must use https/);
    assert.throws(() => parseBaseUrl("http://127.0.0.1:3000"), /must use https/);
  });

  it("refuses anything that is not a bare origin", () => {
    assert.throws(() => parseBaseUrl("https://acme.neoeasel.com/api"), /without a path/);
    assert.throws(() => parseBaseUrl("https://acme.neoeasel.com/?x=1"), /without \?query/);
    assert.throws(() => parseBaseUrl("https://user:pw@acme.neoeasel.com"), /username or password/);
    assert.throws(() => parseBaseUrl("ftp://acme.neoeasel.com"), /https/);
    assert.throws(() => parseBaseUrl("not a url"), /not a valid URL/);
  });

  it("reports an unset variable, including the unexpanded ${VAR} Claude Code leaves behind", () => {
    assert.throws(() => parseBaseUrl(undefined), /address is not set/);
    assert.throws(() => parseBaseUrl("${OPSTRACKING_URL}"), /address is not set/);
    assert.throws(() => parseToken(""), /API token is not set/);
    assert.throws(() => parseToken("${OPSTRACKING_TOKEN}"), /API token is not set/);
  });

  it("validates the token shape without echoing the value", () => {
    assert.equal(parseToken(TOKEN), TOKEN);
    const bad = `${TOKEN}x`;
    try {
      parseToken(bad);
      assert.fail("expected a ConfigError");
    } catch (err) {
      assert.ok(err instanceof ConfigError);
      assert.ok(!err.message.includes(bad.slice(4, 20)), "the message must not contain the token");
    }
    assert.throws(() => parseToken("otk_ABCDEF_short"), ConfigError);
    assert.throws(() => parseToken(`sk_${TOKEN.slice(4)}`), ConfigError);
  });

  it("loads the optional default workspace", () => {
    const cfg = loadConfig({ OPSTRACKING_URL: "https://a.neoeasel.com", OPSTRACKING_TOKEN: TOKEN, OPSTRACKING_WORKSPACE: " Delivery " }, {});
    assert.deepEqual(cfg, { baseUrl: "https://a.neoeasel.com", token: TOKEN, defaultWorkspace: "Delivery" });
    const none = loadConfig({ OPSTRACKING_URL: "https://a.neoeasel.com", OPSTRACKING_TOKEN: TOKEN, OPSTRACKING_WORKSPACE: "${OPSTRACKING_WORKSPACE}" }, {});
    assert.equal(none.defaultWorkspace, undefined);
  });
});

describe("settings file fallback", () => {
  it("uses the file when the plugin passed nothing, or only its placeholders", () => {
    const file = { url: "http://localhost:3000", token: TOKEN, workspace: "Delivery" };
    assert.deepEqual(loadConfig({}, file), {
      baseUrl: "http://localhost:3000", token: TOKEN, defaultWorkspace: "Delivery",
    });
    assert.deepEqual(
      loadConfig({
        OPSTRACKING_URL: "${user_config.url}",
        OPSTRACKING_TOKEN: "${user_config.token}",
        OPSTRACKING_WORKSPACE: "${user_config.workspace}",
      }, file),
      { baseUrl: "http://localhost:3000", token: TOKEN, defaultWorkspace: "Delivery" },
    );
  });

  it("lets the saved settings override whatever the plugin passed", () => {
    const cfg = loadConfig(
      { OPSTRACKING_URL: "https://neoeasel.com", OPSTRACKING_TOKEN: TOKEN },
      { url: "http://localhost:3000" },
    );
    assert.equal(cfg.baseUrl, "http://localhost:3000");
    // A setting the file does not hold still comes from the environment.
    assert.equal(cfg.token, TOKEN);
  });

  it("says what is missing when neither says anything", () => {
    assert.throws(() => loadConfig({}, {}), /address is not set/);
    assert.throws(() => loadConfig({ OPSTRACKING_URL: "https://a.neoeasel.com" }, {}), /API token is not set/);
  });

  it("reads a missing file as no settings and a broken one as an error", () => {
    const dir = mkdtempSync(join(tmpdir(), "otk-"));
    assert.deepEqual(readConfigFile(join(dir, "absent.json")), {});
    const broken = join(dir, "config.json");
    writeFileSync(broken, "{ not json");
    assert.throws(() => readConfigFile(broken), /not valid JSON/);
    writeFileSync(broken, JSON.stringify({ url: "http://localhost:3000", token: TOKEN, extra: 1 }));
    assert.deepEqual(readConfigFile(broken), { url: "http://localhost:3000", token: TOKEN });
  });

  it("honours OPSTRACKING_CONFIG for the file's location", () => {
    assert.equal(configFilePath({ OPSTRACKING_CONFIG: "/tmp/x.json" }), "/tmp/x.json");
    assert.match(configFilePath({}), /\.opstracking[\\/]config\.json$/);
  });
});

describe("redact", () => {
  it("removes the configured token, any token-shaped string and bearer values", () => {
    const other = `otk_${"f".repeat(32)}_${"Z".repeat(43)}`;
    const out = redact(`a ${TOKEN} b ${other} c Authorization: Bearer abc.def-123 d`, TOKEN);
    assert.ok(!out.includes(TOKEN));
    assert.ok(!out.includes(other));
    assert.ok(!out.includes("abc.def-123"));
    assert.match(out, /Bearer \[redacted\]/);
  });
});
