# Desktop Packaging

VibeX uses Tauri native bundlers, so desktop installers are built on the
matching operating system:

- Windows builds produce `.msi` and NSIS `.exe` installers.
- macOS builds produce `.app` and `.dmg` bundles.
- Linux builds produce `.AppImage` and `.deb` packages.

`pnpm run tauri:build` is still the default local command. It now chooses the
right bundle targets for the host OS automatically:

```sh
pnpm run tauri:build
```

Platform-specific aliases are also available when you want the command to be
explicit:

```sh
pnpm run tauri:build:windows
pnpm run tauri:build:macos
pnpm run tauri:build:linux
```

These commands build the current machine's native platform only. To produce all
desktop installers together, use the GitHub Actions workflow:

```sh
pnpm run tauri:build:all
```

The command above requires the GitHub CLI to be installed and authenticated. It
triggers `.github/workflows/desktop-release.yml`, which builds these artifacts:

- `VibeX-windows-x64`
- `VibeX-linux-x64`
- `VibeX-macos-x64`
- `VibeX-macos-arm64`

The generated installers are available from the workflow run's artifacts.

To create a GitHub Release when needed and upload installers to it, pass a
release tag:

```sh
pnpm run tauri:build:all -- --release-tag v0.1.8 --upload-to-release
```

You can also trigger the workflow manually from GitHub Actions and provide the
same inputs there.
