import { memo, useMemo } from 'react';
import { useTranslation } from 'react-i18next';
import type { ConversationItem } from '../../../../types';

type SubmittedQuestion = {
  id: string;
  header: string;
  question: string;
  options?: Array<{ label: string; description: string }>;
  selectedOptions: string[];
  note: string;
};

type SubmittedPayload = {
  schema: 'requestUserInputSubmitted/v1';
  submittedAt: number;
  questions: SubmittedQuestion[];
};

interface RequestUserInputSubmittedBlockProps {
  item: Extract<ConversationItem, { kind: 'tool' }>;
}

function parseSubmittedPayload(detail: string): SubmittedPayload | null {
  if (!detail.trim()) {
    return null;
  }
  try {
    const parsed = JSON.parse(detail) as Partial<SubmittedPayload> | null;
    if (!parsed || parsed.schema !== 'requestUserInputSubmitted/v1') {
      return null;
    }
    if (!Array.isArray(parsed.questions)) {
      return null;
    }
    return {
      schema: 'requestUserInputSubmitted/v1',
      submittedAt:
        typeof parsed.submittedAt === 'number' ? parsed.submittedAt : Date.now(),
      questions: parsed.questions.map((question) => ({
        id: typeof question?.id === 'string' ? question.id : '',
        header: typeof question?.header === 'string' ? question.header : '',
        question: typeof question?.question === 'string' ? question.question : '',
        options: Array.isArray(question?.options)
          ? question.options
              .map((option) => ({
                label: typeof option?.label === 'string' ? option.label : '',
                description:
                  typeof option?.description === 'string' ? option.description : '',
              }))
              .filter((option) => option.label || option.description)
          : undefined,
        selectedOptions: Array.isArray(question?.selectedOptions)
          ? question.selectedOptions.filter(
              (value): value is string => typeof value === 'string' && value.trim().length > 0,
            )
          : [],
        note: typeof question?.note === 'string' ? question.note : '',
      })),
    };
  } catch {
    return null;
  }
}

export const RequestUserInputSubmittedBlock = memo(
  function RequestUserInputSubmittedBlock({
    item,
  }: RequestUserInputSubmittedBlockProps) {
    const { t } = useTranslation();
    const payload = useMemo(() => parseSubmittedPayload(item.detail), [item.detail]);

    if (!payload || payload.questions.length === 0) {
      return (
        <div className="message request-user-input-message request-user-input-history">
          <div className="bubble request-user-input-card is-submitted">
            <div className="request-user-input-header">
              <div className="request-user-input-title">{t('approval.inputRequested')}</div>
              <div className="request-user-input-badge">{t('approval.submitted')}</div>
            </div>
            <div className="request-user-input-submitted-fallback">
              {item.output || t('approval.none')}
            </div>
          </div>
        </div>
      );
    }

    return (
      <div className="message request-user-input-message request-user-input-history">
        <div
          className="bubble request-user-input-card is-submitted"
          role="group"
          aria-label={t('approval.userInputRequested')}
        >
          <div className="request-user-input-header">
            <div className="request-user-input-title">{t('approval.inputRequested')}</div>
            <div className="request-user-input-badge">{t('approval.submitted')}</div>
          </div>
          <div className="request-user-input-body">
            {payload.questions.map((question, index) => {
              const questionId = question.id || `submitted-question-${index}`;
              const selectedSet = new Set(question.selectedOptions);
              const hasOptions = Array.isArray(question.options) && question.options.length > 0;
              const hasSelectedOptions = question.selectedOptions.length > 0;
              const hasNote = question.note.trim().length > 0;
              const hasAnswer = hasSelectedOptions || hasNote;
              return (
                <section key={questionId} className="request-user-input-question">
                  {question.header ? (
                    <div className="request-user-input-question-header">{question.header}</div>
                  ) : null}
                  <div className="request-user-input-question-text">{question.question}</div>
                  {hasOptions ? (
                    <div className="request-user-input-options">
                      {question.options?.map((option, optionIndex) => (
                        <div
                          key={`${questionId}-${optionIndex}`}
                          className={`request-user-input-option${
                            selectedSet.has(option.label) ? ' is-selected' : ''
                          }`}
                        >
                          <div className="request-user-input-option-label">
                            {option.label}
                          </div>
                          {option.description ? (
                            <div className="request-user-input-option-description">
                              {option.description}
                            </div>
                          ) : null}
                        </div>
                      ))}
                    </div>
                  ) : null}
                  {hasSelectedOptions && !hasOptions ? (
                    <div className="request-user-input-submitted-answer-list">
                      {question.selectedOptions.map((answer, answerIndex) => (
                        <div
                          key={`${questionId}-answer-${answerIndex}`}
                          className="request-user-input-submitted-answer-chip"
                        >
                          {answer}
                        </div>
                      ))}
                    </div>
                  ) : null}
                  {hasNote ? (
                    <div className="request-user-input-notes is-readonly">
                      {question.note}
                    </div>
                  ) : null}
                  {!hasAnswer ? (
                    <div className="request-user-input-answer-empty">
                      {t('approval.none')}
                    </div>
                  ) : null}
                </section>
              );
            })}
          </div>
        </div>
      </div>
    );
  },
);

export default RequestUserInputSubmittedBlock;
