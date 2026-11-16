# `@dimoai/plugin-cli` (`dimo-plugin`)

Official author toolchain for scaffolding, building, validating, testing, live-linking, and packaging **Dimo v4 Full-Trust Plugins** (`.vxp`).

## Commands

```bash
dimo-plugin toolchain                                     # Print Host version, contract, SDK paths, and templates
dimo-plugin init <name> --publisher <id> --template full  # Scaffold a v4 plugin package
dimo-plugin validate [dir]                                # Validate manifest, README summary, contents, and schema
dimo-plugin test [dir]                                    # Run plugin tests
dimo-plugin build [dir]                                   # Bundle Worker and App surfaces (esbuild / Module Federation)
dimo-plugin pack [dir]                                    # Produce a verifiable .vxp archive
dimo-plugin install --link [dir]                          # Register a linked development directory with the local Host
```

When working inside the Dimo monorepo, run `node packages/plugin-cli/dist/cli.js <command>` (build the CLI once with `pnpm --filter @dimoai/plugin-cli build`).

## Documentation

- [Plugin Developer Protocol](./PLUGIN_DEV_PROTOCOL.md)
- [SDK & CLI Reference](../../docs/plugins/sdk-and-cli.md)
- [Plugin Developer Guide](../../docs/plugins/developer-guide.md)
- [Package v4 Specification](../../docs/plugins/package-v4.md)
