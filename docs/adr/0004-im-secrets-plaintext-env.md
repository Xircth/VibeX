# IM 渠道密钥存明文 ~/.vibex/.env，有意不用系统钥匙串

chat_channel 此前把飞书等 IM 渠道的密钥明文存在命令层自建的 JSON 文件里（绕开 Deployment 分层）。逻辑下沉到 `services::chat_delivery` 时，密钥迁至 `~/.vibex/.env`（文件权限 0600）。这是对"桌面应用密钥应入系统钥匙串"这一常规做法的**有意偏离**——按用户决策明文存储、不加密，换取零依赖、可直接编辑与备份的简单性。

## Consequences

- 收录范围严格限定为 IM 渠道密钥。模型供应商 API key、MCP env 等的既有存放处**保持现状**，不并入 .env。
- 若未来安全要求提高，迁移路径是把 .env 的读取点换成 keyring 后端，改动面限于 chat_delivery 一处。
