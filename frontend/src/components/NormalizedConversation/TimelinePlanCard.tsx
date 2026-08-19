import type { PlanEntry } from 'shared/types';
import { ConversationPlanCard } from './ConversationPlanCard';
import { toConversationPlanItem } from './conversationPlan';

/**
 * Renders a unified-timeline `Plan` block (parsed from TodoWrite / update_plan)
 * as a checklist, consuming the normalized
 * `PlanEntry[]` directly instead of a NormalizedEntry. VibeX-authored.
 */
export function TimelinePlanCard({
  entries,
  expansionKey = 'timeline-plan',
}: {
  entries: PlanEntry[];
  expansionKey?: string;
}) {
  return (
    <ConversationPlanCard
      items={entries.map(toConversationPlanItem)}
      expansionKey={expansionKey}
    />
  );
}
