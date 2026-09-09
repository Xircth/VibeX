import { useState } from 'react';
import { fireEvent, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { clearLocalStorageCache } from '@/lib/safeStorage';
import { BrowserAddressField } from './BrowserAddressField';
import { recordBrowserAddress } from './browserAddressHistory';

function Field({ onSubmit }: { onSubmit: (value: string) => void }) {
  const [value, setValue] = useState('');
  return (
    <BrowserAddressField
      value={value}
      onValueChange={setValue}
      onSubmit={onSubmit}
    />
  );
}

describe('BrowserAddressField', () => {
  afterEach(() => {
    window.localStorage.clear();
    clearLocalStorageCache();
  });

  it('filters address history as the user types', () => {
    recordBrowserAddress('https://www.baidu.com/');
    recordBrowserAddress('https://github.com/vibex');
    const onSubmit = vi.fn();
    render(<Field onSubmit={onSubmit} />);

    const address = screen.getByRole('combobox', { name: 'Address' });
    fireEvent.focus(address);
    expect(
      screen.getByRole('option', { name: 'https://www.baidu.com/' })
    ).toBeVisible();
    expect(
      screen.getByRole('option', { name: 'https://github.com/vibex' })
    ).toBeVisible();

    fireEvent.change(address, { target: { value: 'bai' } });
    expect(
      screen.getByRole('option', { name: 'https://www.baidu.com/' })
    ).toBeVisible();
    expect(
      screen.queryByRole('option', { name: 'https://github.com/vibex' })
    ).not.toBeInTheDocument();

    fireEvent.click(
      screen.getByRole('option', { name: 'https://www.baidu.com/' })
    );
    expect(onSubmit).toHaveBeenCalledWith('https://www.baidu.com/');
  });
});
