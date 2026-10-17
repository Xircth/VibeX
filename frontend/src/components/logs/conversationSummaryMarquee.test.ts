import { describe, expect, it } from 'vitest';
import {
  conversationSummaryLabel,
  summaryMarqueeDurationMs,
} from './conversationSummaryMarquee';

describe('conversation summary marquee', () => {
  it('scrolls long summaries slowly enough to read and snaps short ones', () => {
    expect(summaryMarqueeDurationMs(0)).toBe(0);
    expect(summaryMarqueeDurationMs(18)).toBe(800);
    expect(summaryMarqueeDurationMs(36)).toBe(1000);
    expect(summaryMarqueeDurationMs(36 * 20)).toBe(8000);
  });

  it('finds the grouped tool summary and the mixed activity summary', () => {
    const root = document.createElement('div');
    root.innerHTML = [
      '<div class="vibex-tool-call-batch">',
      '<div role="button">',
      '<span>wrench</span>',
      '<span>已读 10 个文件、完成 1 次搜索、1 次其他工具调用</span>',
      '<span></span>',
      '<span>chevron</span>',
      '</div>',
      '</div>',
      '<button type="button" class="conv-activity-header">',
      '<svg></svg>',
      '<span>已读 2 个文件、运行 1 个命令</span>',
      '</button>',
    ].join('');

    const batchLabel = root.querySelector(
      '.vibex-tool-call-batch [role="button"] span'
    );
    const activityIcon = root.querySelector('.conv-activity-header svg');

    expect(conversationSummaryLabel(batchLabel)?.textContent).toBe(
      '已读 10 个文件、完成 1 次搜索、1 次其他工具调用'
    );
    expect(conversationSummaryLabel(activityIcon)?.textContent).toBe(
      '已读 2 个文件、运行 1 个命令'
    );
    expect(conversationSummaryLabel(root)).toBeNull();
  });
});
