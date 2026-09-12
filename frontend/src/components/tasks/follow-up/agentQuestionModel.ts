import type {
  ConversationQuestionRequest,
  ConversationQuestionResponse,
  MessageTurn,
} from 'shared/types';
import type {
  ToolResultBlock,
  ToolUseBlock,
} from '@/components/NormalizedConversation/messageTurnBlocks';

export type PrimitiveValue = string | number | boolean;

export type QuestionChoice = {
  value: PrimitiveValue;
  label: string;
  description: string;
  recommended: boolean;
};

export type QuestionTab = {
  id: string;
  fieldName: string | null;
  header: string;
  question: string;
  multiSelect: boolean;
  valueType: 'string' | 'number' | 'integer' | 'boolean';
  choices: QuestionChoice[];
};

export type QuestionAnswerState = {
  selected: PrimitiveValue[];
  customActive: boolean;
  customText: string;
};

const QUESTION_TOOL_NAME =
  /(ask_user_question|(^|[_-])(ask|question|request_user_input)([_-]|$))/i;

export function isQuestionToolName(toolName: string): boolean {
  return QUESTION_TOOL_NAME.test(toolName);
}

export function isAskQuestionTool(use: ToolUseBlock): boolean {
  const meta = asObject(use.meta);
  const vendor = asObject(meta?.['x.ai/tool']);
  const vendorName = readString(vendor?.name);
  if (vendorName && isQuestionToolName(vendorName)) return true;
  const vendorKind = readString(vendor?.kind) || readString(use.kind);
  if (vendorKind.replace(/[\s._-]/g, '').toLowerCase() === 'askuser') {
    return true;
  }
  return isQuestionToolName(use.tool_name);
}

export function hasAskQuestionTool(turns: MessageTurn[]): boolean {
  return turns.some((turn) =>
    turn.blocks.some(
      (block) => block.type === 'tool_use' && isAskQuestionTool(block)
    )
  );
}

export function questionTabsFromRequest(
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

export function questionRequestFromToolUse(
  use: ToolUseBlock
): ConversationQuestionRequest {
  const input = parseJson(use.input_preview);
  const record = asObject(input);
  const questions = Array.isArray(record?.questions) ? record.questions : [];
  const parsedQuestions = questions.flatMap((rawQuestion, index) => {
    const question = asObject(rawQuestion);
    if (!question) return [];
    const prompt = readString(question.question);
    if (!prompt) return [];
    return [
      {
        id: readString(question.id) || `question-${index + 1}`,
        header: readString(question.header) || prompt,
        question: prompt,
        multiSelect:
          question.multiSelect === true || question.multi_select === true,
        options: Array.isArray(question.options) ? question.options : [],
      },
    ];
  });
  if (parsedQuestions.length === 0 && record) {
    const prompt =
      readString(record.question) ||
      readString(record.prompt) ||
      readString(record.message);
    if (prompt) {
      parsedQuestions.push({
        id: 'answer',
        header: prompt,
        question: prompt,
        multiSelect: false,
        options: Array.isArray(record.options) ? record.options : [],
      });
    }
  }
  const prompt =
    parsedQuestions.map((question) => question.question).join('\n') ||
    use.tool_name;
  return {
    question_id: use.tool_use_id || use.tool_name,
    prompt,
    options: [],
    schema:
      parsedQuestions.length > 0
        ? { type: 'object', 'x-vibex-questions': parsedQuestions }
        : null,
  };
}

export function emptyQuestionAnswerState(): QuestionAnswerState {
  return { selected: [], customActive: false, customText: '' };
}

export function initialAnswerState(
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

export function hasAnswer(answer: QuestionAnswerState | undefined): boolean {
  if (!answer) return false;
  return (
    answer.selected.length > 0 ||
    (answer.customActive && answer.customText.trim().length > 0)
  );
}

export function hasCompletedAnswers(
  state: Record<string, QuestionAnswerState>
): boolean {
  return Object.values(state).some(hasAnswer);
}

export function answerStateFromResponse(
  questions: QuestionTab[],
  response: ConversationQuestionResponse | null | undefined
): Record<string, QuestionAnswerState> | null {
  if (!response || isDeclinedContent(response.content)) return null;
  const labelsById = labelsByQuestionId(response.content);
  if (labelsById.size === 0 && !response.answer.trim()) return null;
  return answerStateFromLabels(questions, labelsById, response.answer);
}

export function answerStateFromToolResult(
  questions: QuestionTab[],
  result: ToolResultBlock | null | undefined
): Record<string, QuestionAnswerState> | null {
  if (!result?.output_preview) return null;
  const parsed = parseJson(result.output_preview);
  if (isDeclinedContent(parsed)) return null;
  const labelsById = labelsByQuestionId(parsed);
  if (labelsById.size === 0) return null;
  return answerStateFromLabels(questions, labelsById, '');
}

export function firstQuestionTitle(questions: QuestionTab[]): string {
  return questions[0]?.question || questions[0]?.header || '';
}

export function responseContent(
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

function answerStateFromLabels(
  questions: QuestionTab[],
  labelsById: Map<string, string[]>,
  fallbackAnswer: string
): Record<string, QuestionAnswerState> {
  return Object.fromEntries(
    questions.map((question, index) => {
      const labels =
        labelsById.get(question.id) ??
        (question.fieldName ? labelsById.get(question.fieldName) : undefined) ??
        (index === 0 && labelsById.size === 0 && fallbackAnswer
          ? [fallbackAnswer]
          : []);
      return [question.id, answerStateFromQuestionLabels(question, labels)];
    })
  );
}

function answerStateFromQuestionLabels(
  question: QuestionTab,
  labels: string[]
): QuestionAnswerState {
  const selected: PrimitiveValue[] = [];
  const custom: string[] = [];
  for (const label of labels) {
    const choice = question.choices.find((item) => matchesChoice(item, label));
    if (choice) {
      selected.push(choice.value);
    } else if (label.trim()) {
      custom.push(label.trim());
    }
  }
  return {
    selected,
    customActive: custom.length > 0,
    customText: custom.join('\n'),
  };
}

function matchesChoice(choice: QuestionChoice, label: string): boolean {
  const trimmed = label.trim();
  if (!trimmed) return false;
  if (String(choice.value) === trimmed) return true;
  if (choice.label === trimmed) return true;
  if (choice.recommended && `${choice.label} (Recommended)` === trimmed) {
    return true;
  }
  if (choice.recommended && `${choice.label} (推荐)` === trimmed) {
    return true;
  }
  return false;
}

function labelsByQuestionId(content: unknown): Map<string, string[]> {
  const labels = new Map<string, string[]>();
  const root = asObject(content);
  if (!root) return labels;

  if (Array.isArray(root.answers)) {
    for (const item of root.answers) {
      const answer = asObject(item);
      if (!answer) continue;
      const id =
        readString(answer.questionId) || readString(answer.question_id);
      const values = stringList(answer.labels) || stringList(answer.selected);
      if (id && values.length > 0) labels.set(id, values);
    }
    if (labels.size > 0) return labels;
  }

  const answersObject = asObject(root.answers) ?? root;
  for (const [key, value] of Object.entries(answersObject)) {
    if (key === 'answers' || key === 'outcome' || key === 'declined') continue;
    const values = stringList(value);
    if (values.length > 0) labels.set(key, values);
  }
  return labels;
}

function isDeclinedContent(content: unknown): boolean {
  const root = asObject(content);
  if (!root) return false;
  if (root.declined === true) return true;
  const outcome = readString(root.outcome).toLowerCase();
  return (
    outcome === 'cancelled' || outcome === 'canceled' || outcome === 'declined'
  );
}

function stringList(value: unknown): string[] {
  if (typeof value === 'string' && value.trim()) return [value.trim()];
  if (!Array.isArray(value)) return [];
  return value.flatMap((item) =>
    typeof item === 'string' && item.trim() ? [item.trim()] : []
  );
}

function parseObjectChoices(rawChoices: unknown): QuestionChoice[] {
  if (!Array.isArray(rawChoices)) return [];
  return rawChoices.flatMap((rawChoice) => {
    if (typeof rawChoice === 'string' && rawChoice.trim()) {
      return [choiceFromLabel(rawChoice.trim(), rawChoice.trim(), '')];
    }
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
  const recommendedMatch = rawLabel.match(
    /^(.*?)\s*\((?:recommended|推荐)\)\s*$/i
  );
  const visibleLabel = recommendedMatch?.[1]?.trim();
  return {
    value,
    label: visibleLabel || rawLabel,
    description,
    recommended: Boolean(visibleLabel),
  };
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

function parseJson(value: string | null | undefined): unknown {
  if (!value) return null;
  try {
    return JSON.parse(value);
  } catch {
    return value;
  }
}

function readString(value: unknown): string {
  return typeof value === 'string' ? value.trim() : '';
}

function asObject(value: unknown): Record<string, unknown> | null {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}
