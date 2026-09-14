---
status: accepted
date: 2026-09-13
decision-makers:
  - VibeX maintainers
---

# 供应商预置目录是插件贡献的模板，不是导入源，也不是 CC-Switch

设置 → Agent → 鉴权 → 供应商的新建表单需要一份**无密钥填表模板**，而不是再做
一个 CC-Switch，也不是把 `provider.model.importSource` 扩成目录。插件经新贡献点
`provider.model.catalog` 提供模板；Host 聚合并渲染；点选只填充该表面草稿；用户
补密钥并保存后，才成为该表面自己的已保存连接。保存之前，模板不是 Model
Provider preset，也不是导入候选项。

Runtime 权威仍是 Agent 原生配置（[ADR-0022](0022-agent-native-configuration-is-authoritative.md)、
[ADR-0063](0063-model-provider-presets-not-cc-switch.md)）。本决定不引入本地协议
转换代理、不全量覆盖原生快照、不成为配置权威。

本 ADR **不修订** ADR-0063 的导入语义：导入仍是「收成已有连接」。本 ADR **不修订**
[ADR-0069](0069-everything-is-a-plugin-platform.md) §8 能力等价白名单；不得把
ProviderSwitch 写进并不存在的自动启用列表。

## Context

供应商模式下，可复用 Model Provider 与 DeepSeek Harness 自定义的新建表单是空白
的。用户必须自己知道各中转的端点与模型 id。OpenCode / MiMo 的供应商表面已经有
`models.dev` 列表，但覆盖的是官方/目录内 Provider，不是按 Agent 整理的中转模板。

CC-Switch 用预置网格解决了「空白表单」：第一格永远是 Custom，其余是无密钥模板，
点选填表、用户补 Key、保存后才出现卡片，「Enable」再写入该 App 的原生配置。VibeX
要的是这个**填表**动词，不是 CC-Switch 的本地代理、协议转换、Universal Provider
跨 App 同步，也不是赞助商促销文案、心形/星标徽章或尊享/赞助商分组标题。

既有「导入」不能承担这个动词。[ADR-0063](0063-model-provider-presets-not-cc-switch.md)
经 [ADR-0069](0069-everything-is-a-plugin-platform.md) 把导入来源改成
`provider.model.importSource`：handler 返回**已经配好的连接**；缺 Key 的项列出但
禁止勾选；确认导入即保存为 preset，且不绑定。把无密钥模板塞进同一 kind，会弄坏
这条回归，并在同一菜单里混两个动作。

既有两个带 *catalog* 的 Host 命令也不是本目录：

| 命令 | 做什么 |
| --- | --- |
| `agent_model_provider_catalog` | 对**已填** url/key 探测 `/models` |
| `opencode_provider_catalog` | `models.dev` Provider 目录 |

三者不得共用客户端，也不得让「catalog」一词在设置面撞车。

## Decision

### 1. 新贡献点 `provider.model.catalog`，不复用导入源

导入源的产品动词是「收成已有连接」；目录的产品动词是「用模板填空白表单」。二者
的返回值、缺 Key 语义、UI 入口都冲突。**永不**复用或扩展
`provider.model.importSource` 来承载模板目录。

### 2. Host 渲染 descriptor，插件不替换新建表单

卡片列表、保存、绑定、测连、投影已是 Host 闭环。目录只是表单的数据。高频表单走
iframe / federation 会造出第二条保存路径。渲染三轨里这属于宿主渲染 descriptor。

### 3. 目录数据放在插件里，不放进 Host

预置供应商会过时，并带第三方商标与许可，且不是 L0。Host 只拥有聚合、校验、按
Agent 过滤、启停原子性。官方目录随 ProviderSwitch 版本更新。

### 4. ProviderSwitch 是普通官方市场插件，默认禁用，不是能力等价插件

ADR-0069 §8 的自动启用白名单只适用于「从内置迁出」的能力。这份目录是新能力，
不是迁出。不得发明一份自动启用白名单，也不得把 `vibex.provider-switch` 写进
§8。随 Host family 提供 bundled 快照，可从官方分类安装；安装后默认禁用，启用
即出现网格。Host **不得**按插件 ID `vibex.provider-switch` 特判。

### 5. Catalog DTO 按表面判别联合；已保存连接仍瘦

模板按表面判别为 `reusable` | `opencode` | `dsh`，各带该表面保存时已认识的字段。
可复用 Model Provider 的存储仍是名称、端点、模型映射和凭据；网站、候选 URL、
密钥字段名只在填表期展示，不扩已保存预设。OpenCode / MiMo 的模型列表保存。
DeepSeek Harness 自定义的备注保存。各表面自己把模板映射进草稿；共享选择器不写
任一表面的字段。

### 6. v1 只接受静态 resource，不声明 handler

官方 ProviderSwitch 无 Worker。动态目录没有第一个官方消费者，按 ADR-0069 原则 3
不把未验收的 handler 写进稳定契约。出现 `handler` 则校验失败、不发布该条。

本 kind 与官方消费者 ProviderSwitch **同批**完成 ADR-0066 稳定面四项（CLI
validate、Host inspect、真实 UI 消费、作者文档）之前，保持 preview，**不得**写入
稳定面叙述或 `init` 模板。kind 成为 ready 的同一批次必须带上 ProviderSwitch。

### 7. Custom 是 Host 所有，不是目录条目

可复用 Model Provider 与 DeepSeek Harness 自定义新建子页的第一格永远是 Host 的
「自定义」。OpenCode / MiMo 的空白连接表单就是 Custom，不另做第一格。插件不能
移除 Custom。

### 8. 按 VibeX 规范 Agent id 分目录

每份目录对应一个规范 Agent id。Gemini 目录只贡献 `antigravity`，**永不**
发射 `gemini`：后者是另一字符串，Host 按字符串相等过滤，不得为匹配去特判
Antigravity（那是导入源的动词）。Claude Desktop 丢弃。没有供应商模式的 Agent
（Cursor / CodeBuddy / Qoder）上的贡献被过滤；列出它们时返回空列表，不报错。

### 9. CC-Switch 数据是整理后的版本化快照，不直播抓取

来源许可与归属必须清晰。去掉 affiliate 参数、OAuth / 协议转换字段、赞助商文案
与徽章。官方订阅 / 官方 API 预置不进供应商目录。赞助商层次只作为转换输入，映射
到 `category` 之后不得出现在输出里。

### 10. 官方插件身份是 `vibex.provider-switch`

它是官方产品包：进 bundled 发行物与官方分类，不是导入源那种 authoring sample。
优先独立仓库以 submodule 挂入（ADR-0069 §8）；仓库未就绪时可先 in-tree，行为与
其它官方产品插件相同。

### 11. 保存永远走现有 Host IPC，插件不拥有卡片

用户在 Host 表单点保存。ProviderSwitch **不**调用 `provider.presets.save` /
`bind`。`provider.presets.*` 维持给「插件自己写 preset」的场景（导入源、未来的
App surface），本产品不用。

### 12. 多插件聚合：并列展示，不去重删除

可聚合缝（ADR-0069 §11）。URL 与名称相同的两条都保留，用插件来源标注区分。安装
顺序不决定输赢；用户用禁用插件来做替换。`category` 为
`"official" | "prime" | "partner" | "community"`；缺省、省略、任何未知值都归为
`"community"`。第三方 catalog 插件可写这四档；Host 不按官方插件 ID 特判。

### 13. OpenCode / MiMo 把插件行合并进现有 `models.dev` 列表

该表面已经有可搜索、点选即填的 `opencode_provider_catalog` 列表。再挂一张模板
网格会变成三种发现 UI。插件模板追加在现有 `models.dev` 块之后并标注来源，不替换
`models.dev`，不另开第二选择器，不占用今天的可见条数窗口。插件 `provider_id` 与
某条 `models.dev` id 相同则两行都保留。禁用插件后，该列表与今天一致。

### 14. 列出目录的 Host 命令是 `provider_catalog_list`，scope 为 `plugin.read`

它与 `plugin_contribution_catalog` 同级（只读目录）。`plugin.surface` 留给打开
surface / 调用贡献。客户端只挂在插件控制面 API 上，**不得**与
`agent_model_provider_catalog`、`opencode_provider_catalog` 并排，以免「catalog」
撞名。无模板且 Agent 已知时返回空列表；无法解析的 Agent id 报错。

### 15. 从 CC-Switch 到可投影模板的转换是产品

只保留能投影到该 Agent 已适配原生字段的条目。依赖协议转换或无法投影的预置在
转换期丢弃，Host 不弹实现向提示。转换规则是产品契约，后续实现不得另发明编码。

### 16. Host 默认排序为官方 → 尊享 → 赞助商 → 其余按显示名

前三组是分区拼接，保持各贡献源数组顺序，**不**按名称重排；community 按显示名
（锁定 `en` locale）。层次编码为 `category`，不输出赞助商布尔、不画心形/星标
徽章、不画尊享/赞助商分组标题、不写促销文案。按名称打平只属于可复用 / DSH 的
选择器，且可关闭后恢复 Host 默认；OpenCode / MiMo 没有这一开关。

## Consequences

- 启用带 `provider.model.catalog` 的插件后，对应 Agent 的供应商新建表单可以使用
  无密钥模板；禁用或卸载后模板原子消失，已保存连接与绑定不受影响。
- 导入菜单、`provider.model.importSource`、导入不绑定，全部保持 ADR-0063 / 0069
  原样。
- 可复用预设存储不膨胀；各表面继续走自己的保存与投影。
- 官方目录默认不出现。用户没启用 ProviderSwitch 时，空白自定义表单与 OpenCode
  `models.dev` 列表与今天一致。
- [ADR-0069](0069-everything-is-a-plugin-platform.md) §4 接管面总表增加 preview
  行；在 ProviderSwitch 同批验收之前，该行不是稳定面。
- 目录规模的约数不是本 ADR 契约，随来源版本变化，实现与文档都不得把它写成限额。

## Considered Options

- **复用或扩展 `provider.model.importSource`。** 否决。缺 Key 在导入里是禁止勾选；
  在目录里是期望状态。硬塞进一个 kind 等于两个产品挤在一个名字里。
- **插件 App surface 替换新建表单。** 否决。会造出第二条保存/绑定路径，禁用时还
  要把表单所有权交还 Host。
- **把预置 JSON 放进 Host。** 否决。更新、许可与第三方商标会迫使 Host 发版，且
  无法原子撤下。
- **按能力等价插件自动安装并默认启用。** 否决。今天没有网格，无所谓「迁出后消失」；
  未同意就把数十个中转推进设置是推广，不是连续性。
- **全量移植 CC-Switch（含 OAuth/代理字段），或只用 `models.dev`。** 否决。离开
  本地代理许多条目不能用；`models.dev` 不够覆盖中转模板。采用整理后的可投影快照；
  OpenCode 表面把插件行合并进已有列表。
- **扩展已保存预设，或用单一 `model` + extras 袋子填三表面。** 否决。OpenCode 的
  模型列表与 DSH 的备注装不进瘦预设；extras 会弄脏投影面。判别联合、各 store 仍瘦。
- **先按 vendor/community、组内按名称排序。** 否决。采用官方 → 尊享 → 赞助商 →
  community 按名称；前三组保源数组顺序。只排序，不搬促销 UI。
