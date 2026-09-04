---
status: proposed
date: 2026-09-04
decision-makers:
  - VibeX maintainers
---

# Office 插件：技能内容以 officecli 为权威，预览寿命由观看行为决定

Office 插件的预览架构已经与 Codeg 同构，不需要重做。要修的是三件被这个结论
掩盖的事：手写技能副本会随 officecli 升级而过期、预览租约是绝对超时而不是
空闲超时、插件配置项接不到宿主。

本决定在 [ADR-0069](0069-everything-is-a-plugin-platform.md) 的插件模型内，
不为 Office 开专用宿主路径。

## Context

先纠正一个先前比较里的错误结论：VibeX 的 Office 预览**不是**一次性渲染。
`.vibex-plugin/plugin.json` 的 `office-preview` 声明的进程是
`["watch", "{artifact}", "--port", "{port}"]`，`crates/plugins/src/process_preview_host.rs`
按 `WatchKey` 做引用计数复用、发租约、按 `references == 0` 收进程。这与 Codeg
`src-tauri/src/office_watch/` 的模型是同一个，包括它注释里说明的动机——
`officecli view html` 每次改动都重读整个 OpenXML zip，会和正在写同一文件的
Agent 在 Windows 上抢文件锁。两边都已经躲开了这个坑。

真正的差距在别处。

**其一，技能是手抄的。** VibeX 在 `contents/skills/` 下手写了三份 SKILL.md
（`office-docx` / `office-xlsx` / `office-pptx`）。Codeg 不手写，它从二进制里
取：`officecli load_skill <load_id>`，九份——`pptx`、`pitch-deck`、`morph-ppt`、
`morph-ppt-3d`、`word`、`academic-paper`、`excel`、`financial-model`、
`data-dashboard`。

这既是**数量差**（三对九，少掉的六份是提案演示、形变动画、学术论文、财务模型、
数据看板这些有实际价值的专项技能），也是**来源差**：手写副本和 officecli 的
真实能力是两个事实来源，officecli 从 1.0.140 升上去之后，副本不会跟着变，
而它描述的命令用法可能已经不对。

**其二，租约是绝对超时，不是空闲超时。**
`PREVIEW_LEASE_TTL` 硬编码 5 分钟，`schedule_expiry` 起一个定时器睡满 5 分钟就
按 `expires_at <= now` 收掉；全仓库找不到任何续租路径。后果是：**用户盯着一份
文档看到第 5 分钟，预览进程被杀掉。** 这不是空闲回收，是无条件寿命上限。

Codeg 对应的是一个真的空闲清扫，加上 `SSE_LEASE_GRACE`（90 秒）——在浏览器标签
崩溃、断网、停止请求永远送不到时，靠最后一条 SSE 连接断开来兜底回收。它的
判据是「还有没有人在看」，VibeX 的判据是「起来多久了」。

**其三，配置项接不到宿主。** `plugin.json` 声明了 `idleTimeoutMinutes`
（1–60，默认 10），README 里也写了「唯一的设置是预览空闲超时」。但
`process_preview_host.rs` 从头到尾只用常量 5 分钟，**从不读这个配置**。用户改这
个值不会有任何效果，而且它标称的默认值 10 与实际生效的 5 甚至对不上。

**其四，README 低估了自己。** 现文案是「read-only preview… It is not an
in-window editor」。预览面板确实不可编辑，这句没错；但用户读到的是「这个插件
不能改文件」，而真实闭环是 Agent 用 officecli 原地改、watch 预览跟着刷新。按
maiden 原则 6，可见文案要帮用户判断能做什么，这句话让人以为做不到能做的事。

## Decision drivers

1. 技能描述的是 officecli 的能力，权威就应该在 officecli。
2. 预览该活多久由「有没有人在看」决定。
3. 声明了的配置项必须真的生效。

## Decision

### 1. 技能在构建期从 officecli 生成，不手写

`contents/skills/` 下的 Office 技能由构建步骤调用锁定版本的
`officecli load_skill <id>` 产出，产物随插件一起进 `content.index.json` 的
内容寻址锁。手写副本删除。

**构建期而非运行期**，这是与 Codeg 的必要分歧：VibeX 的插件内容是内容寻址
锁定的（`content.index.json` + `package.lock.json`），运行期改写 `contents/`
会让锁失效。Codeg 没有这层锁，所以它能在运行期同步。VibeX 不能为了对齐做法
而破坏自己的完整性保证。

由此产生一条绑定：**officecli 版本变了，技能必须重新生成，插件版本随之升级。**
`depends/runtimes/officecli.json` 的版本与技能产物同属一次发布。

技能集合取 officecli 实际提供的全部，不再限于三种文件类型。`load_skill` 的
可用 id 与调用方式以锁定版本实测为准——1.0.140 是否提供该子命令必须先验证，
不能照抄 Codeg 的假设。若 1.0.140 不提供，则先升 officecli 到提供它的版本，
而不是退回手写。

### 2. 预览寿命由观看行为决定

租约改为**可续租**：预览面板在存活期间定期续租，宿主按「最后一次续租之后
经过了多久」判定空闲。用户在看，预览就不死。

面板卸载时的显式关闭保留（今天已经有，`PluginFilePreview` 在 effect 清理里
调关闭）。续租机制是它的兜底，处理显式关闭送不到的情况——标签崩溃、进程被杀、
连接断开。Codeg 用 SSE 连接数做这件事，VibeX 用租约续期，判据等价而不依赖
预览内容协议。

续租间隔必须显著小于空闲阈值，否则正常观看会被误判为空闲。

### 3. 空闲阈值来自插件配置

`idleTimeoutMinutes` 由宿主读取并作用于该插件的预览租约。`PREVIEW_LEASE_TTL`
常量作为「插件未声明该配置时」的默认值保留，但不再覆盖插件的声明值。

配置改变对**已打开**的预览是否生效，要在 README 里说准。现文案「Open previews
are unchanged」是可接受的语义，前提是实现真的如此。

### 4. README 描述真实闭环

改写为描述用户实际能做的事：Agent 通过技能与锁定的 officecli 就地修改
`.docx` / `.xlsx` / `.pptx`，预览面板跟随刷新；预览面板本身不接受键盘编辑。

一并修掉现文案里的两处不准：`ncli` 应为 `officecli`；「唯一的设置是预览空闲
超时（1–60 分钟，默认 10）」在第 3 条落地前是假的，落地后才成立。

### 5. 不引入一次性渲染降级路径

Codeg 保留了 `officecli_render_html` 作为 watch 之外的路径。VibeX **不加**：
它就是被 watch 取代的那个会抢文件锁的实现，重新引入等于把已经解决的问题再
放回来。watch 起不来时的正确行为是报错并可重试，不是退回坏路径。

### 6. 并发上限对齐到实测，不对齐到 Codeg

`maxConcurrentPreviews` 现为 4，Codeg 是 32。这个数字应由实测的进程与端口开销
决定，不因为对方大就跟着大。4 是否过紧要用「同时打开多份文档」的实际场景验证。

## Consequences

- 技能从 3 份增至 officecli 提供的全部（当前已知 9 份），需要为新增技能确认
  `targets`（`codex` / `claude-code` / `acp`）并更新 `content.index.json`。
- 构建流程增加一个依赖 officecli 二进制的生成步骤。它必须在锁定版本上跑，
  否则生成的技能与运行期用的 CLI 不是同一个能力集。
- 预览续租是新的前后端往返，`PluginFilePreview` 与 `process_preview_host` 都要
  改。租约续期失败应表现为预览过期提示，不是白屏。
- 修掉 5 分钟硬超时后，长时间开着预览的会话会更久地持有 officecli 进程。这是
  正确的行为，但让 `maxConcurrentPreviews` 的取值更要紧。
- `idleTimeoutMinutes` 从摆设变成真配置，README 里关于它的描述第一次成立。
- 本 ADR 修的租约与配置问题在 `process_preview_host.rs` 层，**对所有声明了
  `artifact.preview` 的插件生效**，不是 Office 专属补丁。

## Considered Options

- **运行期从 PATH 上的 officecli 同步技能（照抄 Codeg）**：否决。会绕过内容
  寻址锁，且用户 PATH 上的 officecli 与插件锁定的不是同一个二进制。
- **保留手写技能，只补数量**：否决。数量补齐一次，来源问题还在，下次 officecli
  升级仍然过期。这正是 maiden 原则 2 要求追到的根因。
- **给 Office 单独做一套预览宿主**：否决。租约与配置的缺陷是平台级的，在 Office
  旁边再建一套只会让另一半插件继续带着这个缺陷。
- **把 `PREVIEW_LEASE_TTL` 从 5 分钟调大**：否决。这是把「用户看到第 5 分钟被
  杀」改成「用户看到第 30 分钟被杀」，判据仍然是错的。
