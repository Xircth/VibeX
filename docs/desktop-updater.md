# 桌面应用自更新（P1-6）

VibeX 桌面端集成了 `tauri-plugin-updater`：在 **设置 → 系统 → 应用更新** 检查更新，
下载并安装签名的发布产物后一键重启。

## 运行机制

- 前端 [AppUpdaterSection](../frontend/src/components/settings/AppUpdaterSection.tsx)
  通过统一的 `checkAppUpdate()` 查询签名更新源和 GitHub Release：展示当前版本、
  上次检查时间与更新日志。若签名源有新版本，`installSignedUpdate()` 带进度下载
  安装，再用 `@tauri-apps/plugin-process` 的 `relaunch()` 重启。
- 更新源与公钥在 [tauri.conf.json](../src-tauri/tauri.conf.json) 的 `plugins.updater`：
  - `endpoints`：默认指向 `https://github.com/Xircth/VibeX/releases/latest/download/latest.json`。
  - `pubkey`：签名验证公钥。
- `bundle.createUpdaterArtifacts: true` 让构建产出可更新的产物 + `.sig` 签名。

## ⚠️ 发布方必须做的一次性签名设置

更新产物必须用 **发布方自己的私钥** 签名，`tauri.conf.json` 里的 `pubkey`
必须是对应公钥。仓库只保存可公开的公钥；对应私钥及密码保存在 GitHub Actions
Secrets 中，不随仓库分发。

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
4. 触发 `desktop-release.yml` 并启用 Release 上传。工作流会在四个平台全部构建
   成功后汇总 updater 产物和 `.sig`，生成 `latest.json`，上传到对应 GitHub
   Release，并将该 Release 标记为 Latest。

在此之前，应用内"检查更新"可正常调用，但不会安装未通过签名校验的产物——
这是设计使然（防止未签名/被篡改的更新）。
