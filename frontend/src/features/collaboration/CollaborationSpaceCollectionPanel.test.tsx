import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import type { IDockviewPanelProps } from 'dockview-react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import {
  CollaborationSpaceCollectionDockviewPanel,
  type SpaceCollectionPanelParams,
} from './CollaborationSpaceCollectionPanel';

const collaborationCall = vi.hoisted(() => vi.fn());

vi.mock('./collaborationApi', () => ({
  COLLABORATION_SPACE_CHANGED_EVENT: 'vibex://collaboration-space-changed',
  collaborationCall,
  listenCollaborationSpaceChanged: vi.fn(async () => () => undefined),
}));

vi.mock('./AssistantDetailsCustomizeTab', () => ({
  AssistantDetailsCustomizeTab: () => <div data-testid="customize-tab" />,
}));

vi.mock('./AssistantDetailsSessionTab', () => ({
  AssistantDetailsSessionTab: () => <div data-testid="session-tab" />,
}));

vi.mock('./GroupDetailsMembersTab', () => ({
  COLLABORATION_MEMBERS_CHANGED_EVENT: 'vibex://collaboration-members-changed',
  GroupDetailsMembersTab: () => <div data-testid="members-tab" />,
}));

vi.mock('./GroupDetailsUsageTab', () => ({
  GroupDetailsUsageTab: () => <div data-testid="usage-tab" />,
}));

const openFilePreviewMock = vi.hoisted(() => vi.fn(() => 'opened' as const));

vi.mock('@/contexts/PanelActionsContext', () => ({
  useOptionalPanelActionsContext: () => ({
    openFilePreview: openFilePreviewMock,
  }),
}));

function renderPanel(overrides: Partial<SpaceCollectionPanelParams> = {}) {
  const params: SpaceCollectionPanelParams = {
    spaceId: 's1',
    spaceName: '设计空间',
    variant: 'group',
    ...overrides,
  };
  const props = {
    params,
    api: {} as IDockviewPanelProps<SpaceCollectionPanelParams>['api'],
    containerApi:
      {} as IDockviewPanelProps<SpaceCollectionPanelParams>['containerApi'],
  };
  return render(<CollaborationSpaceCollectionDockviewPanel {...props} />);
}

describe('CollaborationSpaceCollectionDockviewPanel (Assets: Memory / Topics / Collection)', () => {
  beforeEach(() => {
    collaborationCall.mockReset();
    openFilePreviewMock.mockClear();
    collaborationCall.mockImplementation(
      async (
        _capability: string,
        method: string,
        input?: Record<string, unknown>
      ) => {
        if (method === 'space.listMembers') {
          return { members: [] };
        }
        if (method === 'space.listCollection') {
          return {
            collectionDir: '~/.vibex/spaces/s1/collection',
            items: [
              {
                id: 'col-1',
                kind: 'text',
                name: 'api-spec.md',
                relative_path: 'api-spec.md',
                file_path:
                  'C:/Users/test/.vibex/spaces/s1/collection/api-spec.md',
                text_content:
                  '### 接口规范说明\n\n- 统一使用 **camelCase** 命名字段',
                note: 'API 约定',
                created_at: '2026-10-30T09:00:00Z',
                read_receipts: [],
              },
            ],
          };
        }
        if (method === 'space.memory.view') {
          return {
            summary: {
              charCount: 128,
              budgetChars: 3000,
              updatedAt: '2026-10-30T09:10:00Z',
              sections: [
                {
                  id: 'preferences',
                  title: '协作偏好与规范',
                  items: ['偏好简洁直接的回复风格'],
                },
              ],
            },
            facts: [
              {
                id: 11,
                memberId: 'm1',
                scope: 'thread:s1',
                content: '偏好简洁直接的回复风格',
                origin: 'turn:s1',
                updatedAt: '2026-10-30T09:05:00Z',
              },
            ],
            topics: [
              {
                topic: 'deploy-flow',
                title: '部署流程',
                preview: '先跑 check 再发布到 staging',
                content: '## 部署步骤\n\n1. 先跑 **check** 再发布到 staging',
                charCount: 64,
                updatedAt: '2026-10-30T09:06:00Z',
                filePath:
                  'C:/Users/test/.vibex/spaces/s1/topics/deploy-flow.md',
              },
            ],
            journal: [
              {
                ts: '2026-10-30T09:05:00Z',
                op: 'add',
                scope: 'thread:s1',
                origin: 'turn:s1',
                factId: 11,
                after: '偏好简洁直接的回复风格',
              },
            ],
            excludedCollectionIds: [],
          };
        }
        if (method === 'space.memory.update') {
          return {
            view: {
              facts: [
                {
                  id: input?.factId ?? 11,
                  memberId: 'm1',
                  scope: 'thread:s1',
                  content: String(input?.content ?? ''),
                  origin: 'manual',
                  updatedAt: '2026-10-30T09:15:00Z',
                },
              ],
            },
          };
        }
        if (method === 'space.memory.toggleCollectionIndex') {
          return {
            excludedCollectionIds: ['col-1'],
          };
        }
        return {};
      }
    );
  });

  it('renders Assets tab with SegmentedControl (记忆 / 主题 / 收藏) without noisy pathbar or ask-memory input', async () => {
    const user = userEvent.setup();
    renderPanel();

    // 1. Top tab is renamed to "资产"
    const assetsTab = await screen.findByTestId(
      'collaboration-group-details-tab-collection'
    );
    expect(assetsTab).toHaveTextContent('资产');
    await user.click(assetsTab);

    // No folder path bar or ask-memory bar is rendered
    expect(
      screen.queryByTestId('collaboration-collection-pathbar')
    ).not.toBeInTheDocument();
    expect(
      screen.queryByTestId('collaboration-memory-ask-bar')
    ).not.toBeInTheDocument();

    // 2. SegmentedControl renders 记忆 / 主题 / 收藏 with icons, defaulting to 记忆
    expect(
      screen.getByTestId('collaboration-assets-segmented')
    ).toBeInTheDocument();
    expect(
      screen.getByTestId('collaboration-assets-tab-memory').querySelector('svg')
    ).toBeTruthy();
    expect(
      screen.getByTestId('collaboration-assets-tab-topics').querySelector('svg')
    ).toBeTruthy();
    expect(
      screen
        .getByTestId('collaboration-assets-tab-collection')
        .querySelector('svg')
    ).toBeTruthy();

    // Open add-memory card and verify it is rendered inside the list container
    await user.click(
      screen.getByTestId('collaboration-memory-add-fact-toggle')
    );
    const addFactForm = screen.getByTestId(
      'collaboration-memory-add-fact-form'
    );
    expect(
      screen.getByTestId('collaboration-collection-list')
    ).toContainElement(addFactForm);
    await user.click(
      screen.getByTestId('collaboration-memory-add-fact-toggle')
    );

    expect(screen.getByTestId('collaboration-memory-budget')).toHaveTextContent(
      '128 / 3000'
    );
    expect(
      await screen.findByTestId('collaboration-memory-facts-section')
    ).toBeInTheDocument();
    expect(screen.getByTestId('memory-fact-item-11')).toHaveTextContent(
      '偏好简洁直接的回复风格'
    );

    // Inline edit a fact in 记忆 tab
    await user.click(screen.getByTestId('memory-fact-edit-11'));
    const editInput = screen.getByTestId('memory-fact-edit-input-11');
    await user.clear(editInput);
    await user.type(editInput, '统一使用中文与精炼列表回复');
    await user.click(screen.getByTestId('memory-fact-save-11'));

    await waitFor(() => {
      expect(collaborationCall).toHaveBeenCalledWith(
        'collaboration',
        'space.memory.update',
        expect.objectContaining({
          spaceId: 's1',
          factId: 11,
          content: '统一使用中文与精炼列表回复',
        })
      );
    });

    // Toggle journal view inside 记忆 tab
    await user.click(screen.getByTestId('collaboration-memory-journal-toggle'));
    expect(
      await screen.findByTestId('collaboration-memory-journal-section')
    ).toBeInTheDocument();

    // 3. Switch to 主题 tab
    await user.click(screen.getByTestId('collaboration-assets-tab-topics'));
    expect(
      await screen.findByTestId('collaboration-memory-topics-section')
    ).toBeInTheDocument();
    expect(
      screen.getByTestId('memory-topic-item-deploy-flow')
    ).toHaveTextContent('部署流程');

    // 4. Switch to 收藏 tab
    await user.click(screen.getByTestId('collaboration-assets-tab-collection'));
    expect(
      await screen.findByTestId('collection-item-col-1')
    ).toBeInTheDocument();
    expect(
      screen.getByTestId('collaboration-collection-dropzone')
    ).toBeInTheDocument();

    // Verify Markdown preview view renders formatted HTML instead of raw markdown source
    const previewContainer = screen.getByTestId(
      'collection-item-markdown-preview-col-1'
    );
    expect(previewContainer.querySelector('h3')).toHaveTextContent(
      '接口规范说明'
    );
    expect(previewContainer.querySelector('strong')).toHaveTextContent(
      'camelCase'
    );

    // Verify Open in Tab button is immediately to the left of Copy button and opens file preview tab
    const openTabBtn = screen.getByTestId('collection-item-open-tab-col-1');
    const copyBtn = screen.getByTestId('collection-item-copy-col-1');
    expect(openTabBtn.nextElementSibling).toBe(copyBtn);

    await user.click(openTabBtn);
    expect(openFilePreviewMock).toHaveBeenCalledWith(
      'C:/Users/test/.vibex/spaces/s1/collection/api-spec.md',
      { displayPath: 'api-spec.md' }
    );

    const indexToggle = screen.getByTestId(
      'collection-item-index-toggle-col-1'
    );
    expect(indexToggle).toHaveTextContent('已索引');
    await user.click(indexToggle);
    await waitFor(() => {
      expect(collaborationCall).toHaveBeenCalledWith(
        'collaboration',
        'space.memory.toggleCollectionIndex',
        expect.objectContaining({
          spaceId: 's1',
          itemId: 'col-1',
        })
      );
    });
  });
});
