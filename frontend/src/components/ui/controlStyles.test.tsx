import { render, screen } from '@testing-library/react';
import { describe, expect, it } from 'vitest';

import { Button } from './button';
import { Select, SelectTrigger, SelectValue } from './select';

describe('shared raised controls', () => {
  it.each(['outline', 'secondary'] as const)(
    'gives the %s button the standard raised surface',
    (variant) => {
      render(<Button variant={variant}>Action</Button>);

      const className = screen.getByRole('button', {
        name: 'Action',
      }).className;
      expect(className).toContain('rounded-lg');
      expect(className).toContain('raised-control');
    }
  );

  it('gives select triggers the same raised surface', () => {
    render(
      <Select defaultValue="main">
        <SelectTrigger aria-label="Branch">
          <SelectValue />
        </SelectTrigger>
      </Select>
    );

    const className = screen.getByRole('combobox', {
      name: 'Branch',
    }).className;
    expect(className).toContain('raised-control');
  });
});
