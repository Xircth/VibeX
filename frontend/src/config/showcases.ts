import { ShowcaseConfig } from '@/types/showcase';

export const showcases = {
  taskPanel: {
    id: 'task-panel-onboarding',
    stages: [
      {
        title: 'VibeUltra Companion 点选能力',
        description:
          '在预览窗口中直接点击任意 UI 元素即可精准选中。编码代理会拿到明确的 DOM 选择器和组件层级，避免模糊反馈。',
        media: {
          type: 'video',
          src: 'https://vkcdn.britannio.dev/showcase/flat-task-panel/vk-onb-companion-demo-3.mp4',
        },
      },
      {
        title: '开发服务与 Companion 安装',
        description:
          '为预览配置开发服务命令，并在设置中补充所需脚本。编码代理也可以自动安装 VibeUltra Web Companion。',
        media: {
          type: 'video',
          src: 'https://vkcdn.britannio.dev/showcase/flat-task-panel/vk-onb-install-companion-3.mp4',
        },
      },
      {
        title: '内置代码审查',
        description:
          '使用加号图标直接在差异视图中添加行级评论，所有反馈会被整理后一起发送给编码代理。',
        media: {
          type: 'video',
          src: 'https://vkcdn.britannio.dev/showcase/flat-task-panel/vk-onb-code-review-3.mp4',
        },
      },
      {
        title: '从任务直接创建 PR',
        description:
          '可以直接从任务尝试中合并改动或发起拉取请求。PR 对话框会预填任务标题和描述，减少重复输入。',
        media: {
          type: 'video',
          src: 'https://vkcdn.britannio.dev/showcase/flat-task-panel/vk-onb-git-pr-3.mp4',
        },
      },
      {
        title: '自定义提示标签',
        description:
          '把常用提示保存为标签，并快速插入到新任务或后续消息里，保持工作流一致性。',
        media: {
          type: 'video',
          src: 'https://vkcdn.britannio.dev/showcase/flat-task-panel/vk-tags.mp4',
        },
      },
    ],
  } satisfies ShowcaseConfig,
} as const;
