# 桌面应用自更新（P1-6）

VibeX 桌面端集成了 `tauri-plugin-updater`：在 **设置 → 系统 → 应用更新** 检查更新，
下载并安装签名的发布产物后一键重启。

## 运行机制

- 前端 [AppUpdaterSection](../frontend/src/components/settings/AppUpdaterSection.tsx)
  调用 `@tauri-apps/plugin-updater` 的 `check()`；若有新版本，`downloadAndInstall()`
  带进度下载安装，再用 `@tauri-apps/plugin-process` 的 `relaunch()` 重启。
- 更新源与公钥在 [tauri.conf.json](../src-tauri/tauri.conf.json) 的 `plugins.updater`：
  - `endpoints`：默认指向 `https://github.com/vibex/vibex/releases/latest/download/latest.json`。
  - `pubkey`：签名验证公钥。
- `bundle.createUpdaterArtifacts: true` 让构建产出可更新的产物 + `.sig` 签名。

## ⚠️ 发布方必须做的一次性签名设置

更新产物必须用 **发布方自己的私钥** 签名，`tauri.conf.json` 里的 `pubkey`
必须是对应公钥。当前仓库里的公钥是**开发占位密钥**，其私钥不随仓库分发，
因此在替换成你自己的密钥前，真实更新无法通过签名校验。

1. 生成密钥对（私钥务必保密）：
   ```bash
   pnpm tauri signer generate -w ~/.vibex-updater.key
   ```
2. 把生成的**公钥**内容粘贴到 `tauri.conf.json` 的 `plugins.updater.pubkey`。
3. 构建/发布时提供私钥（作为 CI secret，勿提交）：
   ```bash
   export TAURI_SIGNING_PRIVATE_KEY="$(cat ~/.vibex-updater.key)"
   export TAURI_SIGNING_PRIVATE_KEY_PASSWORD="<若设置了密码>"
   pnpm tauri build
   ```
4. 把产物、`.sig` 与一份 `latest.json`（Tauri 更新清单）发布到 `endpoints`
   指向的地址（GitHub Release `latest/download/latest.json` 即可）。

在此之前，应用内"检查更新"可正常调用，但不会安装未通过签名校验的产物——
这是设计使然（防止未签名/被篡改的更新）。
