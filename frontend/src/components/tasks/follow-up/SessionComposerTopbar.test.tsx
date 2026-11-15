import { fireEvent, render, screen } from '@testing-library/react';
import { describe, expect, it } from 'vitest';

import { TooltipProvider } from '@/components/ui/tooltip';
import { SessionComposerTopbar } from './SessionComposerTopbar';

function renderTopbar(
  props: Partial<Parameters<typeof SessionComposerTopbar>[0]> = {}
) {
  return render(
    <TooltipProvider>
      <SessionComposerTopbar
        executorProfile={null}
        sessionExecutor={null}
        showChangedFileSummary={false}
        changedFileCount={0}
        added={0}
        deleted={0}
        codexGoalState={null}
        tokenUsageInfo={null}
        {...props}
      />
    </TooltipProvider>
  );
}

describe('SessionComposerTopbar', () => {
  it('does not reserve redundant space below the controls', () => {
    const { container } = renderTopbar();

    expect(container.querySelector('.composer-topbar')).toHaveClass('pb-0');
    expect(container.querySelector('.composer-topbar')).not.toHaveClass('pb-2');
  });

  it('renders file summary toggle and omits removed todo, jump, and session selector controls', () => {
    renderTopbar({
      showChangedFileSummary: true,
      changedFileCount: 3,
      added: 12,
      deleted: 4,
    });

    const diffsButton = screen.getByRole('button', { name: '3 CHANGES' });
    expect(diffsButton).toBeInTheDocument();

    fireEvent.click(diffsButton);
    expect(screen.getByText('+12')).toBeInTheDocument();
    expect(screen.getByText('-4')).toBeInTheDocument();

    fireEvent.click(screen.getByText('+12'));
    expect(
      screen.getByRole('button', { name: '3 CHANGES' })
    ).toBeInTheDocument();

    expect(screen.queryByRole('button', { name: '任务列表' })).toBeNull();
    expect(
      screen.queryByRole('button', {
        name: '\u56de\u5230\u4e0a\u4e00\u6761\u7528\u6237\u6d88\u606f',
      })
    ).toBeNull();
  });

  it('shows a member identity instead of the agent icon when provided', () => {
    renderTopbar({
      executorProfile: { executor: 'codex' },
      composerIdentity: (
        <div data-testid="composer-member-identity">
          <span>小A</span>
        </div>
      ),
    });

    expect(screen.getByTestId('composer-member-identity')).toHaveTextContent(
      '小A'
    );
    expect(screen.queryByRole('img', { name: 'Codex' })).toBeNull();
  });

  it('keeps the agent icon bare without extra button controls on the right', () => {
    renderTopbar({
      executorProfile: { executor: 'codex' },
    });

    const agentIcon = screen.getByRole('img', { name: 'Codex' });
    expect(agentIcon.parentElement).not.toHaveClass('bg-muted/40');
    expect(agentIcon.parentElement).not.toHaveClass('composer-control');
    expect(agentIcon.parentElement).not.toHaveClass('border');
    expect(screen.queryAllByRole('button')).toHaveLength(0);
  });
});
