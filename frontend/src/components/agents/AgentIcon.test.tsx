import { render, screen } from '@testing-library/react';
import { describe, expect, it } from 'vitest';

import { AgentIcon } from './AgentIcon';

describe('AgentIcon', () => {
  it.each([
    ['antigravity', 'Google Antigravity', '/agents/antigravity.svg'],
    ['openclaw', 'OpenClaw', '/agents/openclaw.svg'],
    ['cline', 'Cline', '/agents/cline.svg'],
    ['hermes', 'Hermes Agent', '/agents/hermes.png'],
    ['codebuddy', 'CodeBuddy', '/agents/codebuddy.svg'],
    ['kimi_code', 'Kimi Code', '/agents/kimi.svg'],
    ['grok', 'Grok', '/agents/grok.svg'],
    ['cursor', 'Cursor', '/agents/cursor-light.svg'],
    [
      'deepseek_harness',
      'DeepSeek Harness',
      '/agents/deepseek-harness-light.svg',
    ],
  ])('renders the real %s artwork', (agent, name, src) => {
    render(<AgentIcon agent={agent} />);

    expect(screen.getByRole('img', { name })).toHaveAttribute('src', src);
  });

  it('keeps built-in artwork when a registry icon is also provided', () => {
    render(
      <AgentIcon
        agent="grok"
        iconLight="/agents/runtime-grok-light.svg"
        iconDark="/agents/runtime-grok-dark.svg"
        iconSvg="<svg data-mark='registry'></svg>"
      />
    );

    expect(screen.getByRole('img', { name: 'Grok' })).toHaveAttribute(
      'src',
      '/agents/grok.svg'
    );
    expect(document.querySelector('[data-mark="registry"]')).toBeNull();
  });

  it('accepts the short Kimi alias used by some pickers', () => {
    render(<AgentIcon agent="kimi" />);

    expect(screen.getByRole('img', { name: 'Kimi Code' })).toHaveAttribute(
      'src',
      '/agents/kimi.svg'
    );
  });

  it.each([
    ['claude-code', 'Claude Code', '/agents/claude-light.svg'],
    ['kimi-code', 'Kimi Code', '/agents/kimi.svg'],
    ['deepseek-harness', 'DeepSeek Harness', '/agents/deepseek-harness-light.svg'],
    ['gemini', 'Google Antigravity', '/agents/antigravity.svg'],
  ])('normalizes %s to built-in artwork', (agent, name, src) => {
    render(<AgentIcon agent={agent} />);

    expect(screen.getByRole('img', { name })).toHaveAttribute('src', src);
  });

  it('shows the runtime inline svg for registry-only agents (Workbuddy)', () => {
    const { container } = render(
      <AgentIcon agent="workbuddy" iconSvg="<svg data-mark='wb'></svg>" />
    );

    expect(container.querySelector('svg')).toHaveAttribute('data-mark', 'wb');
    expect(screen.queryByRole('img')).not.toBeInTheDocument();
  });

  it('falls back to the generic glyph when runtime and built-in artwork are both unknown', () => {
    render(<AgentIcon agent="workbuddy" />);

    expect(screen.queryByRole('img')).not.toBeInTheDocument();
    expect(document.querySelector('.lucide-bot')).toBeInTheDocument();
  });
});
