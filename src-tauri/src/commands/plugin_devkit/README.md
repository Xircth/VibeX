# VibeX 插件开发套件

把一个「Skill + Web 控制台」型项目接入 VibeX 所需的全部材料。

```
vibex-plugin-devkit/
├── README.md                              # 本文件
├── skills/vibex-plugin-packager/
│   ├── SKILL.md                           # 给 Agent 的打包技能（工作流程）
│   └── references/
│       ├── plugin-spec.md                 # 插件规范 v1（字段/占位符/激活契约）
│       └── examples/                      # 三个真实项目的 manifest 示例
│           ├── dashi-ppt.vibex-plugin.json
│           ├── vibe-motion.vibex-plugin.json
│           └── understand-anything.vibex-plugin.json
└── test/
    └── test-plugin.mjs                    # 可用性测试程序（零依赖，Node ≥ 18）
```

## 快速开始

1. **把打包技能装给你的 Agent**（二选一）：
   - 直接复制：`cp -r skills/vibex-plugin-packager ~/.claude/skills/`
     （Codex/Cursor 等用 `~/.agents/skills/`）；
   - 或将本套件放进你的 GitHub 仓库后 `npx skills add <owner>/<repo>`。
2. **让 Agent 打包**：对 Agent 说「把 xxx 打包成 VibeX 插件」，它会按
   SKILL.md 的流程调研目标项目、产出 `vibex-plugin.json` 并自行运行测试。
3. **验证**（Agent 会做，你也可以手动跑）：
   ```bash
   node test/test-plugin.mjs vibex-plugin.json              # 校验 + 真实拉起控制台探活
   node test/test-plugin.mjs vibex-plugin.json --run-install  # 连安装命令一起真实执行
   ```
4. **导入 VibeX**：设置 → 插件 → 导入 manifest，选择 `vibex-plugin.json`，
   核对表单后保存（保存时会自动全局安装 skill）。

## 你需要提供的完整信息

| 字段 | 必填 | 说明 |
|---|---|---|
| `name` | ✅ | 插件显示名 |
| `skill_name` | ✅ | Skill 名称 |
| `install_command` | ✅ | 全局安装 skill 的命令（`skills add` 自动补 `-y`） |
| `console_command` | ✅ | 控制台启动参考命令（交给 Agent 执行，支持 `{{port}}`） |
| `console_url` | 建议 | 控制台地址模板（支持 `{{port}}`；配置后才能自动打开预览） |
| `hook_message` | ✅ | 激活时预填进会话的 Hook 模板 |
| `author` / `icon` / `expires_at` / `notes` | ⬜ | 作者 / 图标（emoji 或 ≤200KB data URL）/ 有效期 / 备注 |

完整规范见 `skills/vibex-plugin-packager/references/plugin-spec.md`。
