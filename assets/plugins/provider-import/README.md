---
summary: 把已经导出到环境变量里的 OpenAI 兼容供应商，一次性导入 VibeX 的 Model Provider 预设。
---

# 环境变量供应商导入

如果你已经为终端里的其它工具导出过 `OPENAI_API_KEY`、`ANTHROPIC_BASE_URL`、`DEEPSEEK_API_KEY` 这类变量，这个插件让你不必再把同样的地址和密钥往 VibeX 里抄一遍。

在 **设置 → Agent → Model Provider** 的「导入」菜单里会多出一项「从环境变量导入」。它列出在你环境里找到的供应商，你勾选哪些就导入哪些。

## 它会读哪些变量

| 供应商 | 地址 | 密钥 | 模型 |
| --- | --- | --- | --- |
| OpenAI | `OPENAI_BASE_URL` / `OPENAI_API_BASE` | `OPENAI_API_KEY` | `OPENAI_MODEL` |
| Anthropic | `ANTHROPIC_BASE_URL` | `ANTHROPIC_AUTH_TOKEN` / `ANTHROPIC_API_KEY` | `ANTHROPIC_MODEL` |
| DeepSeek | `DEEPSEEK_BASE_URL` | `DEEPSEEK_API_KEY` | `DEEPSEEK_MODEL` |
| Moonshot | `MOONSHOT_BASE_URL` | `MOONSHOT_API_KEY` | `MOONSHOT_MODEL` |
| OpenRouter | `OPENROUTER_BASE_URL` | `OPENROUTER_API_KEY` | `OPENROUTER_MODEL` |

只设了密钥没设地址时，用该供应商的官方地址补齐。反过来只设了地址没设密钥的，会列出来但不能勾选，让你知道它被看见了、缺的是什么。两者都没设的供应商不会出现——插件不会凭空造出一个你没配过的服务商。

## 导入不等于启用

导入只是把这些供应商存成预设。哪个 Agent 用哪个预设，仍然由你在 Model Provider 页面自己绑定。

## 开发

```bash
pnpm run build
pnpm run validate
pnpm test
```
