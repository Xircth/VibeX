import { useMemo, useState } from 'react';
import { Badge, Button } from '@astryxdesign/core';
import { Check, PenLine } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import type {
  AgentElicitationResponse,
  ConversationQuestionRequest,
} from 'shared/types';
import { cn } from '@/lib/utils';

type PrimitiveValue = string | number | boolean;

type QuestionChoice = {
  value: PrimitiveValue;
  label: string;
  description: string;
  recommended: boolean;
};

type QuestionTab = {
  id: string;
  fieldName: string | null;
  header: string;
  question: string;
  multiSelect: boolean;
  valueType: 'string' | 'number' | 'integer' | 'boolean';
  choices: QuestionChoice[];
};

type QuestionAnswerState = {
  selected: PrimitiveValue[];
  customActive: boolean;
  customText: string;
};

const CUSTOM_VALUE = '__vibex_custom_answer__';

export function AgentQuestionCard({
  request,
  onRespond,
  responding = false,
}: {
  request: ConversationQuestionRequest;
  onRespond: (questionId: string, response: AgentElicitationResponse) => void;
  responding?: boolean;
}) {
  const { t, i18n } = useTranslation(['conversation']);
  const questions = useMemo(() => questionTabsFromRequest(request), [request]);
  const [answerState, setAnswerState] = useState(() =>
    initialAnswerState(questions)
  );
  const [activeIndex, setActiveIndex] = useState(0);
  const [pinnedOpen, setPinnedOpen] = useState(false);
  const activeQuestion = questions[activeIndex];
  const activeAnswer = activeQuestion
    ? answerState[activeQuestion.id]
    : undefined;
  const isLast = activeIndex === questions.length - 1;
  const complete = questions.every((question) =>
    hasAnswer(answerState[question.id])
  );
  const askedAt = request.asked_at ?? null;
  const askedAtLabel = askedAt
    ? new Intl.DateTimeFormat(i18n.language, {
        hour: '2-digit',
        minute: '2-digit',
      }).format(new Date(askedAt))
    : t('questionRequestCard.justNow');

  if (!activeQuestion) return null;

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

  const submit = () => {
    if (!complete || responding) return;
    onRespond(request.question_id, {
      action: 'accept',
      content: responseContent(request, questions, answerState),
    });
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
        <p className="agent-question-card-prompt">{activeQuestion.question}</p>

        <div
          className="agent-question-options"
          role={activeQuestion.multiSelect ? 'group' : 'radiogroup'}
          aria-label={activeQuestion.question}
        >
          {activeQuestion.choices.map((choice, choiceIndex) => {
            const selected =
              activeAnswer?.selected.some((value) => value === choice.value) ??
              false;
            const controlId = `${request.question_id}-${activeQuestion.id}-${choiceIndex}`;
            return (
              <label
                key={`${choiceIndex}-${choice.label}`}
                htmlFor={controlId}
                className={cn(
                  'agent-question-option',
                  selected && 'is-selected'
                )}
              >
                <input
                  id={controlId}
                  type={activeQuestion.multiSelect ? 'checkbox' : 'radio'}
                  name={`${request.question_id}-${activeQuestion.id}`}
                  value={String(choice.value)}
                  checked={selected}
                  disabled={responding}
                  onChange={() => selectChoice(activeQuestion, choice.value)}
                />
                <span className="agent-question-option-indicator" aria-hidden>
                  {activeQuestion.multiSelect && selected ? (
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

          <label
            className={cn(
              'agent-question-option',
              activeAnswer?.customActive && 'is-selected'
            )}
          >
            <input
              type={activeQuestion.multiSelect ? 'checkbox' : 'radio'}
              name={`${request.question_id}-${activeQuestion.id}`}
              value={CUSTOM_VALUE}
              checked={activeAnswer?.customActive ?? false}
              disabled={responding}
              onChange={() => toggleCustomAnswer(activeQuestion)}
            />
            <span className="agent-question-option-indicator" aria-hidden />
            <span className="agent-question-option-copy">
              <span className="agent-question-option-label">
                <PenLine className="h-3.5 w-3.5" aria-hidden />
                {t('questionRequestCard.customAnswer')}
              </span>
            </span>
          </label>

          {activeAnswer?.customActive ? (
            <input
              type={
                activeQuestion.valueType === 'number' ||
                activeQuestion.valueType === 'integer'
                  ? 'number'
                  : 'text'
              }
              className="agent-question-custom-input"
              aria-label={t('questionRequestCard.customAnswer')}
              placeholder={t('questionRequestCard.customPlaceholder')}
              autoFocus
              disabled={responding}
              value={activeAnswer.customText}
              onChange={(event) =>
                setCustomAnswer(activeQuestion, event.target.value)
              }
            />
          ) : null}
        </div>

        <footer className="agent-question-card-actions">
          <span>
            {activeIndex > 0 ? (
              <Button
                label={t('questionRequestCard.previous')}
                variant="secondary"
                size="sm"
                isDisabled={responding}
                onClick={() => setActiveIndex((index) => index - 1)}
              />
            ) : null}
          </span>
          {isLast ? (
            <Button
              label={t('questionRequestCard.submit')}
              variant="primary"
              size="sm"
              className="agent-question-submit"
              isDisabled={!complete || responding}
              isLoading={responding}
              onClick={submit}
            />
          ) : (
            <Button
              label={t('questionRequestCard.next')}
              variant="secondary"
              size="sm"
              isDisabled={responding}
              onClick={() => setActiveIndex((index) => index + 1)}
            />
          )}
        </footer>
      </div>
    </section>
  );
}

function questionTabsFromRequest(
  request: ConversationQuestionRequest
): QuestionTab[] {
  const root = asObject(request.schema);
  const vibexQuestions = root?.['x-vibex-questions'];
  if (Array.isArray(vibexQuestions)) {
    const parsed = vibexQuestions.flatMap((rawQuestion, index) => {
      const question = asObject(rawQuestion);
      if (!question) return [];
      const choices = parseObjectChoices(question.options);
      const prompt = readString(question.question) || `Question ${index + 1}`;
      return [
        {
          id: readString(question.id) || `question-${index + 1}`,
          fieldName: null,
          header: readString(question.header) || `Question ${index + 1}`,
          question: prompt,
          multiSelect:
            question.multiSelect === true || question.multi_select === true,
          valueType: 'string' as const,
          choices,
        },
      ];
    });
    if (parsed.length > 0) return parsed;
  }

  const properties = asObject(root?.properties);
  if (properties && Object.keys(properties).length > 0) {
    return Object.entries(properties).map(([name, rawProperty], index) => {
      const property = asObject(rawProperty) ?? {};
      const rawType = readString(property.type);
      const valueType =
        rawType === 'number' || rawType === 'integer' || rawType === 'boolean'
          ? rawType
          : 'string';
      const isArray = rawType === 'array';
      return {
        id: name,
        fieldName: name,
        header: readString(property.title) || `Question ${index + 1}`,
        question:
          readString(property.description) ||
          readString(property.title) ||
          request.prompt,
        multiSelect: isArray,
        valueType,
        choices: isArray
          ? parseSchemaChoices(asObject(property.items) ?? {})
          : valueType === 'boolean'
            ? [booleanChoice(true, 'Yes'), booleanChoice(false, 'No')]
            : parseSchemaChoices(property),
      };
    });
  }

  return [
    {
      id: 'answer',
      fieldName: 'answer',
      header: request.prompt,
      question: request.prompt,
      multiSelect: false,
      valueType: 'string',
      choices: request.options.map((label) =>
        choiceFromLabel(label, label, '')
      ),
    },
  ];
}

function parseObjectChoices(rawChoices: unknown): QuestionChoice[] {
  if (!Array.isArray(rawChoices)) return [];
  return rawChoices.flatMap((rawChoice) => {
    const choice = asObject(rawChoice);
    const rawLabel = readString(choice?.label);
    if (!rawLabel) return [];
    return [
      choiceFromLabel(rawLabel, rawLabel, readString(choice?.description)),
    ];
  });
}

function parseSchemaChoices(
  property: Record<string, unknown>
): QuestionChoice[] {
  if (Array.isArray(property.oneOf)) {
    return parseConstChoices(property.oneOf);
  }
  if (Array.isArray(property.anyOf)) {
    return parseConstChoices(property.anyOf);
  }
  if (!Array.isArray(property.enum)) return [];
  return property.enum.flatMap((value) =>
    isPrimitive(value) ? [choiceFromLabel(value, String(value), '')] : []
  );
}

function parseConstChoices(rawChoices: unknown[]): QuestionChoice[] {
  return rawChoices.flatMap((rawChoice) => {
    const choice = asObject(rawChoice);
    const value = choice?.const;
    if (!isPrimitive(value)) return [];
    const label = readString(choice?.title) || String(value);
    return [choiceFromLabel(value, label, readString(choice?.description))];
  });
}

function booleanChoice(value: boolean, label: string): QuestionChoice {
  return {
    value,
    label,
    description: '',
    recommended: false,
  };
}

function choiceFromLabel(
  value: PrimitiveValue,
  rawLabel: string,
  description: string
): QuestionChoice {
  const recommendedMatch = rawLabel.match(/^(.*?)\s*\(recommended\)\s*$/i);
  const visibleLabel = recommendedMatch?.[1]?.trim();
  return {
    value,
    label: visibleLabel || rawLabel,
    description,
    recommended: Boolean(visibleLabel),
  };
}

function initialAnswerState(
  questions: QuestionTab[]
): Record<string, QuestionAnswerState> {
  return Object.fromEntries(
    questions.map((question) => {
      const recommended = question.choices.filter(
        (choice) => choice.recommended
      );
      return [
        question.id,
        {
          selected: question.multiSelect
            ? recommended.map((choice) => choice.value)
            : recommended.slice(0, 1).map((choice) => choice.value),
          customActive: question.choices.length === 0,
          customText: '',
        },
      ];
    })
  );
}

function emptyQuestionAnswerState(): QuestionAnswerState {
  return { selected: [], customActive: false, customText: '' };
}

function hasAnswer(answer: QuestionAnswerState | undefined): boolean {
  if (!answer) return false;
  return (
    answer.selected.length > 0 ||
    (answer.customActive && answer.customText.trim().length > 0)
  );
}

function responseContent(
  request: ConversationQuestionRequest,
  questions: QuestionTab[],
  state: Record<string, QuestionAnswerState>
) {
  const root = asObject(request.schema);
  if (Array.isArray(root?.['x-vibex-questions'])) {
    return {
      answers: questions.map((question) => ({
        questionId: question.id,
        labels: answerLabels(question, state[question.id]),
      })),
    };
  }

  const content: Record<string, PrimitiveValue | PrimitiveValue[]> = {};
  for (const question of questions) {
    const answer = state[question.id];
    const fieldName = question.fieldName ?? question.id;
    if (answer?.customActive && answer.customText.trim()) {
      const customValue = parseCustomValue(
        answer.customText.trim(),
        question.valueType
      );
      content[fieldName] = question.multiSelect
        ? [...answer.selected, customValue]
        : customValue;
      continue;
    }
    content[fieldName] = question.multiSelect
      ? (answer?.selected ?? [])
      : (answer?.selected[0] ?? '');
  }
  return content;
}

function answerLabels(
  question: QuestionTab,
  answer: QuestionAnswerState | undefined
): string[] {
  const labels = (answer?.selected ?? []).map((selected) => {
    const choice = question.choices.find((item) => item.value === selected);
    if (!choice) return String(selected);
    return choice.recommended ? `${choice.label} (Recommended)` : choice.label;
  });
  if (answer?.customActive && answer.customText.trim()) {
    labels.push(answer.customText.trim());
  }
  return labels;
}

function parseCustomValue(
  value: string,
  valueType: QuestionTab['valueType']
): PrimitiveValue {
  if (valueType === 'number') return Number(value);
  if (valueType === 'integer') return Number.parseInt(value, 10);
  if (valueType === 'boolean') return value.toLowerCase() === 'true';
  return value;
}

function isPrimitive(value: unknown): value is PrimitiveValue {
  return (
    typeof value === 'string' ||
    typeof value === 'number' ||
    typeof value === 'boolean'
  );
}

function readString(value: unknown): string {
  return typeof value === 'string' ? value.trim() : '';
}

function asObject(value: unknown): Record<string, unknown> | null {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}
