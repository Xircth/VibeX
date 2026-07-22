import i18n from '@/i18n';
import { ShowcaseConfig } from '@/types/showcase';

// Built lazily so titles/descriptions reflect the current UI language at call
// time (i18n.t must run inside a function, not at module-load const init).
export function getShowcases(): { taskPanel: ShowcaseConfig } {
  return {
    taskPanel: {
      id: 'task-panel-onboarding',
      stages: [
        {
          title: i18n.t('app:showcases.taskPanel.codeReview.title'),
          description: i18n.t('app:showcases.taskPanel.codeReview.description'),
          media: {
            type: 'video',
            src: 'https://vkcdn.britannio.dev/showcase/flat-task-panel/vk-onb-code-review-3.mp4',
          },
        },
        {
          title: i18n.t('app:showcases.taskPanel.createPr.title'),
          description: i18n.t('app:showcases.taskPanel.createPr.description'),
          media: {
            type: 'video',
            src: 'https://vkcdn.britannio.dev/showcase/flat-task-panel/vk-onb-git-pr-3.mp4',
          },
        },
        {
          title: i18n.t('app:showcases.taskPanel.tagPrompts.title'),
          description: i18n.t('app:showcases.taskPanel.tagPrompts.description'),
          media: {
            type: 'video',
            src: 'https://vkcdn.britannio.dev/showcase/flat-task-panel/vk-tags.mp4',
          },
        },
      ],
    } satisfies ShowcaseConfig,
  };
}
