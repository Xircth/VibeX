import type {
  ConversationQuestionRequest,
  ConversationQuestionResponse,
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
  /** Schema property that carries the typed answer when the agent offers a
   *  dedicated free-text companion for this question. */
  customFieldName: string | null;
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
  /(ask_user_question|askuserquestion|ask_question|askquestion|request_user_input|requestuserinput|(^|[/:._-])(ask|question)([/:._-]|$))/i;

const CUSTOM_FIELD_SUFFIX = '_custom';

export function isQuestionToolName(toolName: string): boolean {
  return QUESTION_TOOL_NAME.test(toolName);
}

function hasStructuredQuestions(
  record: Record<string, unknown> | null
): boolean {
  if (!record) return false;
  const rawQuestions =
    typeof record.questions === 'string'
      ? parseJson(record.questions)
      : record.questions;
  if (!Array.isArray(rawQuestions) || rawQuestions.length === 0) return false;
  const first = asObject(rawQuestions[0]);
  return Boolean(
    first && readString(first.question) && Array.isArray(first.options)
  );
}

export function isAskQuestionTool(use: ToolUseBlock): boolean {
  if (use.tool_use_id?.startsWith('interaction_')) return true;
  const meta = asObject(use.meta);
  const vendor = asObject(meta?.['x.ai/tool']);
  const vendorName = readString(vendor?.name);
  if (vendorName && isQuestionToolName(vendorName)) return true;
  const vendorKind = readString(vendor?.kind) || readString(use.kind);
  if (vendorKind.replace(/[\s._-]/g, '').toLowerCase() === 'askuser') {
    return true;
  }
  if (isQuestionToolName(use.tool_name)) return true;
  const parsedInput = parseJson(use.input_preview);
  const input = asObject(parsedInput);
  const nestedToolName =
    readString(input?.tool_name) ||
    readString(input?.toolName) ||
    readString(input?.ToolName) ||
    readString(input?.tool) ||
    readString(input?.name);
  if (nestedToolName && isQuestionToolName(nestedToolName)) return true;
  return hasStructuredQuestions(unwrapQuestionToolRecord(parsedInput));
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
      const explicitChoices = parseObjectChoices(question.options);
      const choices =
        explicitChoices.length > 0
          ? explicitChoices
          : vibexQuestions.length === 1 && request.options.length > 0
            ? request.options.map((label) => choiceFromLabel(label, label, ''))
            : [];
      const prompt = readString(question.question) || `Question ${index + 1}`;
      const id = readString(question.id) || `question-${index + 1}`;
      const fieldName = readString(question.fieldName) || null;
      const customFieldName =
        readString(question.customFieldName) ||
        readString(question.custom_field_name) ||
        null;
      return [
        {
          id,
          fieldName,
          customFieldName,
          header: readString(question.header) || `Question ${index + 1}`,
          question: prompt,
          multiSelect:
            question.multiSelect === true ||
            question.multi_select === true ||
            question.is_multi_select === true,
          valueType: 'string' as const,
          choices,
        },
      ];
    });
    if (parsed.length > 0) return parsed;
  }

  const properties = asObject(root?.properties);
  if (properties && Object.keys(properties).length > 0) {
    const companions = customAnswerCompanions(properties, root?.required);
    const propertyNames = Object.keys(properties).filter(
      (name) => !companions.has(name)
    );
    const requiredOrder = stringList(root?.required).filter(
      (name) =>
        Object.prototype.hasOwnProperty.call(properties, name) &&
        !companions.has(name)
    );
    const names =
      requiredOrder.length === propertyNames.length && requiredOrder.length > 1
        ? requiredOrder
        : propertyNames;
    const companionByQuestion = new Map(
      [...companions].map(([companion, question]) => [question, companion])
    );
    return names.map((name, index) => {
      const property = asObject(properties[name]) ?? {};
      const rawType = readString(property.type);
      const valueType =
        rawType === 'number' || rawType === 'integer' || rawType === 'boolean'
          ? rawType
          : 'string';
      const isArray = rawType === 'array';
      const title = readString(property.title);
      const description = readString(property.description);
      return {
        id: name,
        fieldName: name,
        customFieldName: companionByQuestion.get(name) ?? null,
        header: title || `Question ${index + 1}`,
        question:
          description ||
          (names.length === 1 ? request.prompt || title : title) ||
          request.prompt,
        multiSelect: isArray,
        valueType,
        choices: schemaPropertyChoices(property, rawType),
      };
    });
  }

  const fallbackPrompt = isQuestionToolName(request.prompt)
    ? ''
    : request.prompt.trim();
  if (!fallbackPrompt && request.options.length === 0) {
    return [];
  }

  return [
    {
      id: 'answer',
      fieldName: 'answer',
      customFieldName: null,
      header: fallbackPrompt,
      question: fallbackPrompt,
      multiSelect: false,
      valueType: 'string',
      choices: request.options.map((label) =>
        choiceFromLabel(label, label, '')
      ),
    },
  ];
}

function unwrapQuestionToolRecord(
  value: unknown
): Record<string, unknown> | null {
  let current = asObject(typeof value === 'string' ? parseJson(value) : value);
  for (let depth = 0; depth < 4 && current; depth += 1) {
    if (
      Array.isArray(current.questions) ||
      typeof current.questions === 'string' ||
      readString(current.question) ||
      readString(current.prompt) ||
      readString(current.message)
    ) {
      return current;
    }
    const nestedRaw =
      current.arguments ??
      current.Arguments ??
      current.tool_input ??
      current.input ??
      current.params ??
      current.preview;
    const nested = asObject(
      typeof nestedRaw === 'string' ? parseJson(nestedRaw) : nestedRaw
    );
    if (!nested) break;
    current = nested;
  }
  return current;
}

export function questionRequestFromToolUse(
  use: ToolUseBlock
): ConversationQuestionRequest {
  const record = unwrapQuestionToolRecord(parseJson(use.input_preview));
  const rawQuestions =
    typeof record?.questions === 'string'
      ? parseJson(record.questions)
      : record?.questions;
  const questions = Array.isArray(rawQuestions) ? rawQuestions : [];
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
          question.multiSelect === true ||
          question.multi_select === true ||
          question.is_multi_select === true,
        options: Array.isArray(question.options) ? question.options : [],
      },
    ];
  });
  if (parsedQuestions.length === 0 && record) {
    const prompt =
      readString(record.question) ||
      readString(record.prompt) ||
      readString(record.message);
    if (prompt && !isQuestionToolName(prompt)) {
      parsedQuestions.push({
        id: 'answer',
        header: prompt,
        question: prompt,
        multiSelect: false,
        options: Array.isArray(record.options) ? record.options : [],
      });
    }
  }
  const prompt = parsedQuestions
    .map((question) => question.question)
    .join('\n');
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

export function mergeQuestionRequestWithToolUse(
  request: ConversationQuestionRequest,
  use?: ToolUseBlock | null
): ConversationQuestionRequest {
  if (!use) return request;
  const fromUse = questionRequestFromToolUse(use);
  const useRoot = asObject(fromUse.schema);
  const rawUseQuestions = useRoot?.['x-vibex-questions'];
  if (!Array.isArray(rawUseQuestions) || rawUseQuestions.length === 0) {
    return request;
  }
  const useQuestions = rawUseQuestions
    .map((item) => asObject(item))
    .filter((item): item is Record<string, unknown> => item !== null);
  if (useQuestions.length === 0) return request;

  const root = asObject(request.schema);
  const properties = asObject(root?.properties);
  if (root && properties && Object.keys(properties).length > 0) {
    const companions = customAnswerCompanions(properties, root.required);
    const existingRequired = stringList(root.required).filter(
      (name) =>
        Object.prototype.hasOwnProperty.call(properties, name) &&
        !companions.has(name)
    );
    const useIdOrder = useQuestions
      .map((q) => readString(q.id))
      .filter(
        (id) =>
          id &&
          Object.prototype.hasOwnProperty.call(properties, id) &&
          !companions.has(id)
      );
    const baseOrder =
      existingRequired.length > 0 ? existingRequired : useIdOrder;
    const remaining = Object.keys(properties).filter(
      (name) => !companions.has(name) && !baseOrder.includes(name)
    );
    const orderedKeys = [...baseOrder, ...remaining];

    let changed = existingRequired.length === 0 && orderedKeys.length > 0;
    const nextProperties: Record<string, unknown> = { ...properties };

    orderedKeys.forEach((key, idx) => {
      const prop = asObject(properties[key]);
      if (!prop) return;
      const propTitle = readString(prop.title);
      const matched =
        useQuestions.find((q) => readString(q.id) === key) ??
        (propTitle
          ? useQuestions.find((q) => readString(q.header) === propTitle)
          : undefined) ??
        (useQuestions.length === orderedKeys.length
          ? useQuestions[idx]
          : undefined);
      if (!matched) return;

      const nextProp: Record<string, unknown> = { ...prop };
      let propChanged = false;

      if (!readString(nextProp.description) && readString(matched.question)) {
        nextProp.description = readString(matched.question);
        propChanged = true;
      }
      if (!readString(nextProp.title) && readString(matched.header)) {
        nextProp.title = readString(matched.header);
        propChanged = true;
      }
      const rawType = readString(nextProp.type);
      if (
        schemaPropertyChoices(nextProp, rawType).length === 0 &&
        Array.isArray(matched.options) &&
        matched.options.length > 0
      ) {
        const choices = parseObjectChoices(matched.options);
        if (choices.length > 0) {
          const constItems = choices.map((c) => ({
            const: c.value,
            title: c.label,
            ...(c.description ? { description: c.description } : {}),
          }));
          if (rawType === 'array') {
            nextProp.items = {
              ...(asObject(nextProp.items) ?? { type: 'string' }),
              anyOf: constItems,
            };
          } else {
            nextProp.oneOf = constItems;
          }
          propChanged = true;
        }
      }
      if (propChanged) {
        nextProperties[key] = nextProp;
        changed = true;
      }
    });

    if (!changed) return request;
    return {
      ...request,
      schema: {
        ...root,
        properties: nextProperties,
        ...(existingRequired.length === 0 && orderedKeys.length > 0
          ? { required: orderedKeys }
          : {}),
      } as ConversationQuestionRequest['schema'],
    };
  }

  const existingTabs = questionTabsFromRequest(request);
  const existingHasChoices = existingTabs.some((t) => t.choices.length > 0);
  if (existingTabs.length >= useQuestions.length && existingHasChoices) {
    return request;
  }

  return {
    ...request,
    prompt: request.prompt || fromUse.prompt,
    schema: {
      ...(root ?? { type: 'object' }),
      'x-vibex-questions': rawUseQuestions,
    } as ConversationQuestionRequest['schema'],
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
  const candidate = questions[0]?.question || questions[0]?.header || '';
  return isQuestionToolName(candidate) ? '' : candidate;
}

export function responseContent(
  request: ConversationQuestionRequest,
  questions: QuestionTab[],
  state: Record<string, QuestionAnswerState>
) {
  const root = asObject(request.schema);
  if (Array.isArray(root?.['x-vibex-questions'])) {
    const answers = questions.map((question) => {
      const answer = state[question.id];
      const labels = answerLabels(question, answer);
      if (!question.fieldName && !question.customFieldName) {
        return {
          questionId: question.id,
          labels,
        };
      }
      const customText =
        answer?.customActive && answer.customText.trim()
          ? answer.customText.trim()
          : '';
      return {
        questionId: question.id,
        labels,
        selected: answer?.selected ?? [],
        multiSelect: question.multiSelect,
        ...(question.customFieldName
          ? { customFieldName: question.customFieldName }
          : {}),
        ...(customText ? { customText } : {}),
      };
    });
    return {
      answers,
    };
  }

  const content: Record<string, PrimitiveValue | PrimitiveValue[]> = {};
  for (const question of questions) {
    const answer = state[question.id];
    const fieldName = question.fieldName ?? question.id;
    const customText =
      answer?.customActive && answer.customText.trim()
        ? answer.customText.trim()
        : '';
    if (customText && question.customFieldName) {
      if (question.multiSelect) {
        content[fieldName] = answer?.selected ?? [];
      } else if (answer?.selected.length) {
        content[fieldName] = answer.selected[0];
      }
      content[question.customFieldName] = customText;
      continue;
    }
    if (customText) {
      const customValue = parseCustomValue(customText, question.valueType);
      content[fieldName] = question.multiSelect
        ? [...(answer?.selected ?? []), customValue]
        : customValue;
      continue;
    }
    content[fieldName] = question.multiSelect
      ? (answer?.selected ?? [])
      : (answer?.selected[0] ?? '');
  }
  return content;
}

/**
 * Agents such as Claude Code pair every select question `<id>` with an
 * optional free-text field `<id>_custom` for "my own answer". Both belong to
 * one question, so the companion is returned (keyed by its own name) instead
 * of becoming a question of its own. A required or unpaired text field is a
 * real question and is never folded.
 */
function customAnswerCompanions(
  properties: Record<string, unknown>,
  required: unknown
): Map<string, string> {
  const requiredNames = new Set(stringList(required));
  const companions = new Map<string, string>();
  for (const [name, rawProperty] of Object.entries(properties)) {
    if (!name.endsWith(CUSTOM_FIELD_SUFFIX) || requiredNames.has(name))
      continue;
    const questionName = name.slice(0, -CUSTOM_FIELD_SUFFIX.length);
    const question = asObject(properties[questionName]);
    const companion = asObject(rawProperty);
    if (!question || !companion) continue;
    const questionType = readString(question.type);
    if (questionType !== 'string' && questionType !== 'array') continue;
    if (schemaPropertyChoices(question, questionType).length === 0) continue;
    if (readString(companion.type) !== 'string') continue;
    if (parseSchemaChoices(companion).length > 0) continue;
    companions.set(name, questionName);
  }
  return companions;
}

function schemaPropertyChoices(
  property: Record<string, unknown>,
  rawType: string
): QuestionChoice[] {
  if (rawType === 'array') {
    return parseSchemaChoices(asObject(property.items) ?? {});
  }
  if (rawType === 'boolean') {
    return [booleanChoice(true, 'Yes'), booleanChoice(false, 'No')];
  }
  return parseSchemaChoices(property);
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
      const state = answerStateFromQuestionLabels(question, labels);
      const typed = question.customFieldName
        ? (labelsById.get(question.customFieldName) ?? [])
        : [];
      if (typed.length === 0) return [question.id, state];
      return [
        question.id,
        {
          ...state,
          customActive: true,
          customText: [state.customText, ...typed]
            .filter((text) => text)
            .join('\n'),
        },
      ];
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
  if (
    choice.recommended &&
    (`${choice.label} (Recommended)` === trimmed ||
      `(Recommended) ${choice.label}` === trimmed ||
      `${choice.label} (推荐)` === trimmed ||
      `(推荐) ${choice.label}` === trimmed ||
      `${choice.label}（推荐）` === trimmed ||
      `（推荐）${choice.label}` === trimmed ||
      `${choice.label} （推荐）` === trimmed ||
      `（推荐） ${choice.label}` === trimmed)
  ) {
    return true;
  }
  return false;
}

function labelsByQuestionId(content: unknown): Map<string, string[]> {
  const labels = new Map<string, string[]>();
  if (typeof content === 'string') {
    const arrowMatches = [...content.matchAll(/^\s*→\s*(.+)$/gm)];
    arrowMatches.forEach((match, index) => {
      const selected = match[1]?.trim();
      if (selected && selected !== '(no selection)') {
        labels.set(
          `question-${index + 1}`,
          selected
            .split(/\s*,\s*/)
            .map((item) => item.trim())
            .filter(Boolean)
        );
      }
    });
    return labels;
  }
  const root = asObject(content);
  if (!root) return labels;

  if (Array.isArray(root.answers)) {
    root.answers.forEach((item, index) => {
      const answer = asObject(item);
      if (!answer) return;
      const id =
        readString(answer.questionId) ||
        readString(answer.question_id) ||
        `question-${index + 1}`;
      const labelValues = stringList(answer.labels);
      const values =
        labelValues.length > 0 ? labelValues : stringList(answer.selected);
      if (id && values.length > 0) labels.set(id, values);
    });
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
    const rawValue = isPrimitive(choice?.value)
      ? choice.value
      : isPrimitive(choice?.const)
        ? choice.const
        : null;
    const rawLabel =
      readString(choice?.label) ||
      readString(choice?.title) ||
      (rawValue !== null ? String(rawValue) : '');
    if (!rawLabel) return [];
    return [
      choiceFromLabel(
        rawValue ?? rawLabel,
        rawLabel,
        readString(choice?.description)
      ),
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
  const suffixMatch = rawLabel.match(
    /^(.*?)\s*[(（](?:recommended|推荐)[)）]\s*$/i
  );
  const prefixMatch = rawLabel.match(
    /^\s*[(（](?:recommended|推荐)[)）]\s*(.+)$/i
  );
  const visibleLabel = (suffixMatch?.[1] ?? prefixMatch?.[1])?.trim();
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
