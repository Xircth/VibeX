# 非 Git 项目与项目树

把「项目」从「必须是 Git 仓库」改成「一个根目录」，并在管理面上用树表达从属关系。会话工作目录始终是当前项目根，树不参与运行。

| 文件 | 内容 |
|---|---|
| [requirements.md](./requirements.md) | 已锁定的产品规则、非目标、验收 |
| [design.md](./design.md) | 数据/运行时设计，以及前端视觉与交互（Tahoe + shadcn） |
| [tasks.md](./tasks.md) | 分阶段实施计划 |

状态：草案，待实现。第一期不做无关目录成组、通用树编辑、把子仓写回父项目的 `project_repos`。
