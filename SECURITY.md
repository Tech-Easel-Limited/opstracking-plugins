# Security

Please report security issues privately through GitHub's
[private vulnerability reporting](https://github.com/Tech-Easel-Limited/opstracking-plugins/security/advisories/new)
for this repository — not in a public issue. We aim to reply within three
working days.

## Design notes

- The connection is approved in the browser; the API token goes straight from
  the OpsTracking page to a listener on `127.0.0.1` and is saved with `0600`
  permissions. It never appears in the chat.
- A connection can only do what was ticked when it was approved. Acts such as
  inviting people, changing roles, sending invoices and submitting timesheets
  are only ever **requests** that a person approves in OpsTracking.
- Nothing can be deleted through the plugin. Billing, role permissions,
  voiding invoices and approving timesheets stay in the app.
- Text written by workspace members is passed to the assistant inside
  `<workspace-data>` tags and the bundled skill tells the assistant to treat
  it as data, never as instructions.
- `plugins/opstracking/server/opstracking-mcp.mjs` is an unminified bundle of
  the TypeScript source in `mcp/src`. CI rebuilds it from source on every
  push and fails if the committed file differs.
