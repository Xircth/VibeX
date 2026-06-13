import { render, screen } from '@testing-library/react';
import { describe, expect, it } from 'vitest';

import { TooltipProvider } from '@/components/ui/tooltip';
import { TokenUsageIndicator } from './TokenUsageIndicator';

function renderIndicator(total_tokens: number, model_context_window: number) {
  return render(
    <TooltipProvider>
      <TokenUsageIndicator
        tokenUsageInfo={{ total_tokens, model_context_window }}
      />
    </TooltipProvider>
  );
}

describe('TokenUsageIndicator', () => {
  it('renders the real context usage percentage from used and window tokens', () => {
    const { container } = renderIndicator(25_000, 100_000);
    const indicator = screen.getByTitle(/25,000 \/ 100,000 tokens/i);

    expect(screen.queryByText('25')).not.toBeInTheDocument();
    expect(screen.queryByText('25%')).not.toBeInTheDocument();
    expect(indicator).toHaveAccessibleName(/25%.*25,000 \/ 100,000 tokens/i);
    expect(indicator).toHaveAttribute(
      'title',
      expect.stringMatching(/25%.*25,000 \/ 100,000 tokens/i)
    );
    expect(
      container.querySelector('.composer-token-usage-ring')
    ).toHaveStyle({
      background:
        'conic-gradient(var(--composer-token-usage-ring, hsl(var(--foreground))) 25%, var(--composer-token-usage-track, hsl(var(--muted))) 25% 100%)',
    });
    expect(
      container.querySelector('.composer-token-usage-core')
    ).toHaveStyle({
      backgroundColor:
        'var(--composer-token-usage-core, hsl(var(--background)))',
    });
  });

  it('does not render without a valid context window', () => {
    const { container } = renderIndicator(25_000, 0);

    expect(container).toBeEmptyDOMElement();
  });

  it('does not render a zero-token snapshot as zero percent usage', () => {
    const { container } = renderIndicator(0, 100_000);

    expect(container).toBeEmptyDOMElement();
    expect(screen.queryByText('0%')).not.toBeInTheDocument();
  });
});
