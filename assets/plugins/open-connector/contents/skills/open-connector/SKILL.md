---
name: open-connector
description: Use Open Connector tools to list connected apps, inspect actions, and run an action after the user has connected an account.
---

# Open Connector

These tools come from the Open Connector sidecar. They appear only after the plugin is enabled and only in sessions opened or rebound after that.

Use them when the user wants to act in a third-party app (mail, issues, files, chat) through a connection they already authorized.

## Order

1. `list_connections` to see which accounts exist.
2. `search_actions` or `list_apps` to find the action.
3. `get_action_guide` for that action before calling it.
4. `execute_action` with the connection the user named.

Do not invent connection IDs. Do not ask the user to paste tokens. If nothing is connected, tell them to open the Open Connector tab and connect there.

If a tool call fails because the sidecar is down, say the connector is not running and they should enable or restart the plugin. Do not retry in a tight loop.
