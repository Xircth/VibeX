---
name: vibex-plugin-development
description: Build, validate, test, link, and pack VibeX product plugins with the Host-shipped SDK and CLI.
---

# VibeX Plugin Development

Do not search for a VibeX git checkout. Locate the toolchain from the running Host:

```text
vibex plugin toolchain
```

If that command is missing, use the sibling `vibex-plugin` next to the Host binary.

Then read the local SDK types and `packages/plugin-contract` catalogs shipped with the Host.

Author one product: README summary, `contents/`, root `config.json`, and declared integrations.

```text
vibex-plugin init [dir] --template full
vibex-plugin validate
vibex-plugin test
vibex-plugin build
```

Linking requires the user to confirm Full Trust in the Host. Do not ask the user to paste a loopback token. After confirmation, `vibex-plugin dev` runs only on the Host.

If the public SDK cannot express the product, stop and deepen the Host catalog first.
