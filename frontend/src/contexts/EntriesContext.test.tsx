import { act, render, screen } from '@testing-library/react';
import { useEffect } from 'react';
import { describe, expect, it, beforeEach } from 'vitest';
import type { PatchTypeWithKey } from '@/hooks/conversationEntries';
import type { PlanEntry } from 'shared/types';
import {
  clearEntriesRuntimeForTests,
  EntriesProvider,
  useEntries,
} from './EntriesContext';

const renderedUserEntry: PatchTypeWithKey = {
  type: 'NORMALIZED_ENTRY',
  patchKey: 'process-1:user-1',
  executionProcessId: 'process-1',
  content: {
    entry_type: { type: 'user_message' },
    content: 'hello',
    timestamp: null,
  },
};

function SaveEntriesOnMount({ entries }: { entries: PatchTypeWithKey[] }) {
  const { setEntries } = useEntries();

  useEffect(() => {
    setEntries(entries);
  }, [entries, setEntries]);

  return null;
}

function SaveTokenUsageOnMount() {
  const { setEntries, setTokenUsageInfo } = useEntries();

  useEffect(() => {
    setEntries([renderedUserEntry]);
    setTokenUsageInfo({
      total_tokens: 12_000,
      model_context_window: 128_000,
    });
  }, [setEntries, setTokenUsageInfo]);

  return null;
}

function EntriesCount() {
  const { entries } = useEntries();
  return <div data-testid="entries-count">{entries.length}</div>;
}

function TokenUsageTotal() {
  const { tokenUsageInfo } = useEntries();
  return (
    <div data-testid="token-total">{tokenUsageInfo?.total_tokens ?? 0}</div>
  );
}

const visiblePlan: PlanEntry[] = [
  { content: 'Repair queue state', status: 'in_progress', priority: null },
  { content: 'Verify the composer', status: 'pending', priority: null },
];

function SaveConversationRuntimeOnMount() {
  const { setConversationPlanEntries, setConversationTurnInFlight } =
    useEntries();

  useEffect(() => {
    setConversationPlanEntries(visiblePlan);
    setConversationTurnInFlight(true);
  }, [setConversationPlanEntries, setConversationTurnInFlight]);

  return null;
}

function ConversationRuntimeSummary() {
  const { conversationPlanEntries, conversationTurnInFlight } = useEntries();
  return (
    <div data-testid="conversation-runtime">
      {conversationTurnInFlight ? 'running' : 'idle'}:
      {conversationPlanEntries.map((entry) => entry.content).join('|')}
    </div>
  );
}

describe('EntriesProvider', () => {
  beforeEach(() => {
    clearEntriesRuntimeForTests();
  });

  it('keeps keyed runtime entries across provider remounts', () => {
    const first = render(
      <EntriesProvider runtimeKey="workspace-1:session-1">
        <SaveEntriesOnMount entries={[renderedUserEntry]} />
      </EntriesProvider>
    );
    first.unmount();

    render(
      <EntriesProvider runtimeKey="workspace-1:session-1">
        <EntriesCount />
      </EntriesProvider>
    );

    expect(screen.getByTestId('entries-count')).toHaveTextContent('1');
  });

  it('allows explicit empty updates to clear the keyed runtime', () => {
    const first = render(
      <EntriesProvider runtimeKey="workspace-1:session-1">
        <SaveEntriesOnMount entries={[renderedUserEntry]} />
      </EntriesProvider>
    );
    first.unmount();

    const second = render(
      <EntriesProvider runtimeKey="workspace-1:session-1">
        <SaveEntriesOnMount entries={[]} />
      </EntriesProvider>
    );
    second.unmount();

    render(
      <EntriesProvider runtimeKey="workspace-1:session-1">
        <EntriesCount />
      </EntriesProvider>
    );

    expect(screen.getByTestId('entries-count')).toHaveTextContent('0');
  });

  it('keeps token usage in the same keyed runtime as entries', () => {
    const first = render(
      <EntriesProvider runtimeKey="workspace-1:session-1">
        <SaveTokenUsageOnMount />
      </EntriesProvider>
    );
    first.unmount();

    render(
      <EntriesProvider runtimeKey="workspace-1:session-1">
        <TokenUsageTotal />
      </EntriesProvider>
    );

    expect(screen.getByTestId('token-total')).toHaveTextContent('12000');
  });

  it('updates same-key mounted providers without rendered snapshot fallback', () => {
    function RuntimeWriter() {
      const { setEntries } = useEntries();

      return (
        <button type="button" onClick={() => setEntries([renderedUserEntry])}>
          update
        </button>
      );
    }

    render(
      <>
        <EntriesProvider runtimeKey="workspace-1:session-1">
          <RuntimeWriter />
        </EntriesProvider>
        <EntriesProvider runtimeKey="workspace-1:session-1">
          <EntriesCount />
        </EntriesProvider>
      </>
    );

    expect(screen.getByTestId('entries-count')).toHaveTextContent('0');

    act(() => {
      screen.getByRole('button', { name: 'update' }).click();
    });

    expect(screen.getByTestId('entries-count')).toHaveTextContent('1');
  });

  it('shares canonical turn state and visible plans with the composer provider', () => {
    render(
      <>
        <EntriesProvider runtimeKey="workspace-1:session-1">
          <SaveConversationRuntimeOnMount />
        </EntriesProvider>
        <EntriesProvider runtimeKey="workspace-1:session-1">
          <ConversationRuntimeSummary />
        </EntriesProvider>
      </>
    );

    expect(screen.getByTestId('conversation-runtime')).toHaveTextContent(
      'running:Repair queue state|Verify the composer'
    );
  });
});
