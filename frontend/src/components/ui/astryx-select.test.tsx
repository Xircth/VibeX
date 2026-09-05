import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it, vi } from 'vitest';

import { AstryxSelect } from './astryx-select';

const options = [
  { value: 'low', label: 'Low' },
  { value: 'medium', label: 'Medium' },
  { value: 'high', label: 'High' },
];

describe('AstryxSelect', () => {
  it('shows the placeholder when no value is selected', () => {
    render(
      <AstryxSelect
        ariaLabel="Effort"
        placeholder="未设置"
        value=""
        options={options}
        onChange={vi.fn()}
      />
    );
    const trigger = screen.getByLabelText('Effort');
    expect(trigger).toHaveTextContent('未设置');
    expect(trigger).toHaveAttribute('aria-haspopup', 'listbox');
    expect(trigger).toHaveAttribute('aria-expanded', 'false');
  });

  it('notifies when the listbox opens', async () => {
    const onOpenChange = vi.fn();
    const user = userEvent.setup();
    render(
      <AstryxSelect
        ariaLabel="Effort"
        value=""
        options={options}
        onChange={vi.fn()}
        onOpenChange={onOpenChange}
      />
    );
    await user.click(screen.getByLabelText('Effort'));
    expect(onOpenChange).toHaveBeenCalledWith(true);
  });

  it('opens the listbox and selects an option on click', async () => {
    const onChange = vi.fn();
    const user = userEvent.setup();
    render(
      <AstryxSelect
        ariaLabel="Effort"
        value=""
        options={options}
        onChange={onChange}
      />
    );
    const trigger = screen.getByLabelText('Effort');
    await user.click(trigger);
    expect(trigger).toHaveAttribute('aria-expanded', 'true');
    await user.click(screen.getByRole('option', { name: 'High' }));
    expect(onChange).toHaveBeenCalledWith('high');
    expect(trigger).toHaveAttribute('aria-expanded', 'false');
  });

  it('highlights the selected value and supports keyboard selection', async () => {
    const onChange = vi.fn();
    const user = userEvent.setup();
    render(
      <AstryxSelect
        ariaLabel="Effort"
        value="medium"
        options={options}
        onChange={onChange}
      />
    );
    const trigger = screen.getByLabelText('Effort');
    expect(trigger).toHaveTextContent('Medium');
    trigger.focus();
    await user.keyboard('{ArrowDown}');
    await user.keyboard('{Enter}');
    expect(onChange).toHaveBeenCalledWith('high');
  });

  it('clears the selection through the clear button', async () => {
    const onChange = vi.fn();
    const user = userEvent.setup();
    render(
      <AstryxSelect
        ariaLabel="Effort"
        hasClear
        value="low"
        options={options}
        onChange={onChange}
      />
    );
    await user.click(screen.getByLabelText('Effort（清除）'));
    expect(onChange).toHaveBeenCalledWith('');
  });

  it('disables the trigger when disabled', async () => {
    const onChange = vi.fn();
    const user = userEvent.setup();
    render(
      <AstryxSelect
        ariaLabel="Effort"
        disabled
        value=""
        options={options}
        onChange={onChange}
      />
    );
    const trigger = screen.getByLabelText('Effort');
    expect(trigger).toHaveAttribute('aria-disabled', 'true');
    await user.click(trigger);
    expect(screen.queryByRole('listbox')).not.toBeInTheDocument();
    expect(onChange).not.toHaveBeenCalled();
  });

  it('does not treat a wrapping label as part of the trigger area', async () => {
    const onChange = vi.fn();
    const user = userEvent.setup();
    render(
      <label>
        Effort
        <AstryxSelect
          ariaLabel="Effort"
          value=""
          options={options}
          onChange={onChange}
        />
      </label>
    );
    // Clicking the label text must not open the listbox.
    await user.click(screen.getByText('Effort'));
    expect(screen.queryByRole('listbox')).not.toBeInTheDocument();
    // Opening via the trigger itself still works, and clicking the label text
    // while open must close it without the forwarded click reopening it.
    await user.click(screen.getByLabelText('Effort'));
    expect(screen.getByRole('listbox')).toBeInTheDocument();
    await user.click(screen.getByText('Effort'));
    expect(screen.queryByRole('listbox')).not.toBeInTheDocument();
  });

  it('closes the listbox when clicking outside', async () => {
    const user = userEvent.setup();
    render(
      <div>
        <button type="button">Outside</button>
        <AstryxSelect
          ariaLabel="Effort"
          value=""
          options={options}
          onChange={vi.fn()}
        />
      </div>
    );
    const trigger = screen.getByLabelText('Effort');
    await user.click(trigger);
    expect(screen.getByRole('listbox')).toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: 'Outside' }));
    expect(screen.queryByRole('listbox')).not.toBeInTheDocument();
  });

  it('renders a per-option trailing action without selecting the option', async () => {
    const onChange = vi.fn();
    const user = userEvent.setup();
    render(
      <AstryxSelect
        ariaLabel="Effort"
        placeholder="未设置"
        value=""
        options={options}
        onChange={onChange}
        renderOptionAction={(option) => (
          <button type="button" aria-label={`删除 ${option.label}`}>
            删除
          </button>
        )}
      />
    );
    const trigger = screen.getByLabelText('Effort');
    await user.click(trigger);
    await user.click(screen.getByRole('button', { name: '删除 High' }));
    expect(onChange).not.toHaveBeenCalled();
    // The action click also closes the listbox without selecting the option.
    expect(screen.queryByRole('listbox')).not.toBeInTheDocument();
    expect(trigger).toHaveTextContent('未设置');
  });

  it('closes the listbox with Escape while focus is inside an option action', async () => {
    const user = userEvent.setup();
    render(
      <AstryxSelect
        ariaLabel="Effort"
        value=""
        options={options}
        onChange={vi.fn()}
        renderOptionAction={() => (
          <button type="button" aria-label="操作">
            操作
          </button>
        )}
      />
    );
    const trigger = screen.getByLabelText('Effort');
    await user.click(trigger);
    await user.tab();
    await user.keyboard('{Escape}');
    expect(screen.queryByRole('listbox')).not.toBeInTheDocument();
    expect(trigger).toHaveFocus();
  });
});
