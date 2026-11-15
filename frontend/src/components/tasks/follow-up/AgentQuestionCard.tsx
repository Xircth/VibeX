import { useEffect, useMemo, useState } from 'react';
import { Badge } from '@astryxdesign/core';
import { Check, ChevronLeft, ChevronRight, PenLine, X } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import type {
  AgentElicitationResponse,
  ConversationQuestionRequest,
} from 'shared/types';
import { getErrorMessage } from '@/lib/modals';
import { cn } from '@/lib/utils';
import {
  emptyQuestionAnswerState,
  hasAnswer,
  initialAnswerState,
  questionTabsFromRequest,
  responseContent,
  type PrimitiveValue,
  type QuestionAnswerState,
  type QuestionTab,
} from './agentQuestionModel';

const CUSTOM_VALUE = '__vibex_custom_answer__';

export function isOrphanedQuestionResponseError(error: unknown): boolean {
  const message = getErrorMessage(error);
  return /no active.*(agent|connection|turn|session)|unknown elicitation|elicitation.*not found|question.*(expired|not found|closed)|bad\s*request|invalid question id|\b400\b/i.test(
    message
  );
}

export function AgentQuestionCard({
  request,
  onRespond,
  onDismiss,
  responding = false,
  mode = 'interactive',
  answers = null,
  onQuestionIndexChange,
}: {
  request: ConversationQuestionRequest;
  onRespond?: (
    questionId: string,
    response: AgentElicitationResponse
  ) => void | Promise<unknown>;
  onDismiss?: (questionId: string) => void;
  responding?: boolean;
  mode?: 'interactive' | 'readonly';
  answers?: Record<string, QuestionAnswerState> | null;
  onQuestionIndexChange?: (index: number) => void;
}) {
  const { t, i18n } = useTranslation(['conversation', 'common']);
  const questions = useMemo(() => questionTabsFromRequest(request), [request]);
  const [answerState, setAnswerState] = useState(() =>
    initialAnswerState(questions)
  );
  const [activeIndex, setActiveIndex] = useState(0);
  const [pinnedOpen, setPinnedOpen] = useState(true);
  const [respondError, setRespondError] = useState<string | null>(null);
  const [localDismissed, setLocalDismissed] = useState(false);

  useEffect(() => {
    setRespondError(null);
    setLocalDismissed(false);
  }, [request.question_id]);

  const resolvedState = mode === 'readonly' ? (answers ?? {}) : answerState;
  const activeQuestion = questions[activeIndex];
  const isLast = activeIndex === questions.length - 1;
  const complete = questions.every((question) =>
    hasAnswer(resolvedState[question.id])
  );
  const askedAt = request.asked_at ?? null;
  const askedAtLabel = askedAt
    ? new Intl.DateTimeFormat(i18n.language, {
        hour: '2-digit',
        minute: '2-digit',
      }).format(new Date(askedAt))
    : t('questionRequestCard.justNow');

  if (mode === 'readonly') {
    const question = questions[activeIndex] ?? questions[0];
    if (!question) return null;
    const updateReadonlyIndex = (nextIndex: number) => {
      setActiveIndex(nextIndex);
      onQuestionIndexChange?.(nextIndex);
    };
    return (
      <div
        className="agent-question-detail"
        data-testid="agent-question-detail"
        data-mode="readonly"
      >
        {questions.length > 1 ? (
          <div className="agent-question-detail-pager">
            <button
              type="button"
              className="agent-question-detail-pager-btn"
              aria-label={t('questionRequestCard.previous')}
              disabled={activeIndex === 0}
              onClick={() => updateReadonlyIndex(Math.max(0, activeIndex - 1))}
            >
              <ChevronLeft className="h-4 w-4" />
            </button>
            <span className="agent-question-card-position">
              {activeIndex + 1} / {questions.length}
            </span>
            <button
              type="button"
              className="agent-question-detail-pager-btn"
              aria-label={t('questionRequestCard.next')}
              disabled={activeIndex >= questions.length - 1}
              onClick={() =>
                updateReadonlyIndex(
                  Math.min(questions.length - 1, activeIndex + 1)
                )
              }
            >
              <ChevronRight className="h-4 w-4" />
            </button>
          </div>
        ) : null}
        <QuestionFields
          key={question.id}
          requestId={request.question_id}
          question={question}
          answer={resolvedState[question.id] ?? emptyQuestionAnswerState()}
          readonly
          responding={false}
          onSelectChoice={() => undefined}
          onToggleCustom={() => undefined}
          onCustomText={() => undefined}
        />
      </div>
    );
  }

  if (localDismissed || !activeQuestion) return null;

  const updateAnswer = (
    question: QuestionTab,
    update: (current: QuestionAnswerState) => QuestionAnswerState
  ) => {
    setAnswerState((current) => ({
      ...current,
      [question.id]: update(current[question.id] ?? emptyQuestionAnswerState()),
    }));
  };

  const selectChoice = (question: QuestionTab, value: PrimitiveValue) => {
    updateAnswer(question, (current) => {
      if (!question.multiSelect) {
        return {
          ...current,
          selected: [value],
          customActive: false,
        };
      }
      const selected = current.selected.some((item) => item === value)
        ? current.selected.filter((item) => item !== value)
        : [...current.selected, value];
      return { ...current, selected };
    });
  };

  const toggleCustomAnswer = (question: QuestionTab) => {
    updateAnswer(question, (current) => {
      const customActive = !current.customActive;
      return {
        ...current,
        customActive,
        selected: question.multiSelect || !customActive ? current.selected : [],
      };
    });
  };

  const setCustomAnswer = (question: QuestionTab, customText: string) => {
    updateAnswer(question, (current) => ({
      ...current,
      customActive: true,
      customText,
      selected: question.multiSelect ? current.selected : [],
    }));
  };

  const dismissCard = () => {
    setLocalDismissed(true);
    onDismiss?.(request.question_id);
  };

  const submit = async () => {
    if (!complete || responding || !onRespond) return;
    setRespondError(null);
    try {
      await onRespond(request.question_id, {
        action: 'accept',
        content: responseContent(request, questions, answerState),
      });
    } catch (error) {
      setRespondError(getErrorMessage(error));
    }
  };

  const decline = async () => {
    if (responding || !onRespond) return;
    setRespondError(null);
    try {
      await onRespond(request.question_id, { action: 'decline' });
    } catch (error) {
      if (isOrphanedQuestionResponseError(error)) {
        dismissCard();
        return;
      }
      setRespondError(getErrorMessage(error));
    }
  };

  return (
    <section
      role="group"
      aria-label={t('questionRequestCard.title')}
      className="agent-question-card"
      data-expanded={pinnedOpen ? 'true' : 'false'}
      data-testid="agent-question-card"
    >
      <button
        type="button"
        className="agent-question-card-header"
        aria-label={
          pinnedOpen
            ? t('questionRequestCard.collapse')
            : t('questionRequestCard.expand')
        }
        aria-expanded={pinnedOpen}
        onClick={(event) => {
          if (pinnedOpen) event.currentTarget.blur();
          setPinnedOpen((current) => !current);
        }}
      >
        <span className="agent-question-card-position">
          {activeIndex + 1} / {questions.length}
        </span>
        <span className="agent-question-card-title">
          {activeQuestion.header || t('questionRequestCard.title')}
        </span>
        <time
          role="time"
          className="agent-question-card-time"
          dateTime={askedAt ?? undefined}
        >
          {askedAtLabel}
        </time>
      </button>

      <div className="agent-question-card-content">
        <QuestionFields
          requestId={request.question_id}
          question={activeQuestion}
          answer={
            resolvedState[activeQuestion.id] ?? emptyQuestionAnswerState()
          }
          readonly={false}
          responding={responding}
          onSelectChoice={(value) => selectChoice(activeQuestion, value)}
          onToggleCustom={() => toggleCustomAnswer(activeQuestion)}
          onCustomText={(value) => setCustomAnswer(activeQuestion, value)}
        />

        {respondError ? (
          <div
            role="alert"
            data-testid="agent-question-error"
            className="mt-2 flex items-center justify-between gap-2 rounded-md border border-destructive/40 bg-destructive/10 px-2.5 py-1.5 text-xs text-destructive"
          >
            <span className="min-w-0 flex-1 break-words">{respondError}</span>
            <button
              type="button"
              data-testid="agent-question-dismiss"
              onClick={dismissCard}
              className="inline-flex shrink-0 items-center gap-1 rounded px-1.5 py-0.5 font-medium hover:bg-destructive/15"
              aria-label={t('common:close')}
            >
              <X className="h-3 w-3" aria-hidden />
              <span>{t('common:close')}</span>
            </button>
          </div>
        ) : null}

        <footer className="agent-question-card-actions">
          <span className="flex items-center gap-2">
            {activeIndex > 0 ? (
              <button
                type="button"
                className="agent-question-action"
                disabled={responding}
                onClick={() => setActiveIndex((index) => index - 1)}
              >
                {t('questionRequestCard.previous')}
              </button>
            ) : null}
            <button
              type="button"
              className="agent-question-action agent-question-decline"
              disabled={responding}
              onClick={() => void decline()}
            >
              {t('questionRequestCard.decline')}
            </button>
          </span>
          {isLast ? (
            <button
              type="button"
              className="agent-question-action agent-question-submit"
              disabled={!complete || responding}
              onClick={() => void submit()}
            >
              {t('questionRequestCard.submit')}
            </button>
          ) : (
            <button
              type="button"
              className="agent-question-action"
              disabled={responding}
              onClick={() => setActiveIndex((index) => index + 1)}
            >
              {t('questionRequestCard.next')}
            </button>
          )}
        </footer>
      </div>
    </section>
  );
}

function QuestionFields({
  requestId,
  question,
  answer,
  readonly,
  responding,
  onSelectChoice,
  onToggleCustom,
  onCustomText,
}: {
  requestId: string;
  question: QuestionTab;
  answer: QuestionAnswerState;
  readonly: boolean;
  responding: boolean;
  onSelectChoice: (value: PrimitiveValue) => void;
  onToggleCustom: () => void;
  onCustomText: (value: string) => void;
}) {
  const { t } = useTranslation(['conversation']);
  const disabled = readonly || responding;
  return (
    <div className="agent-question-fields">
      {!readonly ? (
        <p className="agent-question-card-prompt">{question.question}</p>
      ) : null}
      <div
        className="agent-question-options"
        role={question.multiSelect ? 'group' : 'radiogroup'}
        aria-label={question.question}
      >
        {question.choices.map((choice, choiceIndex) => {
          const selected = answer.selected.some(
            (value) => value === choice.value
          );
          const controlId = `${requestId}-${question.id}-${choiceIndex}`;
          return (
            <label
              key={`${choiceIndex}-${choice.label}`}
              htmlFor={controlId}
              className={cn(
                'agent-question-option',
                selected && (readonly ? 'is-answered' : 'is-selected')
              )}
            >
              <input
                id={controlId}
                type={question.multiSelect ? 'checkbox' : 'radio'}
                name={`${requestId}-${question.id}`}
                value={String(choice.value)}
                checked={selected}
                disabled={disabled}
                readOnly={readonly}
                onChange={() => {
                  if (!readonly) onSelectChoice(choice.value);
                }}
              />
              <span className="agent-question-option-indicator" aria-hidden>
                {question.multiSelect && selected ? (
                  <Check className="h-3 w-3" />
                ) : null}
              </span>
              <span className="agent-question-option-copy">
                <span className="agent-question-option-label">
                  {choice.label}
                  {choice.recommended ? (
                    <Badge
                      label={t('questionRequestCard.recommended')}
                      className="agent-question-recommended"
                    />
                  ) : null}
                </span>
                {choice.description ? (
                  <span className="agent-question-option-description">
                    {choice.description}
                  </span>
                ) : null}
              </span>
            </label>
          );
        })}

        {readonly && !answer.customActive ? null : (
          <label
            className={cn(
              'agent-question-option',
              answer.customActive && (readonly ? 'is-answered' : 'is-selected')
            )}
          >
            <input
              type={question.multiSelect ? 'checkbox' : 'radio'}
              name={`${requestId}-${question.id}`}
              value={CUSTOM_VALUE}
              checked={answer.customActive}
              disabled={disabled}
              readOnly={readonly}
              onChange={() => {
                if (!readonly) onToggleCustom();
              }}
            />
            <span className="agent-question-option-indicator" aria-hidden />
            <span className="agent-question-option-copy">
              <span className="agent-question-option-label">
                <PenLine className="h-3.5 w-3.5" aria-hidden />
                {t('questionRequestCard.customAnswer')}
              </span>
            </span>
          </label>
        )}

        {answer.customActive ? (
          <input
            type={
              question.valueType === 'number' ||
              question.valueType === 'integer'
                ? 'number'
                : 'text'
            }
            className="agent-question-custom-input"
            aria-label={t('questionRequestCard.customAnswer')}
            placeholder={t('questionRequestCard.customPlaceholder')}
            autoFocus={!readonly}
            disabled={disabled}
            readOnly={readonly}
            value={answer.customText}
            onChange={(event) => {
              if (!readonly) onCustomText(event.target.value);
            }}
          />
        ) : null}
      </div>
    </div>
  );
}
