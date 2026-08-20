# VibeX Office reference plugin

VibeX Office 是公共 Plugin v4 契约的首个 reference package。源码是 git 子仓库
`assets/plugins/office`（`https://github.com/Xircth/vibex-plugin-office`）。它必须仅使用公开 SDK、
integration、Capability Broker 和 Runtime dependency；VibeX 核心不得认识 Office 插件 ID、
OfficeCLI 名称或 DOCX/XLSX/PPTX 扩展名。

## 产品结构

```text
assets/plugins/office/
├─ .vibex-plugin/
│  ├─ plugin.json
│  ├─ content.index.json
│  └─ package.lock.json
├─ README.md
├─ config.json
├─ contents/
│  ├─ skills/
│  │  ├─ office-docx/SKILL.md
│  │  ├─ office-xlsx/SKILL.md
│  │  └─ office-pptx/SKILL.md
│  └─ workflows/
│     ├─ create-document/workflow.json
│     ├─ modify-document/workflow.json
│     ├─ create-workbook/workflow.json
│     ├─ modify-workbook/workflow.json
│     ├─ create-presentation/workflow.json
│     └─ modify-presentation/workflow.json
├─ depends/runtimes/officecli.json
├─ runtime/
│  ├─ main.mjs
│  └─ worker.mjs
└─ dist/
   └─ worker.mjs
```

README frontmatter 的一句话 `summary` 是目录入口；内容页展示完整 README、Skills 与
Workflows。配置页修改根 `config.json`，例如预览开关和空闲超时。用户不会看到“平台扩展”
与“Agent 扩展”两组，也不会看到 contribution 数量或 activation generation。

## 内部 integrations

Office manifest 把下列完整产品能力接入 Host：

- `content.skill`：Word、Excel、PowerPoint 的 Agent 指导；
- `workflow.binding`：创建和修改三种文档的结构化工作流；
- `file.opener`：声明支持的 Office 文件媒体类型与扩展名；
- `artifact.preview`：通过受控 preview lease 提供文件预览；
- `runtime` dependency：精确锁定并探测 OfficeCLI。

这些是机器契约，不是用户详情页的固定章节。禁用 Office 会原子撤下全部相关 integrations；
已打开的 preview lease 按 generation drain 结束或到期。

## Full Trust 与运行时

Office 与所有 VibeX 产品插件一样采用 Full Trust：启用后 Worker、App 与 OfficeCLI 拥有当前用户
权限，不显示逐能力授权弹窗。OfficeCLI 的安装、digest、probe、精确版本锁与进程回收仍由 Host
管理，用于可重复执行、更新和诊断，而不是安全门禁。

## 验收

1. 删除/禁用 Office package 后，Agent 工作流和 Office 预览同时不可用或回退到其他 provider；
2. 修改 `config.json` 后 executable digest 不变，重启后配置仍存在；
3. 更新包时保留可兼容的用户配置，不覆盖为包内默认值；
4. 将 Office package 复制为第三方 publisher 后，不修改核心代码即可验证、构建、安装与运行；
5. 核心源码不存在 Office ID、扩展名或 OfficeCLI 专用 dispatch。
