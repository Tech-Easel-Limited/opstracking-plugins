/**
 * Which app is running this server — Claude, Cursor, or some other MCP client.
 *
 * Learned from the MCP handshake: the client names itself in `initialize`
 * (`claude-code`, `claude-ai`, `cursor-vscode`, …), and the SDK keeps that as
 * `server.getClientVersion()`. The label names the app on the approval page
 * and in the token's name (`Cursor on wali-mbp`), and picks which settings
 * file this app keeps its connection in, so Claude and Cursor on one machine
 * never overwrite each other's token.
 *
 * The page accepts exactly these three labels (frontend/src/lib/connectClaude.ts).
 */
export type AppLabel = "Claude" | "Cursor" | "AI assistant";

/** The settings-file name of an app that has its own: `claude` → `~/.opstracking/claude.json`. */
export type AppSlug = "claude" | "cursor";

export const GENERIC_APP: AppLabel = "AI assistant";

/** The label for a client's self-reported name; anything unrecognised is a generic assistant. */
export function appFromClientName(name: string | undefined): AppLabel {
  const n = (name ?? "").toLowerCase();
  if (n.includes("cursor")) return "Cursor";
  if (n.includes("claude")) return "Claude";
  return GENERIC_APP;
}

export function appSlug(app: AppLabel | undefined): AppSlug | undefined {
  if (app === "Claude") return "claude";
  if (app === "Cursor") return "cursor";
  return undefined;
}

/** `--app claude|cursor` on the command line, as a label. */
export function appFromSlug(slug: string): AppLabel | undefined {
  const s = slug.trim().toLowerCase();
  if (s === "claude") return "Claude";
  if (s === "cursor") return "Cursor";
  return undefined;
}

/** The app as a sentence names it: "Cursor", or "your AI assistant". */
export function appNoun(app: AppLabel | undefined): string {
  return app && app !== GENERIC_APP ? app : "your AI assistant";
}

/** The plugin's setup command as this app spells it. */
export function setupCommand(app: AppLabel | undefined): string {
  if (app === "Claude") return "/opstracking:setup";
  if (app === "Cursor") return "/opstracking-setup";
  return "the OpsTracking setup command";
}
