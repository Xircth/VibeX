# 热门技能一键配置 - 实现计划

## 概述

在 SkillsSettings 页面添加"热门技能"轮播区域，用户点击即可一键安装预配置的 Claude Code 技能到 `~/.claude/skills/` 目录。

## 架构设计

### 数据流

```
default_skills.json (预配置技能列表)
    │
    ▼
Rust: include_str! → LazyLock<Value>
    │
    ▼
Tauri Command: get_popular_skills() → Vec<PopularSkill>
    │
    ▼
Tauri Command: install_skill(key) → 写入 ~/.claude/skills/{key}/SKILL.md
    │
    ▼
Tauri Command: uninstall_skill(key) → 删除 ~/.claude/skills/{key}/
    │
    ▼
前端: SkillsSettings.tsx → 轮播卡片 + 安装/卸载按钮
```

## 分步实现

### Phase 1: 后端 - 预配置数据与 API

**1.1 创建 `crates/executors/default_skills.json`**

```json
{
  "skills": {
    "code-review-pro": {
      "name": "Code Review Pro",
      "description": "专业代码审查，检测安全漏洞、性能问题和最佳实践",
      "category": "quality",
      "icon": "shield-check",
      "tags": ["review", "security", "quality"],
      "content": "---\ndescription: ...\n---\n技能内容..."
    }
  }
}
```

**1.2 创建 Rust 类型 `crates/api-types/src/skill.rs`**

```rust
#[derive(Debug, Clone, Serialize, Deserialize, TS)]
pub struct PopularSkill {
    pub key: String,
    pub name: String,
    pub description: String,
    pub category: String,
    pub icon: String,
    pub tags: Vec<String>,
    pub installed: bool,
}
```

**1.3 创建 Tauri Commands `src-tauri/src/commands/skills.rs`**

- `get_popular_skills()` → 读取预配置列表 + 检查已安装状态
- `install_skill(key)` → 从预配置中取出内容，写入 `~/.claude/skills/{key}/SKILL.md`
- `uninstall_skill(key)` → 删除 `~/.claude/skills/{key}/` 目录

**1.4 注册命令到 `src-tauri/src/lib.rs`**

### Phase 2: 前端 - API 封装

**2.1 在 `frontend/src/lib/api.ts` 添加**

```typescript
export const skillsApi = {
  getPopular: () => tauriInvoke<PopularSkill[]>('get_popular_skills'),
  install: (key: string) => tauriInvoke<void>('install_skill', { key }),
  uninstall: (key: string) => tauriInvoke<void>('uninstall_skill', { key }),
}
```

### Phase 3: 前端 - UI 实现

**3.1 在 SkillsSettings.tsx 添加热门技能轮播**

- 复用 MCP 页面的 Carousel 模式
- 卡片显示：图标、名称、描述、分类标签
- 安装状态指示：已安装（绿色勾）/ 未安装（安装按钮）
- 点击安装后自动刷新命令列表

### Phase 4: 类型生成与集成

**4.1 运行 `cargo run --bin generate-types` 更新 shared/types.ts**
**4.2 端到端测试验证**

## 预配置技能清单（初始版本）

| Key | 名称 | 分类 | 说明 |
|-----|------|------|------|
| `code-review-pro` | Code Review Pro | quality | 专业代码审查 |
| `git-commit-helper` | Git Commit Helper | git | 智能提交信息生成 |
| `test-generator` | Test Generator | testing | 自动生成测试用例 |
| `refactor-advisor` | Refactor Advisor | quality | 重构建议与执行 |
| `doc-writer` | Doc Writer | docs | 自动文档生成 |
| `perf-optimizer` | Perf Optimizer | performance | 性能优化建议 |
| `security-scanner` | Security Scanner | security | 安全漏洞扫描 |
| `api-designer` | API Designer | architecture | REST/GraphQL API 设计 |

## 文件变更清单

| 操作 | 文件 | 说明 |
|------|------|------|
| 新建 | `crates/executors/default_skills.json` | 预配置技能数据 |
| 新建 | `crates/api-types/src/skill.rs` | PopularSkill 类型 |
| 修改 | `crates/api-types/src/lib.rs` | 导出 skill 模块 |
| 新建 | `src-tauri/src/commands/skills.rs` | 3 个 Tauri 命令 |
| 修改 | `src-tauri/src/commands/mod.rs` | 导出 skills 模块 |
| 修改 | `src-tauri/src/lib.rs` | 注册新命令 |
| 修改 | `frontend/src/lib/api.ts` | skillsApi 封装 |
| 修改 | `frontend/src/pages/settings/SkillsSettings.tsx` | 热门技能 UI |
| 自动 | `shared/types.ts` | 类型生成 |

## 风险与注意事项

1. **文件权限**: Windows 上 `~/.claude/skills/` 可能不存在，需自动创建
2. **代理兼容性**: 初始版本仅支持 Claude Code 的技能格式
3. **技能内容质量**: 预配置技能内容需精心编写，确保实用性
4. **刷新机制**: 安装后需触发命令重新发现（重新订阅 stream）
