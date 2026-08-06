import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { useState } from 'react';
import { describe, expect, it, vi } from 'vitest';

import { PiProviderBuilder } from './PiProviderBuilder';

describe('PiProviderBuilder', () => {
  it('edits known fields while preserving Pi provider extensions', async () => {
    const onChange = vi.fn();
    const initial = JSON.stringify({
      local: {
        baseUrl: 'http://localhost:11434',
        api: 'openai-completions',
        models: [{ id: 'qwen3' }],
      },
    });
    function ControlledBuilder() {
      const [value, setValue] = useState(initial);
      return (
        <PiProviderBuilder
          value={value}
          disabled={false}
          onChange={(next) => {
            onChange(next);
            setValue(next);
          }}
        />
      );
    }
    render(<ControlledBuilder />);

    expect(screen.getByText('扩展字段已保留')).toBeInTheDocument();
    await userEvent.clear(screen.getByLabelText('local API URL'));
    await userEvent.type(
      screen.getByLabelText('local API URL'),
      'http://127.0.0.1:11434'
    );
    const last = JSON.parse(onChange.mock.calls.at(-1)?.[0] as string);
    expect(last.local.baseUrl).toBe('http://127.0.0.1:11434');
    expect(last.local.models).toEqual([{ id: 'qwen3' }]);
  });

  it('adds a protocol-safe provider template', async () => {
    const onChange = vi.fn();
    render(
      <PiProviderBuilder value="{}" disabled={false} onChange={onChange} />
    );
    await userEvent.click(
      screen.getByRole('button', { name: '添加 Provider' })
    );
    expect(JSON.parse(onChange.mock.calls[0][0])).toEqual({
      'custom-1': { baseUrl: '', api: 'openai-responses' },
    });
  });
});
