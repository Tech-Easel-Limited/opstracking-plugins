---
name: opstracking-setup
description: Connect to your OpsTracking (first time, again, or at a new address) — approved in your browser
---

Set up (or redo) the connection between this assistant and OpsTracking. The user's address, if they gave one: $ARGUMENTS

1. If no address was given above, call `connection_status` (it opens and changes nothing) and ask the user in
   the chat:
   - with a saved address: "What's your OpsTracking address? Current: <saved address> — say 'same' to keep it,
     or give a new one."
   - without one: "What's your OpsTracking address? (your organization's link, e.g.
     https://amento-tech.neoeasel.com — or http://localhost:3000 for a local copy)"

   Wait for their answer. Never ask for, or accept, an API token in the chat.
2. Call `connect` with `address` set to what they chose (the saved one for "same") and `reconnect: true`, so a
   fresh approval happens even when a token is already saved. The new address and token replace the saved
   ones once approved.
3. Tell the user: a browser tab is opening on that address; they may need to sign in there first; then they
   tick what the connection may change — "Changes it can make" happen after they confirm in the chat,
   "Changes you approve in the app" are only ever requests they approve in OpsTracking; nothing ticked is
   read only — and approve with their password. If the tab didn't open, give them the link from the tool's
   answer. When they say they're done, call `whoami` to confirm and tell them who they're connected as and
   what this connection may change.

If nothing was filled in above, use what the user typed after the command in the chat.
