import { useMemo, useState } from 'react';
import {
  AlertTriangle,
  ArrowRightLeft,
  Check,
  ChevronRight,
} from 'lucide-react';
import { useTranslation } from 'react-i18next';
import { Button } from '@/components/ui/button';
import {
  Dialog,
  DialogContent,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import type {
  ConversationEngineHandoffPackedItem,
  ConversationEngineHandoffPreview,
} from '@/features/conversation/conversationApi';
import { cn } from '@/lib/utils';

export type HandoffPackedMessage = ConversationEngineHandoffPackedItem;
export type EngineHandoffPreviewData = ConversationEngineHandoffPreview;

export interface EngineHandoffDialogProps {
  open: boolean;
  preview: EngineHandoffPreviewData | null;
  isSubmitting?: boolean;
  onConfirm: () => void;
  onCancel: () => void;
}

const SNIPPET_MAX_CHARS = 88;

function summarizeSnippet(text: string): string {
  const collapsed = text.trim().replace(/\s+/g, ' ');
  if (collapsed.length <= SNIPPET_MAX_CHARS) {
    return collapsed;
  }
  return `${collapsed.slice(0, SNIPPET_MAX_CHARS)}…`;
}

export function buildDeterministicHandoffPreviewText(
  preview: EngineHandoffPreviewData
): string {
  if (preview.handoffPromptText?.trim()) {
    return preview.handoffPromptText.trim();
  }

  const sorted = [...preview.packedMessages].sort(
    (a, b) => (a.sortIndex ?? 0) - (b.sortIndex ?? 0)
  );

  const sections: string[] = [
    `[VibeX Context Handoff]\nYou are continuing a conversation that was started with ${preview.sourceEngine}.`,
  ];

  for (const row of sorted) {
    const roleLabel =
      row.role === 'user'
        ? 'User'
        : row.role === 'assistant'
          ? 'Assistant'
          : 'System';
    sections.push(`--- [${roleLabel}] (item_id: ${row.id}) ---\n${row.content}`);
  }

  if (preview.omittedIds.length > 0) {
    sections.push(
      `[Omitted Items] (${preview.omittedIds.length} via thread_read_history)\n${preview.omittedIds.join(', ')}`
    );
  }

  return sections.join('\n\n');
}

export function EngineHandoffDialog({
  open,
  preview,
  isSubmitting = false,
  onConfirm,
  onCancel,
}: EngineHandoffDialogProps) {
  const { t } = useTranslation(['tasks', 'common']);
  const [previewExpanded, setPreviewExpanded] = useState(false);

  const summary = useMemo(() => {
    if (!preview) return null;
    const ordered = [...preview.packedMessages].sort(
      (a, b) => (a.sortIndex ?? 0) - (b.sortIndex ?? 0)
    );
    const userMessages = ordered.filter((m) => m.role === 'user');
    const assistantMessages = ordered.filter((m) => m.role === 'assistant');

    const firstUser = userMessages[0];
    const lastUser =
      userMessages.length > 1
        ? userMessages[userMessages.length - 1]
        : userMessages[0];
    const lastAssistant =
      assistantMessages.length > 0
        ? assistantMessages[assistantMessages.length - 1]
        : undefined;

    const pinnedIds = new Set<string>();
    if (firstUser) pinnedIds.add(firstUser.id);
    if (lastUser) pinnedIds.add(lastUser.id);
    if (lastAssistant) pinnedIds.add(lastAssistant.id);

    const recentTailCount = ordered.filter((m) => !pinnedIds.has(m.id)).length;
    const budgetRatio =
      preview.tokenBudget > 0
        ? Math.min(
            100,
            Math.round((preview.totalTokens / preview.tokenBudget) * 100)
          )
        : 0;

    return {
      firstUser,
      lastUser:
        lastUser && lastUser.id !== firstUser?.id ? lastUser : undefined,
      lastAssistant,
      recentTailCount,
      totalPackedCount: ordered.length,
      budgetRatio,
      fullPreviewText: buildDeterministicHandoffPreviewText(preview),
    };
  }, [preview]);

  if (!preview || !summary) {
    return null;
  }

  return (
    <Dialog
      open={open}
      onOpenChange={(nextOpen) => {
        if (!nextOpen) {
          onCancel();
        }
      }}
      className="!max-w-[540px] overflow-x-hidden p-0 sm:!max-w-[540px]"
    >
      <DialogContent className="gap-0">
        <div className="p-5" data-testid="engine-handoff-dialog">
          <DialogHeader className="pr-8">
            <DialogTitle className="flex items-center gap-2 text-base">
              <ArrowRightLeft className="h-4 w-4 shrink-0 text-muted-foreground" />
              <span>
                {t('tasks:engineHandoff.title', {
                  sourceEngine: preview.sourceEngine,
                  targetEngine: preview.targetEngine,
                })}
              </span>
            </DialogTitle>
          </DialogHeader>

          <div className="mt-4 rounded-lg border border-border bg-muted/30 px-3.5 py-2.5">
            <div className="flex items-center justify-between text-xs">
              <span className="text-muted-foreground">
                {t('tasks:engineHandoff.tokenBudget')}
              </span>
              <span
                data-testid="handoff-token-budget"
                className="font-semibold text-foreground tabular-nums"
              >
                {preview.totalTokens.toLocaleString()} /{' '}
                {preview.tokenBudget.toLocaleString()} ({summary.budgetRatio}%)
              </span>
            </div>
            <div className="mt-2 h-1.5 w-full overflow-hidden rounded-full bg-muted">
              <div
                className="h-full rounded-full bg-primary transition-all"
                style={{ width: `${summary.budgetRatio}%` }}
              />
            </div>
          </div>

          <div className="mt-4 space-y-2">
            <div className="text-xs font-semibold text-foreground">
              {t('tasks:engineHandoff.packedHeading')}
            </div>

            <ul className="space-y-1.5 text-xs">
              {summary.firstUser ? (
                <li
                  data-testid="handoff-first-user"
                  className="flex items-start gap-2 text-foreground"
                >
                  <Check className="mt-0.5 h-3.5 w-3.5 shrink-0 text-[hsl(var(--success))]" />
                  <span className="min-w-0 flex-1">
                    <span className="font-medium">
                      {t('tasks:engineHandoff.firstUserMessage')}:
                    </span>{' '}
                    <span className="text-muted-foreground">
                      &ldquo;{summarizeSnippet(summary.firstUser.content)}&rdquo;
                    </span>
                  </span>
                </li>
              ) : null}

              {summary.lastUser ? (
                <li
                  data-testid="handoff-last-user"
                  className="flex items-start gap-2 text-foreground"
                >
                  <Check className="mt-0.5 h-3.5 w-3.5 shrink-0 text-[hsl(var(--success))]" />
                  <span className="min-w-0 flex-1">
                    <span className="font-medium">
                      {t('tasks:engineHandoff.lastUserMessage')}:
                    </span>{' '}
                    <span className="text-muted-foreground">
                      &ldquo;{summarizeSnippet(summary.lastUser.content)}&rdquo;
                    </span>
                  </span>
                </li>
              ) : null}

              {summary.lastAssistant ? (
                <li
                  data-testid="handoff-last-assistant"
                  className="flex items-start gap-2 text-foreground"
                >
                  <Check className="mt-0.5 h-3.5 w-3.5 shrink-0 text-[hsl(var(--success))]" />
                  <span className="min-w-0 flex-1">
                    <span className="font-medium">
                      {t('tasks:engineHandoff.lastAssistantMessage')}:
                    </span>{' '}
                    <span className="text-muted-foreground">
                      &ldquo;{summarizeSnippet(summary.lastAssistant.content)}
                      &rdquo;
                    </span>
                  </span>
                </li>
              ) : null}

              {summary.recentTailCount > 0 ? (
                <li
                  data-testid="handoff-recent-count"
                  className="flex items-start gap-2 text-foreground tabular-nums"
                >
                  <Check className="mt-0.5 h-3.5 w-3.5 shrink-0 text-[hsl(var(--success))]" />
                  <span>
                    {t('tasks:engineHandoff.recentMessages', {
                      count: summary.recentTailCount,
                    })}
                  </span>
                </li>
              ) : null}

              {preview.omittedIds.length > 0 ? (
                <li
                  data-testid="handoff-omitted-warning"
                  className="flex items-start gap-2 rounded-md border border-amber-500/30 bg-amber-500/10 px-2.5 py-1.5 text-foreground tabular-nums"
                >
                  <AlertTriangle className="mt-0.5 h-3.5 w-3.5 shrink-0 text-amber-500" />
                  <span>
                    {t('tasks:engineHandoff.omittedWarning', {
                      count: preview.omittedIds.length,
                    })}
                  </span>
                </li>
              ) : null}
            </ul>
          </div>

          <div className="mt-3 overflow-hidden rounded-lg border border-border/70 bg-background/60">
            <button
              type="button"
              onClick={() => setPreviewExpanded((prev) => !prev)}
              aria-expanded={previewExpanded}
              data-testid="handoff-preview-toggle"
              className="flex w-full items-center gap-2 px-3 py-2 text-left text-xs font-medium text-foreground transition-colors hover:bg-muted/50"
            >
              <ChevronRight
                className={cn(
                  'h-3.5 w-3.5 text-muted-foreground transition-transform duration-150',
                  previewExpanded && 'rotate-90'
                )}
              />
              <span>
                {previewExpanded
                  ? t('tasks:engineHandoff.collapsePreview')
                  : t('tasks:engineHandoff.expandPreview')}
              </span>
            </button>

            {previewExpanded ? (
              <pre
                data-testid="handoff-preview-content"
                className="max-h-56 overflow-y-auto border-t border-border/60 bg-muted/20 p-3 font-mono text-[11px] leading-relaxed whitespace-pre-wrap break-words text-foreground"
              >
                {summary.fullPreviewText}
              </pre>
            ) : null}
          </div>

          <DialogFooter className="mt-5 flex justify-end gap-2">
            <Button
              type="button"
              variant="outline"
              size="sm"
              disabled={isSubmitting}
              onClick={onCancel}
              data-testid="handoff-cancel-btn"
            >
              {t('common:cancel')}
            </Button>
            <Button
              type="button"
              size="sm"
              disabled={isSubmitting}
              onClick={onConfirm}
              data-testid="handoff-confirm-btn"
            >
              {t('tasks:engineHandoff.confirmSwitch')}
            </Button>
          </DialogFooter>
        </div>
      </DialogContent>
    </Dialog>
  );
}
