---
summary: 在新建供应商表单中提供按 Agent 分组的预置模板。
---

# ProviderSwitch

启用后，设置 → Agent → 鉴权 → 供应商的新建表单会列出按 Agent 整理的预置端点。点选只填名称、地址和模型；密钥仍由你填写。保存和启用还是 VibeX 自己的供应商流程。

OpenCode / MiMo 不会另开网格：预置会出现在现有 `models.dev` 列表后面，来源标成插件名。

## 使用

1. 在设置 → 插件里启用 ProviderSwitch。
2. 打开设置 → Agent → 对应 Agent → 鉴权 → 供应商，进入新建。
3. 点选预置，补上 API Key，保存。

目录是静态 JSON，不访问网络。预置来自 CC-Switch MIT 快照，见 `THIRD_PARTY_NOTICES.md`。

## 卸载

禁用或卸载后，预置从新建表单消失；已经保存的供应商和绑定不受影响。卸载不会删除本开发目录。
