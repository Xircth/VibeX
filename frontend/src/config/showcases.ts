import { ShowcaseConfig } from '@/types/showcase';

export const showcases = {
  taskPanel: {
    id: 'task-panel-onboarding',
    stages: [
      {
        title: 'VibeX Companion 点击能力',
        description:
          '在预览页面中启用点击组件定位，帮助 Agent 更快理解当前 UI 与源代码之间的关系。',
        media: {
          type: 'video',
          src: 'https://vkcdn.britannio.dev/showcase/flat-task-panel/vk-onb-companion-demo-3.mp4',
        },
      },
      {
        title: '为开发服务器安装 Companion',
        description:
          '当项目已配置开发服务器时，可以自动安装并接入 VibeX Web Companion。',
        media: {
          type: 'video',
          src: 'https://vkcdn.britannio.dev/showcase/flat-task-panel/vk-onb-install-companion-3.mp4',
        },
      },
      {
        title: '查看代码审查反馈',
        description:
          '在任务面板中集中查看代码审查结果，并根据反馈继续调整实现。',
        media: {
          type: 'video',
          src: 'https://vkcdn.britannio.dev/showcase/flat-task-panel/vk-onb-code-review-3.mp4',
        },
      },
      {
        title: '从 Git 变更创建 PR',
        description:
          '结合当前工作区变更生成提交与 PR 描述，减少手动整理上下文的成本。',
        media: {
          type: 'video',
          src: 'https://vkcdn.britannio.dev/showcase/flat-task-panel/vk-onb-git-pr-3.mp4',
        },
      },
      {
        title: '复用标签提示词',
        description: '保存常用提示词片段，并通过标签快速插入到任务输入中。',
        media: {
          type: 'video',
          src: 'https://vkcdn.britannio.dev/showcase/flat-task-panel/vk-tags.mp4',
        },
      },
    ],
  } satisfies ShowcaseConfig,
} as const;
