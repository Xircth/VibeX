import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it, vi } from 'vitest';
import type {
  AgentNativeConfigFieldView,
  AgentNativeConfigOptionView,
} from 'shared/types';

import { pickAstryxOption } from './agentSettingsTestUtils';
import { CodexQuickSettings } from './CodexQuickSettings';

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
  };
}

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
          booleanField('codex_skills', 'Skills', 'true'),
          booleanField('codex_network_access', '沙箱网络访问', 'false'),
        ]}
        drafts={{
          codex_reasoning_effort: 'medium',
          codex_sandbox_mode: 'read-only',
          codex_skills: 'true',
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

    await userEvent.click(screen.getByLabelText('Skills'));
    expect(onChange).toHaveBeenCalledWith('codex_skills', 'false');

    await userEvent.click(screen.getByLabelText('沙箱网络访问'));
    expect(onChange).toHaveBeenCalledWith('codex_network_access', 'true');
  });

  it('renders nothing when no quick fields are present', () => {
    const { container } = render(
      <CodexQuickSettings
        fields={[selectField('codex_model', '模型', [], 'gpt-5.4')]}
        drafts={{}}
        disabled={false}
        onChange={vi.fn()}
      />
    );
    expect(container.firstChild).toBeNull();
  });
});
