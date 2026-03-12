import { ShowcaseConfig } from '@/types/showcase';

export const showcases = {
  taskPanel: {
    id: 'task-panel-onboarding',
    stages: [
      {
        title: 'VibeUltra Companion 点选功能',
        description:
          '点击预览窗口中的任何 UI 组件以精确选择它。编码代理接收确切的 DOM 选择器和组件层次结构，消除模糊的反馈。',
        media: {
          type: 'video',
          src: 'https://vkcdn.britannio.dev/showcase/flat-task-panel/vk-onb-companion-demo-3.mp4',
        },
      },
      {
        title: '开发服务器和 Companion 安装',
        description:
          '为预览设置开发服务器命令，在设置中可配置设置脚本。使用编码代理自动安装 VibeUltra Web Companion。',
        media: {
          type: 'video',
          src: 'https://vkcdn.britannio.dev/showcase/flat-task-panel/vk-onb-install-companion-3.mp4',
        },
      },
      {
        title: '内置代码审查',
        description:
          '使用加号图标直接在差异视图中添加特定行的评论。所有反馈都被收集并作为完整审查发送给编码代理。',
        media: {
          type: 'video',
          src: 'https://vkcdn.britannio.dev/showcase/flat-task-panel/vk-onb-code-review-3.mp4',
        },
      },
      {
        title: '从任务创建 PR',
        description:
          '直接从任务尝试合并您的更改或创建拉取请求。PR 对话框会从您的任务详情预填充标题和描述，以简化工作流程。',
        media: {
          type: 'video',
          src: 'https://vkcdn.britannio.dev/showcase/flat-task-panel/vk-onb-git-pr-3.mp4',
        },
      },
      {
        title: '自定义提示标签',
        description:
          '将自定义提示保存为标签，并将其嵌入到新任务或后续消息中。重用常见说明以保持工作流程的一致性。',
        media: {
          type: 'video',
          src: 'https://vkcdn.britannio.dev/showcase/flat-task-panel/vk-tags.mp4',
        },
      },
    ],
  } satisfies ShowcaseConfig,
} as const;
