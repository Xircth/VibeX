# VibeX Plugin Product Package v4

## 1. 用户模型

VibeX Plugin 是一个可安装、可启停、可配置的产品功能单元。用户不需要理解这个功能由
Skill、MCP、Worker、App surface 或 Runtime 中的哪一种内部机制实现。插件列表只展示名称、
一句话简介、发布者、版本和启用状态；点击插件后进入独立详情页，通过“内容”和“配置”
两个 Tab 使用它。

`integrations`、运行时锁和激活代是 Host 的执行事实，不是插件详情页的信息架构。安装或启用
package 就表示 Full Trust，不存在逐能力权限模型。

## 2. 标准目录

```text
my-plugin/
├─ .vibex-plugin/
│  ├─ plugin.json              # 身份、兼容性、执行边界与声明
│  ├─ content.index.json       # CLI 初始化、作者维护、build 严格校验的内容目录
│  ├─ package.lock.json        # build 生成的不可变执行内容摘要
│  ├─ signature.json           # 可选
│  └─ sbom.spdx.json           # 可选
├─ README.md                    # 用户认知入口；frontmatter 只含一句话 summary
├─ config.json                  # 用户配置的唯一真实文件
├─ contents/                    # Agent 与用户均可查看/使用的内容
│  ├─ skills/
│  │  └─ example/SKILL.md
│  ├─ mcps/
│  │  └─ example.json
│  ├─ hooks/
│  │  └─ before-run.json
│  ├─ workflows/
│  │  └─ create-report/workflow.json
│  └─ resources/                # 模板、示例、说明等其他用户内容
├─ depends/                     # 插件拥有或要求的依赖描述
│  ├─ runtimes/
│  │  └─ example-cli.json
│  └─ packages/
├─ runtime/                     # 作者源码入口，不进入发布包
│  ├─ main.mjs
│  └─ app.html
└─ dist/                        # build 产生的确定性执行物
   ├─ worker.mjs
   └─ app.html
```

所有路径使用相对 package root 的 `/` 路径。包拒绝绝对路径、`..`、symlink/hardlink、
大小写碰撞、重复 normalized path 和超过 Host 限额的内容。

## 3. README 与 summary

`README.md` 必须位于根目录，并使用与 `SKILL.md` 相同风格的 frontmatter 提供独立的
`summary` 标签：

```markdown
---
summary: Preview, create, and transform Word, Excel, and PowerPoint documents.
---

# VibeX Office

这里开始才是完整 README 正文……
```

规则：

- `summary` 必须是一句话、非空、最多 200 个 Unicode 字符；
- summary 不支持 Markdown，也不从第一个标题或段落推断；
- 列表页和详情页标题区只显示 summary；
- 内容页显示移除 frontmatter 后的完整 README；
- README 可以说明功能、示例、使用方式、限制和隐私信息，但不承担机器执行声明。

## 4. 根 config.json

`config.json` 是插件配置的唯一真实文件。用户在插件详情的“配置”Tab 修改的就是这个文件，
Host 不另外维护一份数据库副本。

```json
{
  "preview": true,
  "idleTimeoutMinutes": 10
}
```

`plugin.json` 中的 `config.schema` 描述宿主渲染表单和写入校验：

```json
{
  "config": {
    "schema": {
      "type": "object",
      "properties": {
        "preview": {
          "type": "boolean",
          "title": "Document preview",
          "default": true
        },
        "idleTimeoutMinutes": {
          "type": "integer",
          "title": "Idle timeout",
          "minimum": 1,
          "maximum": 60,
          "default": 10
        }
      },
      "additionalProperties": false
    }
  }
}
```

Host 必须在写入前按 schema 校验，并以同目录临时文件、`fsync`、原子替换保存。`config.json`
是可变用户数据，因此不计入 executable package digest、签名和 activation generation；安装包
可以携带初始值，但更新默认保留用户现有配置，并按新 schema 做迁移/兼容检查。卸载时是否
保留 config 属于明确的数据保留选择。

## 5. 内容索引

`.vibex-plugin/content.index.json` 是 CLI 初始化、作者维护、build 严格校验、签名覆盖且由 Host
再次校验的结构化目录：

```json
{
  "schemaVersion": 1,
  "items": [
    {
      "path": "contents/skills/office-docx/SKILL.md",
      "kind": "skill",
      "title": "Word documents"
    },
    {
      "path": "contents/workflows/create-presentation/workflow.json",
      "kind": "workflow",
      "title": "Create presentation"
    }
  ]
}
```

UI 只读取通过 Host 验证并返回的索引与文档，不在客户端扫描任意文件系统路径。`kind` 用于图标、
排序与文档渲染，不把产品重新切回 Skill/MCP 等固定能力统计。内容页以 README 为默认文档，
再按 `contents/` 的结构展示索引项。

## 6. plugin.json

```json
{
  "$schema": "https://schemas.vibex.dev/plugin/v4/plugin.schema.json",
  "manifestVersion": 4,
  "apiVersion": "1.0",
  "id": "office",
  "publisher": "vibex",
  "version": "4.0.0",
  "name": "VibeX Office",
  "engines": {
    "vibex": ">=0.20.0 <0.22.0",
    "pluginSdk": "^1.0.0"
  },
  "readme": "README.md",
  "content": {
    "root": "contents",
    "index": ".vibex-plugin/content.index.json"
  },
  "config": {
    "file": "config.json",
    "schema": {
      "type": "object",
      "properties": {},
      "additionalProperties": false
    }
  },
  "entrypoints": {
    "worker": {
      "path": "dist/worker.mjs",
      "format": "javascript-esm",
      "protocol": "1.0"
    }
  },
  "dependencies": [],
  "integrations": []
}
```

`readme` 固定为根 `README.md`，`content.root` 固定为 `contents`；配置文件按约定固定为根
`config.json`，不再提供可改路径的 manifest 字段。固定约定避免同一种产品概念出现多套路径配置。

### integrations

`integrations` 是插件内容/代码与 VibeX 内核扩展点的机器映射，不是用户详情页章节：

- `content.skill`：把 `contents/skills/...` 投影给受支持的 Agent；
- `content.mcp`：把受控 MCP 描述投影给 Agent；
- `workflow.binding`：把 workflow 暴露为命令、动作或自动化入口；
- `file.opener`：声明文件类型解析，并且精确引用一个 `previewProvider`（只读预览）或
  `editorSurface`（可编辑文件 Tab）；
- `artifact.preview`：声明受 Broker 管理的预览 provider；
- `app.surface`：声明 Full Trust App surface 及其生命周期入口。

可编辑文本 Artifact 使用公开的 format-agnostic 契约：`file.opener.editorSurface` 引用一个
`slot: artifact.editor` 的 App surface。Host 保留规范化文件路径，只向 App bootstrap 提供文件名、
revision 与 `bridge.artifact.readText/writeText`。写入使用期望 revision 和原子替换，外部修改会返回
可恢复冲突。内核不解析 Drawio、Markdown 或其他具体文件格式。

每项 integration 有稳定 ID、版本、资源引用、兼容条件和可选 handler。运行时只能绑定 manifest
已声明的 integration，不能动态制造 Host 不认识的 contribution；这属于 contract 校验，不是
权限限制。

### dependencies

`depends/` 保存依赖描述，manifest 的 `dependencies` 显式引用它们。Runtime 精确身份为
`id + version + target + digest`，可多版本并存；下载、完整性校验、probe、引用计数和回收都由
Host 管理。原生可执行依赖随插件启用获得 Full Trust；digest/probe 只保证版本确定性与可诊断性。

## 7. 构建与发布

`vibex-plugin build`：

1. 严格校验 README summary、config/schema、content index、integrations 和 dependencies；
2. 将 `runtime/` 构建为 `dist/`；
3. 校验内容索引并生成 package lock 与完整性证据；
4. 验证所有声明引用均存在且处于允许目录。

`vibex-plugin pack` 产生确定性 `.vxp`。发布包包含 README、config 初始值、contents、depends、
dist 和 `.vibex-plugin` 元数据，不包含作者源码、source map、developer-link、绝对路径或时间戳。
`config.json` 随包分发但不参与 executable digest。

## 8. UI 契约

- `/plugins` 保留完整设置侧栏，主体是单列插件列表；
- 列表行显示图标、名称、README summary、发布者/版本和启停开关；
- 点击行进入 `/plugins/:pluginId` 独立详情页；
- 内容 Tab 展示 README 与经过验证的结构化 `contents/`；
- 配置 Tab 根据 `config.schema` 渲染表单并原子更新根 `config.json`；
- 安装/启用即表示信任整个插件，不显示逐能力权限确认 Dialog；
- 失败必须在当前页面显示 Toast，不能泄露 `plugins.loadFailed` 这类未翻译 key；
- generation、contribution count、handler、runtime lock 等诊断证据只进入开发者/诊断工具。

## 9. Office reference package

VibeX Office 必须只依赖公开包契约和 SDK。它的 README summary 是列表入口；Word/Excel/
PowerPoint Skills 与 workflows 位于 `contents/`；OfficeCLI 描述位于 `depends/runtimes/`；
Worker/App 入口位于 `runtime/` 并构建到 `dist/`；预览设置写入根 `config.json`。

核心不按 Office ID、DOCX/XLSX/PPTX 扩展名或 OfficeCLI 名称做特判。禁用一个 Office 产品插件
会撤下所有相关集成，但 UI 不把它拆成“平台扩展”和“Agent 扩展”。
