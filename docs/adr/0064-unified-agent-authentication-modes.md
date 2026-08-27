---
status: accepted
date: 2026-08-26
decision-makers:
  - VibeX maintainers
---

# 内置 Agent 鉴权统一为官方订阅、官方 API、供应商三种组合

设置 → Agent 的鉴权区不再按各 Runtime 自造 Tab 名和混杂表单。所有内置 Agent
共用同一组产品模式，档案只声明自己有其中哪几种；没有的模式不出现。三种模式
互斥，当前生效的只有一个。原生配置仍是 Runtime 权威（ADR-0022）；VibeX 只投影
档案已适配字段，不引入 CC Switch 本地代理或全量覆盖（ADR-0063）。

## 三种模式

**官方订阅** — 该 Agent 官方账号/套餐。用户在设置里登录和注销；购买、升降级
仍走固定官方页面。能从官方账号面可靠读取的额度、重置时间进入 Kanban
「计量统计」；读不到数字时只给官方用量页入口。本地会话 Token 估算不是官方配额，
二者不得混成一张假表。

**官方 API** — 该 Agent 第一方固定端点上的 Key。可填写 API Key、拉取官方模型
列表，以及档案声明的模型映射。不能改官方 URL。Claude Code 在此配置 Haiku /
Sonnet / Opus 三个默认模型。OpenCode 现有 `models.dev` 连接器是它官方 API 面的
实现载体：Zen 与其它第一方/目录内官方条目走这里；第三方中转与自定义端点仍属
供应商。

**供应商** — 第三方或自定义端点。卡片列表、启用即绑定、新建/编辑子页、测连、
复制、从原生配置或 CC Switch 导入。接入方式对齐该 Agent 已适配的原生字段；
CC Switch 覆盖的 Claude Code、Codex、Gemini/Antigravity、OpenCode、OpenClaw、
Hermes 按各自原生存储投影。不搬协议转换代理、不搬 ChatGPT→Claude 反向代理。

## 组合由档案声明

DeepSeek Harness 没有官方订阅，只出现官方 API 与供应商。Cursor 官方 API 不接受
自定义 Base URL，因此没有供应商。OpenClaw 没有独立的第一方模型套餐，鉴权落在
Gateway 供应商上。缺能力不能用邻近模式顶上。

## 为何分开官方 API 与供应商

当前 Claude「自定义端点」、Codex「OpenAI API Key」、Grok「xAI API Key / 自定义」、
DeepSeek「DeepSeek / 自定义」、OpenCode 整页 Provider 连接把第一方 Key 和中转
端点写在同一套表单里。官方 API 的 URL 锁定、模型列表来自官方目录；供应商的
URL 用户可写、模型来自探测。不分开，用户无法判断自己在配哪一种。
