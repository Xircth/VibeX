import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it, vi } from 'vitest';
import type {
  AgentNativeConfigFieldView,
  AgentNativeConfigOptionView,
} from 'shared/types';

import { pickAstryxOption } from './agentSettingsTestUtils';
import {
  CodexQuickSettings,
  fillGridRows,
  layoutConfigFields,
} from './CodexQuickSettings';

function selectField(
  id: string,
  label: string,
  options: AgentNativeConfigOptionView[],
  value: string | null
): AgentNativeConfigFieldView {
  return {
    id,
    label,
    description: '',
    kind: 'select',
    options,
    secret: false,
    path: '/Users/example/.codex/config.toml',
    present: true,
    value,
    masked_value: null,
    revision: `${id}-revision`,
    surface: 'configuration',
  };
}

function booleanField(
  id: string,
  label: string,
  value: string | null
): AgentNativeConfigFieldView {
  return {
    id,
    label,
    description: '',
    kind: 'boolean',
    options: [],
    secret: false,
    path: '/Users/example/.codex/config.toml',
    present: true,
    value,
    masked_value: null,
    revision: `${id}-revision`,
    surface: 'configuration',
  };
}

describe('fillGridRows', () => {
  it('spans the last compact field when the row would be empty', () => {
    const layout = fillGridRows([
      selectField('a', 'A', [], 'a'),
      selectField('b', 'B', [], 'b'),
      selectField('c', 'C', [], 'c'),
    ]);
    expect(layout.map((item) => [item.field.id, item.fill])).toEqual([
      ['a', false],
      ['b', false],
      ['c', true],
    ]);
  });
});

describe('layoutConfigFields', () => {
  it('keeps every compact field half-width so later fields pack the hole', () => {
    const layout = layoutConfigFields([
      selectField('permission_mode', '默认权限模式', [], 'default'),
      selectField('effort_level', '推理强度', [], 'medium'),
      booleanField('include_co_authored_by', '提交署名', 'true'),
      selectField('auto_updates_channel', '更新通道', [], 'latest'),
      booleanField(
        'claude_disable_nonessential_traffic',
        '禁用非必要流量',
        'false'
      ),
      booleanField('claude_send_attribution_header', '发送归因请求头', 'true'),
    ]);
    expect(layout.map((item) => [item.field.id, item.fill])).toEqual([
      ['permission_mode', false],
      ['effort_level', false],
      ['auto_updates_channel', false],
      ['include_co_authored_by', false],
      ['claude_disable_nonessential_traffic', false],
      ['claude_send_attribution_header', false],
    ]);
  });
});

describe('CodexQuickSettings', () => {
  it('renders quick selects and toggles and projects changes into drafts', async () => {
    const onChange = vi.fn();
    render(
      <CodexQuickSettings
        fields={[
          selectField(
            'codex_reasoning_effort',
            '推理强度',
            [
              { value: 'medium', label: '中' },
              { value: 'high', label: '高' },
            ],
            'medium'
          ),
          selectField(
            'codex_sandbox_mode',
            '文件访问',
            [
              { value: 'read-only', label: '只读' },
              { value: 'workspace-write', label: '工作区可写' },
            ],
            'read-only'
          ),
          booleanField('codex_network_access', '沙箱网络访问', 'false'),
        ]}
        drafts={{
          codex_reasoning_effort: 'medium',
          codex_sandbox_mode: 'read-only',
          codex_network_access: 'false',
        }}
        disabled={false}
        onChange={onChange}
      />
    );

    await pickAstryxOption(userEvent, screen.getByLabelText('推理强度'), '高');
    expect(onChange).toHaveBeenCalledWith('codex_reasoning_effort', 'high');

    await pickAstryxOption(
      userEvent,
      screen.getByLabelText('文件访问'),
      '工作区可写'
    );
    expect(onChange).toHaveBeenCalledWith(
      'codex_sandbox_mode',
      'workspace-write'
    );

    await userEvent.click(screen.getByLabelText('沙箱网络访问'));
    expect(onChange).toHaveBeenCalledWith('codex_network_access', 'true');
  });

  it('does not stretch the last compact field across the leftover cell', () => {
    render(
      <CodexQuickSettings
        fields={[
          selectField(
            'effort_level',
            '推理强度',
            [{ value: 'high', label: '高' }],
            'high'
          ),
          selectField(
            'permission_mode',
            '默认权限模式',
            [{ value: 'default', label: '默认询问' }],
            'default'
          ),
          selectField(
            'auto_updates_channel',
            '更新通道',
            [{ value: 'stable', label: '稳定版' }],
            'stable'
          ),
        ]}
        drafts={{
          effort_level: 'high',
          permission_mode: 'default',
          auto_updates_channel: 'stable',
        }}
        disabled={false}
        onChange={vi.fn()}
      />
    );
    expect(
      screen.getByLabelText('更新通道').closest('.agent-codex-quick-field')
    ).not.toHaveClass('is-wide');
  });

  it('renders remaining fields in the same card', () => {
    render(
      <CodexQuickSettings
        fields={[selectField('codex_service_tier', '服务等级', [], 'fast')]}
        drafts={{ codex_service_tier: 'fast' }}
        disabled={false}
        onChange={vi.fn()}
      />
    );
    expect(screen.getByLabelText('服务等级')).toBeVisible();
  });
});
