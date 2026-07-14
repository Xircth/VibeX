# VibeX 插件规范（v1）

VibeX 插件是一份**接入清单（manifest）**，不包含任何可执行代码。它描述三件事：

1. 如何把你的 Agent Skill 安装到用户机器（`install_command`）；
2. 如何让 Agent 启动你的 Web 控制台（`console_command` + `console_url`，通过 Hook 告知 Agent）；
3. 激活插件时向会话预填什么 Hook 消息（`hook_message`）。

> 核心原则：**VibeX 不启动控制台，Agent 才是控制台的所有者。**
> VibeX 只做三件事：装 skill、把端口/命令/地址约定通过 Hook 告诉 Agent、探测到控制台可达后自动在 Web Preview 中打开。

## manifest 文件

文件名约定 `vibex-plugin.json`，UTF-8，字段与 VibeX 设置表单一一对应。用户在
**设置 → 插件 → 导入 manifest** 中选择该文件即可回填表单。

```json
{
  "$schema": "vibex-plugin/v1",
  "name": "Dashi PPT",
  "skill_name": "dashi-ppt",
  "install_command": "npx dashi-ppt-skill@latest",
  "console_command": "DASHI_PPT_PREVIEW_PORT={{port}} bash ~/.claude/skills/dashi-ppt/scripts/render_goal_deck.sh output/deck/goal.json output/deck/index.html",
  "console_url": "http://127.0.0.1:{{port}}/",
  "hook_message": "……见下文 hook_message 要素……",
  "author": "chuspeeism",
  "icon": "📊",
  "expires_at": null,
  "notes": "AGPL-3.0；全程本地渲染"
}
```

## 字段规范

| 字段 | 必填 | 类型 | 说明 |
|---|---|---|---|
| `name` | ✅ | string | 插件显示名，出现在右侧边栏图标的 Hover 提示中 |
| `skill_name` | ✅ | string | Skill 的名称（技能目录名），Hook 中通过 `{{skillName}}` 引用 |
| `install_command` | ✅ | string | 全局安装 skill 的 shell 命令。保存插件时 VibeX 自动执行；包含 `skills add` 的命令会自动追加 `-y`；超时 300 秒；失败仅提示、不阻塞保存 |
| `console_command` | ✅ | string | 启动 Web 控制台的参考命令。**VibeX 不执行它**——渲染后通过 `{{consoleCommand}}` 写进 Hook 交给 Agent。支持 `{{port}}` |
| `console_url` | 建议 | string \| null | 控制台地址模板，支持 `{{port}}`。配置后 VibeX 才能探活并自动打开 Web Preview；留空则用户需手动输入地址 |
| `hook_message` | ✅ | string | 激活时渲染并预填进会话输入框的 Hook 模板，见下文要素清单 |
| `author` | ⬜ | string \| null | 作者 |
| `icon` | ⬜ | string \| null | Emoji/短文本，或 `data:` URL 的小图片（≤ 200KB） |
| `expires_at` | ⬜ | string \| null | RFC3339 时间戳；到期后插件按钮置灰禁用 |
| `notes` | ⬜ | string \| null | 备注 |

## 占位符

| 占位符 | 可用于 | 渲染为 |
|---|---|---|
| `{{port}}` | `console_command`、`console_url`、`hook_message` | 激活时分配的空闲端口。任一模板使用了它就会触发分配，且三处渲染为同一个值 |
| `{{pluginName}}` | `hook_message` | `name` |
| `{{skillName}}` | `hook_message` | `skill_name` |
| `{{consoleCommand}}` | `hook_message` | 端口渲染后的 `console_command` |
| `{{consoleUrl}}` | `hook_message` | 端口渲染后的 `console_url`；未配置时渲染为「未指定，请启动后告知地址」类提示 |

## 激活契约（运行时时序）

1. 用户点击右侧边栏的插件按钮；
2. VibeX 检查会话输入框：**已有内容或本轮对话进行中 → 中止并提示**；
3. 若任一模板含 `{{port}}`，分配一个本机空闲端口并渲染进全部模板；
4. 渲染 `hook_message` 预填进输入框，**由用户确认发送**；
5. Agent 阅读 Hook，按 `{{consoleCommand}}` 与端口约定**自行启动控制台**；
6. VibeX 每 2 秒对 `console_url` 做一次 TCP 探活（最长 10 分钟，覆盖首次
   `npx` 下载），可达后自动在 Web Preview 标签页打开并提示。

## 设计准则（打包质量线）

1. **控制台必须支持指定端口**（环境变量或命令行参数），否则 `{{port}}` 约定
   无法生效，探活地址与实际服务可能不一致；
2. `console_url` 的 host 必须是本机回环地址（`127.0.0.1` / `localhost`）——
   Web Preview 通过本地代理加载它；
3. `hook_message` 必须包含以下要素：
   - 声明当前使用的 skill（`{{skillName}}`）并要求 Agent 先阅读 skill 说明；
   - 控制台启动指引（`{{consoleCommand}}`）与端口/地址约定（`{{consoleUrl}}`）；
   - 失败自查语句：若约定地址上的服务未启动或不可访问，Agent 应自行查看
     服务日志或重新启动；
   - （可选）产物位置、协作方式等 skill 特有的上下文；
4. 控制台与 Agent 应以**工作区文件为协议**协作（Agent 写、控制台读/回写），
   不要依赖 VibeX 提供额外通道；
5. 交付前必须通过套件内的可用性测试（`node test/test-plugin.mjs`）。
