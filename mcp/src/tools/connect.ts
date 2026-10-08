import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import { z } from "zod";
import { setupCommand } from "../app.js";
import { ConfigError, parseBaseUrl } from "../config.js";
import { ASK_ADDRESS, CONNECT_TIMEOUT_MS, defaultOpener, PendingConnect, type Opener } from "../connect.js";
import type { Connection } from "../connection.js";
import { redact } from "../redact.js";

const text = (t: string, isError = false): CallToolResult => ({ content: [{ type: "text", text: t }], ...(isError ? { isError } : {}) });

export type ConnectToolOptions = {
  opener?: Opener;
  /** How long the browser has to approve; tests shorten it. */
  timeoutMs?: number;
  client?: string;
};

/**
 * `connect` — link this machine to the user's OpsTracking through their
 * browser. See src/connect.ts for the flow and why the token never passes
 * through the chat.
 */
export function registerConnectTool(server: McpServer, connection: Connection, opts: ConnectToolOptions = {}): void {
  server.registerTool(
    "connection_status",
    {
      title: "OpsTracking connection",
      description:
        "Shows which OpsTracking address is saved and whether the connection works (and as whom). Opens nothing " +
        "and changes nothing — use it to offer the saved address as a suggestion before calling connect.",
      inputSchema: {},
      annotations: { title: "OpsTracking connection", readOnlyHint: true, openWorldHint: false },
    },
    async () => {
      const address = connection.savedAddress() ?? null;
      let live = connection.active();
      if (!live) {
        try {
          live = connection.current();
        } catch {
          live = undefined;
        }
      }
      let who: string | null = null;
      let problem: string | null = null;
      if (live) {
        try {
          const me = await live.getMe(true);
          who = `${me.user.username}${me.currentOrg ? ` in ${me.currentOrg.name}` : ""}`;
        } catch (err) {
          problem = redact(err instanceof Error ? err.message : String(err), connection.token());
        }
      }
      const lines = [
        address ? `Saved address: ${address}` : "No OpsTracking address is saved.",
        who ? `Connected as ${who}.` : live ? `The saved token does not work: ${problem}` : "Not connected.",
      ];
      return {
        content: [{ type: "text", text: lines.join("\n") }],
        structuredContent: { address, connected: who !== null, who },
      };
    },
  );

  server.registerTool(
    "connect",
    {
      title: "Connect to OpsTracking",
      description:
        "Connects this AI assistant to the user's OpsTracking by opening their browser, where they sign in, tick what " +
        "the connection may change (nothing ticked is read only) and approve it; " +
        "the token then goes straight from the browser to this machine. Call it when another tool says OpsTracking is " +
        "not connected, or when the user asks to connect OpsTracking (to a new address). `address` is the user's " +
        "OpsTracking link, as they give it — ask them for it in the chat when none is saved. When a working " +
        "connection to that address already exists it says so and opens nothing, unless `reconnect` is true (the " +
        "plugin's setup command, the user asking to connect again, or a tool refusing for want of a permission the " +
        "connection was not given). On success the new address and token replace the saved ones, and the tool list " +
        "follows what was approved. Tell the user a browser window will open. Never ask the user for a token.",
      inputSchema: {
        address: z
          .string()
          .optional()
          .describe(
            "The user's OpsTracking address, e.g. https://amento-tech.neoeasel.com (or http://localhost:3000). " +
              "Omit to reuse the saved address.",
          ),
        reconnect: z
          .boolean()
          .optional()
          .describe(
            "true to approve a fresh connection even when one already works — for setting up again or switching " +
              "account. The new token replaces the saved one.",
          ),
      },
      annotations: {
        title: "Connect to OpsTracking",
        readOnlyHint: false,
        destructiveHint: false,
        idempotentHint: false,
        openWorldHint: true,
      },
    },
    async ({ address, reconnect }) => {
      let target: string;
      const given = (address ?? "").trim();
      if (given !== "") {
        try {
          target = parseBaseUrl(given);
        } catch (err) {
          const why = err instanceof ConfigError ? err.message.replace(/OPSTRACKING_URL/g, "The address") : "It is not a valid address.";
          return text(
            `"${given}" can't be used as an OpsTracking address: ${why} Ask the user again: "${ASK_ADDRESS}", then call connect with it.`,
            true,
          );
        }
      } else {
        const saved = connection.savedAddress();
        if (!saved) {
          // No default: which OpsTracking is the user's to say. No browser is
          // opened until they have.
          return text(
            `No OpsTracking address is saved yet. Ask the user in the chat: "${ASK_ADDRESS}". Then call connect with ` +
              "the address they give. Never ask them for a token.",
          );
        }
        target = saved;
      }

      // Already connected to this address with a token OpsTracking still
      // accepts: nothing to do unless a fresh approval was asked for.
      const app = connection.app();
      const live = connection.active();
      if (!reconnect && live && live.config.baseUrl === target) {
        const who = await live
          .getMe(true)
          .then((me) => `${me.user.username}${me.currentOrg ? ` in ${me.currentOrg.name}` : ""}`)
          .catch(() => undefined);
        if (who) {
          return text(
            `Already connected to OpsTracking at ${target} as ${who}. To connect again (a new token, another ` +
              `account or another address), run ${setupCommand(app)} — or call connect with reconnect: true.`,
          );
        }
      }

      let pending: PendingConnect;
      try {
        pending = await PendingConnect.start({
          address: target,
          configPath: connection.configPath(),
          readConfigPath: connection.readConfigPath(),
          fetch: connection.fetch,
          timeoutMs: opts.timeoutMs,
          client: opts.client,
          app,
          onConnected: (saved) => connection.use(saved),
        });
      } catch (err) {
        const why = err instanceof Error ? err.message : String(err);
        return text(`Could not start the connection on this machine (${why}).`, true);
      }
      connection.replacePending(pending);

      const opened = await (opts.opener ?? defaultOpener)(pending.authorizeUrl).catch(() => false);
      const minutes = Math.max(1, Math.round((opts.timeoutMs ?? CONNECT_TIMEOUT_MS) / 60_000));
      const lead = opened
        ? `I've opened OpsTracking (${target}) in your browser. Sign in there if it asks, then approve the ` +
          "connection with your password — and ask me again."
        : "I couldn't open a browser on this machine. Open the link below, sign in if it asks, approve the " +
          "connection with your password — and ask me again.";
      return {
        content: [
          {
            type: "text",
            text:
              `${lead}\n\nIf no browser window opened, use this link (it works for the next ${minutes} minutes, on this ` +
              `computer only):\n${pending.authorizeUrl}\n\n` +
              "(For the assistant: relay the message above to the user. When they say they have approved it, retry what " +
              "they asked for — the tools use the new connection without a restart.)",
          },
        ],
        structuredContent: { address: target, browserOpened: opened, url: pending.authorizeUrl },
      };
    },
  );
}
