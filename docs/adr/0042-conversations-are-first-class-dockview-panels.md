---
status: accepted
date: 2026-08-09
decision-makers:
  - VibeX maintainers
---

# Conversation 是一等 Dockview 面板

P1 的多会话 Split View 把每个 Conversation 建模为独立 Dockview panel，而不在锁定的
右侧会话区域内部再实现第二套分屏框架。Conversation 默认仍在右侧打开，但可以被拖到
编辑区、组成标签组，或创建左右/上下分组；同屏最多三个 Conversation group，与现有
编辑区分组上限保持一致。

## Consequences

- 每个 Conversation panel 拥有独立的订阅、滚动位置、Composer 草稿视图和在途 Turn
  展示状态，不再依赖一个全局会话 DOM 在不同槽位之间搬运；
- 同一个 Server-bound window 内，一个 Conversation 最多存在一个 panel；重复打开只
  聚焦现有 panel，不复制 Composer、滚动状态或事件订阅。不同窗口与设备仍可同时查看
  同一 Conversation，并通过服务端事件序列和并发规则协调；
- 关闭、移动或重排 panel 只改变视图，不取消 Turn、不关闭 Agent session，也不删除
  Conversation；
- Dockview 是标签、分组、拖拽、序列化与恢复的唯一布局权威；不得在 Conversation
  panel 内再嵌套自定义 split tree；
- Dockview 布局、打开的 panel、标签顺序、分组尺寸、激活标签与滚动位置只在当前设备
  持久化，并按稳定 Server 身份、Project 与窗口身份隔离；它们不经 Server 同步，Profile
  改名或地址更新也不得丢失。Android 和其它桌面设备各自维护适合自身屏幕的布局；
- Composer draft 属于 Server 上的 Conversation，并在已授权桌面、浏览器与 Android
  之间共享。每次保存必须携带 `base_revision`；冲突时同时保留 Server 版本和本机未保存
  版本并要求用户选择或合并，禁止静默 last-write-wins。Turn 提交成功后仅在 revision
  仍匹配实际提交内容时清除草稿；本地附件只有成为 Server 可识别的 Artifact 后才能
  跨设备引用；
- 现有默认右侧会话体验继续保留，用户未使用分屏时不承担额外交互成本。

## Considered Options

- 在固定右侧会话区域内新增嵌套 splitter：否决。它会制造第二套布局、拖拽、持久化和
  无障碍模型，并继续保留会话单实例假设。
