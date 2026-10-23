---
summary: 在 VibeX 中创建、编辑、分析和预览 DOCX、XLSX 与 PPTX 文件。
---

# VibeX Office

把 Word、Excel、PowerPoint 的创建、修改、分析和预览留在 VibeX 工作区里完成，不必另开一套办公套件。

启用后有三件事会同时可用：

- Agent 用锁定的 `officecli` 就地改 `.docx` / `.xlsx` / `.pptx`，预览面板跟着刷新。
- Agent 获得 officecli 提供的全部 Skill（演示、文档、表格，以及提案、形变、论文、看板、财务模型和表单）。
- Composer 出现六条 Workflow，对应创建 / 修改 / 分析 / 生成。

## 启用

这是随 Host 分发的内置插件，默认关闭，不能卸载。在「插件」里打开即可。首次启用会把 Skill 和 Workflow 投给当前已安装、且支持相应能力的 Agent。之后再开关，会保留你改过的绑定。

预览和编辑都走 Host 锁死的 `officecli` Runtime。不要在自己的 PATH 里另装一份同名命令来替换它。

## 打开和预览

在工作区打开支持的文件。Agent 通过 Skill 调用 `officecli` 改文件；`watch` 预览会在 officecli 写盘后刷新。预览面板本身不接受键盘编辑。空闲一段时间后预览进程会停掉，下次再打开会重新拉起。超时时间在「配置」里改；已经打开的预览不受这次改动影响。

支持的文件：

- Word：`.docx`
- Excel：`.xlsx`
- PowerPoint：`.pptx`

旧版 `.doc` / `.xls` / `.ppt` 不在这个插件的范围内。

## 让 Agent 做事

直接描述结果，例如「根据这份纪要生成演示文稿」或「分析销售表里本季度的异常」。Agent 应使用本插件提供的 Skill 和锁死的 `officecli`，并返回工作区相对路径。

Skill 由构建步骤从锁定版本的 `officecli load_skill` 生成，不手写。officecli 版本变了，必须重新生成技能并升级本插件。

六条 Workflow 的用途：

| 身份 | 做什么 |
|---|---|
| `create-document` | 新建 DOCX |
| `modify-document` | 修改已有 DOCX |
| `create-presentation` | 新建 PPTX |
| `modify-presentation` | 修改已有 PPTX |
| `analyze-spreadsheet` | 分析 XLSX |
| `generate-spreadsheet` | 生成 XLSX |

没点名的结构、样式、工作表和幻灯片应尽量保留。改完要校验，不要把半成品路径当成完成。

## 配置

唯一可改的项是预览空闲超时（1–60 分钟，默认 10）。保存后写入这个插件的 `config.json`。已经打开的预览窗仍用打开时记下的超时。

## 离线与网络

预览、创建和修改都在本机。插件本身不访问网络。Agent 若还要读网页或下材料，那是该 Agent 自己的策略，与 Office 预览无关。

## 排障

- 文件打不开：确认扩展名是 `.docx` / `.xlsx` / `.pptx`，并且插件已启用。
- 预览转圈后退出：看 Runtime 是否就绪；关掉再打开插件，让 Host 重新 probe `officecli`。
- 预览过期：面板还开着时应自动续租。若提示过期，点重试。把空闲超时调短可更快回收没人看的预览。
- Agent 改了文件却说完成：要它返回工作区相对路径，并说明校验结果。不要接受桌面绝对路径或 PATH 上的另一份 CLI。
