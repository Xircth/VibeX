import { render, screen } from '@testing-library/react';
import { describe, expect, it } from 'vitest';

import { AgentTypeIcon } from './AgentTypeIcon';

describe('AgentTypeIcon', () => {
  it.each([
    ['grok', 'Grok'],
    ['kimi_code', 'Kimi Code'],
    ['kimi', 'Kimi Code'],
    ['cursor', 'Cursor'],
    ['deepseek_harness', 'DeepSeek Harness'],
  ])(
    'renders brand artwork for %s instead of the generic glyph',
    (agent, name) => {
      render(<AgentTypeIcon agentType={agent} />);

      expect(screen.getByTitle(name)).toBeInTheDocument();
      expect(document.querySelector('.lucide-bot')).not.toBeInTheDocument();
    }
  );
});
