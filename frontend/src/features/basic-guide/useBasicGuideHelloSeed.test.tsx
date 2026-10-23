import { render } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';

import {
  BasicGuideContext,
  type BasicGuideContextValue,
} from './BasicGuideContext';
import { useBasicGuideHelloSeed } from './useBasicGuideHelloSeed';

function Harness({
  value,
  onChange,
}: {
  value: string;
  onChange: (next: string) => void;
}) {
  useBasicGuideHelloSeed(value, onChange);
  return null;
}

function renderSeed(
  substep: string,
  value: string,
  onChange: (next: string) => void
) {
  const ctx = {
    state: {
      phase: 'active',
      reachedStep: 1,
      substep,
      endCopy: 'none',
    },
    continueStep: vi.fn(),
    requestExit: vi.fn(),
    confirmExit: vi.fn(),
    cancelExit: vi.fn(),
    finish: vi.fn(),
    restart: vi.fn(),
    start: vi.fn(),
    skip: vi.fn(),
    dismissEnd: vi.fn(),
    exitOpen: false,
  } as unknown as BasicGuideContextValue;
  return render(
    <BasicGuideContext.Provider value={ctx}>
      <Harness value={value} onChange={onChange} />
    </BasicGuideContext.Provider>
  );
}

describe('useBasicGuideHelloSeed', () => {
  it('fills an empty composer with 你好 on the send step', () => {
    const onChange = vi.fn();
    renderSeed('send-hello', '', onChange);
    expect(onChange).toHaveBeenCalledWith('你好');
  });

  it('does not overwrite a draft the user already typed', () => {
    const onChange = vi.fn();
    renderSeed('send-hello', '帮我看这个文件', onChange);
    expect(onChange).not.toHaveBeenCalled();
  });
});
