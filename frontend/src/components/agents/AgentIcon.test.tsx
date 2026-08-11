import { render, screen } from '@testing-library/react';
import { describe, expect, it } from 'vitest';

import { AgentIcon } from './AgentIcon';

describe('AgentIcon', () => {
  it.each([
    ['gemini', 'Gemini CLI', '/agents/gemini-light.svg'],
    ['openclaw', 'OpenClaw', '/agents/openclaw.svg'],
    ['cline', 'Cline', '/agents/cline.svg'],
    ['hermes', 'Hermes Agent', '/agents/hermes.png'],
    ['codebuddy', 'CodeBuddy', '/agents/codebuddy.svg'],
    ['kimi_code', 'Kimi Code', '/agents/kimi.svg'],
    ['grok', 'Grok', '/agents/grok.svg'],
    ['cursor', 'Cursor', '/agents/cursor-light.svg'],
  ])('renders the real %s artwork', (agent, name, src) => {
    render(<AgentIcon agent={agent} />);

    expect(screen.getByRole('img', { name })).toHaveAttribute('src', src);
  });
});
