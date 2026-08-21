# Desktop Packaging

VibeX uses Tauri native bundlers, so desktop installers are built on the
matching operating system:

- Windows builds produce an NSIS `.exe` installer.
- macOS builds produce `.app` and `.dmg` bundles.
- Linux builds produce an `.AppImage`.

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
desktop installers together without publishing them, use the GitHub Actions
workflow:

```sh
pnpm run tauri:build:all
```

The command above requires the GitHub CLI to be installed and authenticated. It
triggers `.github/workflows/desktop-release.yml`, which builds these artifacts:

- `VibeX-windows-x64`
- `VibeX-windows-arm64`
- `VibeX-linux-x64`
- `VibeX-linux-arm64`
- `VibeX-macos-x64`
- `VibeX-macos-arm64`

The generated installers are available from the workflow run's artifacts.

Pushing a version tag such as `v0.1.4` automatically runs the same workflow,
requires the Tauri updater signing credentials, uploads one installer per
platform using `VibeX-{version}-{os}-{arch}` names, publishes the updater
manifest, and marks the release as latest. Apple and Windows code signing is
applied when the complete credential set for that platform is configured.

The matching `Server Release` workflow publishes
`VibeX-{version}-{os}-{arch}-server.tar.gz` archives on the same GitHub
Release. Each archive contains `vibex-server`, `vibex-mcp`, the built web UI,
and bundled plugins.

To publish installers to an existing tag manually, pass the release tag:

```sh
pnpm run tauri:build:all -- --release-tag v0.1.3 --upload-to-release
```

You can also trigger the workflow manually from GitHub Actions and provide the
same inputs there.

## Runtime contract

- macOS bundles target macOS 12 or newer and are built for Intel and Apple
  Silicon.
- Windows bundles target x64 and ARM64, use the GUI PE subsystem, and include
  the offline WebView2 installer. Background commands use hidden-process
  creation flags and must not open a console window.
- Linux bundles target x64 and ARM64 on an Ubuntu 22.04 baseline. Windowed CEF
  requires X11/XWayland; Debian packages declare `xwayland` as a dependency.
  AppImage users on pure Wayland systems must install and enable XWayland.

The workflow smoke-starts the native executable on every matrix target. The
Windows smoke test additionally verifies the PE GUI subsystem and rejects a
visible console descendant. Linux is started through XWayland, matching the CEF
parent-window requirement.

## Release signing contract

When `upload_to_release` is enabled, the prepare job requires the Tauri updater
signing secrets. Apple Developer ID/notarization and Windows Authenticode
credentials are optional platform groups: when every secret in a group is
present, the build imports it into an ephemeral runner store, signs and verifies
the native artifacts, and removes the temporary key material in an `always()`
cleanup step. When an entire group is absent, that platform is published
unsigned, matching the 0.1.2 release behavior. A partially configured group is
rejected so the workflow cannot silently produce an unexpected signing state.
