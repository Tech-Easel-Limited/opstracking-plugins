# Privacy policy — OpsTracking plugin

_Last updated: 8 October 2026_

This policy covers the OpsTracking plugin for Claude Code and Cursor (this
repository). It is published by Tech Easel Limited (Amento Tech).

## What the plugin does with data

The plugin runs a small server on your own computer that your AI assistant
uses to read and change things in **your organization's OpsTracking** —
projects, tasks, time entries, clients, people, assets and invoices.

- **Where data goes.** The plugin talks only to the OpsTracking address you
  give it (for example `https://your-company.neoeasel.com`), over HTTPS.
  Plain HTTP is accepted only for `localhost`. It sends no data to Tech Easel
  Limited, Amento Tech or any third party, and contains no analytics,
  telemetry or crash reporting.
- **What it sends.** Only the requests needed for what you ask the assistant
  to do, authenticated with your connection's API token.
- **What your assistant sees.** Results of those requests are returned to the
  assistant you are using (Claude Code or Cursor) so it can answer you. How
  that assistant handles conversation data is covered by its own provider's
  privacy policy.

## What is stored on your computer

- Your OpsTracking address, the connection's API token and an optional
  default workspace, in `~/.opstracking/claude.json` (Claude) or
  `~/.opstracking/cursor.json` (Cursor). The file is readable only by your
  user account (permissions `0600`).
- Nothing else. The plugin keeps no logs of your conversations or of the data
  it reads.

## Connecting

When you connect, the plugin opens a browser tab on your OpsTracking address
and listens on `127.0.0.1` (this computer only) for up to 10 minutes to receive
the connection's token once you approve it. Your password is entered only on
the OpsTracking page and never passes through the plugin or the assistant.

## Your control

- Choose what a connection may change, and for how long (7, 30 or 90 days),
  on the approval page.
- Revoke a connection at any time in OpsTracking under
  **Settings → Password & security → API tokens**.
- Remove the plugin and delete the `~/.opstracking/` file to remove
  everything it stored.

## Data held in OpsTracking

Data you work with lives in your organization's OpsTracking account and is
governed by your organization's agreement with OpsTracking, not by this
plugin.

## Children

The plugin is a business tool and is not directed at anyone under 18.

## Contact

Questions about this policy: open an issue at
https://github.com/Tech-Easel-Limited/opstracking-plugins/issues. Changes to
this policy are made in this file and visible in its history.
