# JSON settings

VibeX-owned settings are stored in the user-editable
`~/.vibex/settings.json` document. The application reads the relevant section
again at its public settings boundary and watches the file for changes, so a
user or local agent can edit it without going through the settings UI. Open
settings pages refresh after an external edit while preserving unsaved drafts.
VibeX writes the document atomically and preserves sibling sections when one
page saves.

The current document shape is:

```json
{
  "application": {
    "config_version": "v9",
    "theme": "system"
  },
  "version_control": {
    "git_custom_path": null
  },
  "system": {
    "proxy": {
      "enabled": false,
      "proxy_url": null
    },
    "rendering": {
      "acceleration_mode": "auto"
    }
  },
  "web_service": {
    "port": 17891,
    "token": null,
    "auto_start": false
  },
  "model_providers": {
    "version": 2,
    "agents": {}
  },
  "chat_channels": {
    "channels": [],
    "event_filter": ["prompt_started", "prompt_finished"],
    "command_prefix": "/vibex",
    "include_prompt_text": false
  },
  "frontend": {
    "ui_zoom": 1,
    "mono_font": "default",
    "language": "zh-CN",
    "workspace_layout": {},
    "kanban_layout": {},
    "editor_settings": {},
    "key_overrides": {},
    "skills_grouping": true,
    "skills_host_mode": "copy",
    "main_window_close_behavior": "minimize"
  },
  "worktrees": {
    "<project-uuid>": {
      "create_command": "pnpm install",
      "delete_command": "pnpm run clean",
      "cleanup_prompt_enabled": true,
      "cleanup_prompt_threshold": 5
    }
  }
}
```

Lifecycle commands run with the worktree root as their current directory and
receive `VIBEX_PROJECT_ID`, `VIBEX_WORKSPACE_ID`, and `VIBEX_WORKTREE_PATH` in
their environment. A failing create command removes the newly-created worktree
and stops the operation. A failing delete command cancels worktree deletion,
leaving the worktree available for inspection.

The former application `config.json`, `version-control-settings.json`, and
`system-settings.json`, `web-service-settings.json`,
`model-provider-settings.json`, and `chat-channel-settings.json` files are
imported when their corresponding section is first needed. Existing browser
preferences are likewise imported into the `frontend` section on first launch.

Secrets stay out of this user-editable document: provider and channel tokens
remain in their protected secret stores. Agent-native settings remain in the
files owned by each agent; VibeX does not duplicate or overwrite those
authoritative external configs.
