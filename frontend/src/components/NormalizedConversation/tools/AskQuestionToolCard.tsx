import { ChevronRight } from 'lucide-react';
import { useLayoutEffect, useMemo, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import type {
  ConversationQuestionRequest,
  ConversationQuestionResponse,
} from 'shared/types';
import { cn } from '@/lib/utils';
import { AgentQuestionCard } from '@/components/tasks/follow-up/AgentQuestionCard';
import {
  answerStateFromResponse,
  answerStateFromToolResult,
  firstQuestionTitle,
  questionRequestFromToolUse,
  questionTabsFromRequest,
} from '@/components/tasks/follow-up/agentQuestionModel';
import type { ToolResultBlock, ToolUseBlock } from '../messageTurnBlocks';

export function AskQuestionToolCard({
  use,
  result = null,
  request,
  response = null,
}: {
  use?: ToolUseBlock | null;
  result?: ToolResultBlock | null;
  request?: ConversationQuestionRequest | null;
  response?: ConversationQuestionResponse | null;
}) {
  const { t } = useTranslation('conversation');
  const [open, setOpen] = useState(false);
  const titleRef = useRef<HTMLSpanElement | null>(null);
  const [titleOverflows, setTitleOverflows] = useState(false);
  const resolvedRequest = useMemo(
    () => request ?? (use ? questionRequestFromToolUse(use) : null),
    [request, use]
  );
  const questions = useMemo(
    () => (resolvedRequest ? questionTabsFromRequest(resolvedRequest) : []),
    [resolvedRequest]
  );
  const answers = useMemo(
    () =>
      answerStateFromResponse(questions, response) ??
      answerStateFromToolResult(questions, result),
    [questions, response, result]
  );
  const title = firstQuestionTitle(questions) || t('askQuestion.title');

  useLayoutEffect(() => {
    const node = titleRef.current;
    if (!node) return;
    const update = () => {
      setTitleOverflows(node.scrollWidth - node.clientWidth > 1);
    };
    update();
    if (typeof ResizeObserver !== 'function') return undefined;
    const observer = new ResizeObserver(update);
    if (typeof observer.observe !== 'function') return undefined;
    observer.observe(node);
    return () => observer.disconnect();
  }, [title]);

  if (!resolvedRequest) return null;

  return (
    <div
      role="group"
      aria-label={title}
      data-testid="ask-question-tool-card"
      className="ask-question-tool-card rounded-lg border border-border bg-card px-5 py-4 text-sm text-card-foreground"
    >
      <div className="min-w-0">
        <span
          ref={titleRef}
          data-testid="ask-question-title"
          title={title}
          className={cn(
            'ask-question-tool-title min-w-0 w-full font-medium text-foreground',
            titleOverflows && 'is-overflow'
          )}
        >
          {title}
        </span>
        <div className="mt-2 flex min-w-0 items-center gap-2">
          <button
            type="button"
            className="flex items-center gap-1 text-xs font-medium text-muted-foreground hover:text-foreground"
            aria-expanded={open}
            onClick={() => setOpen((current) => !current)}
          >
            <ChevronRight
              aria-hidden
              className={cn(
                'h-3.5 w-3.5 transition-transform',
                open && 'rotate-90'
              )}
            />
            {t('askQuestion.viewDetails')}
          </button>
          <span
            data-testid="ask-question-kind-tag"
            className="ask-question-kind-tag ml-auto"
          >
            {t('askQuestion.kindTag')}
          </span>
        </div>
        {open ? (
          <div
            data-testid="ask-question-detail-well"
            className="ask-question-detail-well"
          >
            <AgentQuestionCard
              request={resolvedRequest}
              mode="readonly"
              answers={answers}
            />
          </div>
        ) : null}
      </div>
    </div>
  );
}
