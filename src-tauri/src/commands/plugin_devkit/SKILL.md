---
name: vibex-plugin-packager
description: 把一个带本地 Web 控制台的 Agent Skill 打包成 VibeX 插件 manifest（vibex-plugin.json），并用套件自带的测试程序验证可用性。当用户要求「接入 VibeX / 做成 VibeX 插件 / 打包插件 / 生成 vibex-plugin.json」时使用。Package an agent skill with a local web console into a VibeX plugin manifest and verify it with the bundled test program.
---

# VibeX 插件打包

你的任务：把一个「Skill + Web 控制台」型项目（如 dashi-ppt、vibe-motion、
Understand-Anything 这类）打包成 VibeX 插件 manifest，并验证其可用性。

先通读同目录的 `references/plugin-spec.md`（字段规范、占位符、激活契约、
质量线），它是唯一权威规范；`references/examples/` 下有三个真实项目的
manifest 可对照。本文件只描述工作流程。

## 背景（一句话版）

VibeX 插件不含代码，只是一份 JSON 清单。用户点击插件按钮后，VibeX 分配端口、
把「怎么启动控制台、用哪个端口、地址是什么」通过 Hook 消息交给你（Agent），
**由你启动控制台**；VibeX 探测到地址可达后自动在 Web Preview 中打开。

## 工作流程

### 第 1 步：调研目标 skill

搞清楚四件事，缺一不可：

1. **安装方式**：一条可全局执行的 shell 命令（`npx skills add owner/repo`、
   专用安装器 `npx xxx@latest`、或 install.sh 一行式）；
2. **控制台启动方式**：哪条命令能拉起本地 Web 服务（可能是 skill 内置脚本、
   项目 dev server、独立 viewer 命令）；
3. **端口机制**：服务端口能否指定？通过什么方式（环境变量 / `--port` 参数 /
   配置文件）？固定端口是多少？
4. **控制台地址**：`http://127.0.0.1:<port>/` 之外是否有路径、token 等成分。

优先读目标项目的 SKILL.md、README、启动脚本源码；拿不准就实际运行一次。

### 第 2 步：确定端口方案

- 服务**支持指定端口** → 在 `console_command` 中用 `{{port}}` 传入
  （如 `DASHI_PPT_PREVIEW_PORT={{port}} …` 或 `… --port {{port}}`），
  `console_url` 写 `http://127.0.0.1:{{port}}/…`；
- 服务**只有固定端口**（如 Remotion Studio 3000） → 两处都写死该端口，
  不用 `{{port}}`；
- 服务**端口随机且不可指定** → 这是打包阻碍：`console_url` 留 null 并在
  hook 中要求 Agent 启动后回报地址（自动打开预览会失效），同时在 `notes`
  里注明此限制。能改造上游就改造上游。

### 第 3 步：编写 hook_message

按 `plugin-spec.md` 的要素清单写，缺一项都算不合格：
skill 声明 + 先读说明 → 启动指引（`{{consoleCommand}}`）→ 地址约定
（`{{consoleUrl}}`）→ 失败自查语句 → skill 特有的协作说明（产物路径、
控制台里能做什么）。语言与目标用户一致（默认中文）。

### 第 4 步：产出 vibex-plugin.json

在项目根目录写出 manifest，字段齐全（可选字段显式写 `null`），对照
`plugin-spec.md` 的字段表逐项检查。

### 第 5 步：运行可用性测试

```bash
node <devkit>/test/test-plugin.mjs vibex-plugin.json
```

- 默认执行 manifest 校验 + node/npx 环境检查 + 控制台启动探活
  （真实拉起 `console_command`、等待 `console_url` 可达、随后清理进程）；
- 加 `--run-install` 会真实执行安装命令（首次打包建议跑一次）；
- 控制台无法在本机跑（如需要特定项目环境）时用 `--skip-console`，
  并向用户说明未验证项。

**测试不通过不得交付。** 按报告逐项修复后重跑。

### 第 6 步：交付

把 `vibex-plugin.json` 交给用户，并告知：在 VibeX **设置 → 插件 →
导入 manifest** 中选择该文件，检查表单后保存；保存时 VibeX 会自动全局
安装 skill。

## 红线

- `console_command` 是给 Agent 看的参考命令，但必须**真实可执行**——测试
  程序会拉起它；
- `console_url` host 只能是 `127.0.0.1` / `localhost`；
- 不要在 manifest 中写入任何密钥或用户机器上的绝对路径（`~` 展开除外）；
- hook 里的失败自查语句不可省略：Agent 需要它来兜底端口/服务异常。
