# OpsTracking plugins

The official OpsTracking plugin for **Claude Code** and **Cursor**. It lets
your AI assistant read and — with your confirmation — update projects, board
tasks, time entries, clients, assets and invoice drafts in your organization's
OpsTracking, and file requests (invites, roles, invoice sends, timesheet
submissions) that you approve in the app. It never deletes anything.

Full usage guide: [plugins/opstracking/README.md](plugins/opstracking/README.md).

## Install

You need Node.js 20 or newer.

**Claude Code**

```text
/plugin marketplace add Tech-Easel-Limited/opstracking-plugins
/plugin install opstracking@amento-tech
```

Then run `/opstracking:setup`. If Claude Code asks for the plugin's
settings, leave them empty — you connect from the browser.

**Cursor**

Install **OpsTracking** from the Cursor marketplace. Before the listing is
live, clone this repository and copy `plugins/opstracking` to
`~/.cursor/plugins/local/opstracking`, then restart Cursor. Run
`/opstracking-setup` to connect.

## Example prompts

- "What's on my plate in OpsTracking today?"
- "Turn this bug report into a task in the WEB project: …"
- "Log 2h 30m on WEB-12 for yesterday."
- "Draft an invoice for Acme from last month's hours and preview it."

## Repository layout

```text
.claude-plugin/marketplace.json   Claude Code marketplace (name: amento-tech)
.cursor-plugin/marketplace.json   Cursor marketplace (generated)
plugins/opstracking/              the plugin both apps install
  .claude-plugin/plugin.json      Claude manifest, .mcp.json, commands/, skills/
  .cursor-plugin/plugin.json      Cursor manifest, mcp.json, cursor/ (generated)
  server/opstracking-mcp.mjs      the MCP server, bundled from mcp/src (generated)
mcp/                              the server's TypeScript source and tests
```

## Development

```sh
cd mcp
pnpm install
pnpm test
pnpm build:repo   # rebuilds server/ and Cursor's generated files — commit the result
```

Bump `version` in `plugins/opstracking/.claude-plugin/plugin.json`,
`.claude-plugin/marketplace.json` and `mcp/package.json` for every release.
CI fails if the committed generated files do not match the source.

## Privacy, security, license

- [Privacy policy](PRIVACY.md) — no telemetry; data goes only to your OpsTracking address.
- [Security](SECURITY.md) — report vulnerabilities privately.
- [MIT License](LICENSE).
