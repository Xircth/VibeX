import { useMemo, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { CircleHelp } from 'lucide-react';
import type {
  AgentElicitationResponse,
  ConversationQuestionRequest,
  ConversationQuestionResponse,
} from 'shared/types';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';

/**
 * Inline, answerable agent question (ACP form elicitation — e.g. Claude Code's
 * AskUserQuestion). Renders the request's real JSON Schema (primitive-typed
 * properties per the elicitation spec) as a form anchored in the timeline, and
 * answers with accept/decline. Once a response is folded into the row the card
 * collapses to the recorded answer.
 */
export function QuestionRequestCard({
  request,
  response,
  onRespond,
  responding = false,
}: {
  request: ConversationQuestionRequest;
  response?: ConversationQuestionResponse | null;
  onRespond: (questionId: string, response: AgentElicitationResponse) => void;
  responding?: boolean;
}) {
  const { t } = useTranslation(['conversation', 'common']);
  const fields = useMemo(
    () => parseSchemaFields(request.schema, request.options),
    [request.schema, request.options]
  );
  const [values, setValues] = useState<Record<string, FieldValue>>(() =>
    initialValues(fields)
  );

  if (response) {
    return (
      <div className="conv-entry-item rounded-lg border border-sky-300/55 bg-sky-50/80 px-3 py-2.5 text-sm dark:border-sky-500/30 dark:bg-sky-950/25">
        <div className="flex items-start gap-2.5">
          <QuestionIcon />
          <div className="min-w-0 flex-1">
            <div className="font-medium text-sky-900 dark:text-sky-100">
              {request.prompt}
            </div>
            <div className="mt-1 text-xs text-sky-800/80 dark:text-sky-100/70">
              {t('questionRequestCard.answered')}
              {response.answer ? ` · ${response.answer}` : ''}
            </div>
          </div>
        </div>
      </div>
    );
  }

  const setValue = (name: string, value: FieldValue) =>
    setValues((current) => ({ ...current, [name]: value }));

  const submit = (overrides?: Record<string, FieldValue>) => {
    const content: Record<string, FieldValue> = {};
    for (const field of fields) {
      const value = overrides?.[field.name] ?? values[field.name];
      if (value !== undefined && value !== '') content[field.name] = value;
    }
    onRespond(request.question_id, { action: 'accept', content });
  };

  const missingRequired = fields.some(
    (field) =>
      field.required &&
      (values[field.name] === undefined || values[field.name] === '')
  );

  // Fast path: a single required single-select question answers on click,
  // matching how permission options behave.
  const singleSelect =
    fields.length === 1 && fields[0].kind === 'select' ? fields[0] : null;

  return (
    <div className="conv-entry-item rounded-lg border border-sky-300/55 bg-sky-50/80 px-3 py-2.5 text-sm dark:border-sky-500/30 dark:bg-sky-950/25">
      <div className="flex items-start gap-2.5">
        <QuestionIcon />
        <div className="min-w-0 flex-1">
          <div className="font-medium text-sky-900 dark:text-sky-100">
            {request.prompt}
          </div>

          {singleSelect ? (
            <div className="mt-2.5 flex flex-wrap gap-2">
              {singleSelect.choices.map((choice) => (
                <Button
                  key={choice.value}
                  type="button"
                  size="sm"
                  variant="outline"
                  disabled={responding}
                  title={choice.description ?? undefined}
                  onClick={() => submit({ [singleSelect.name]: choice.value })}
                >
                  {choice.label}
                </Button>
              ))}
            </div>
          ) : (
            <div className="mt-2.5 space-y-2.5">
              {fields.map((field) => (
                <QuestionField
                  key={field.name}
                  field={field}
                  value={values[field.name]}
                  disabled={responding}
                  onChange={(value) => setValue(field.name, value)}
                />
              ))}
              <Button
                type="button"
                size="sm"
                disabled={responding || missingRequired}
                onClick={() => submit()}
              >
                {t('questionRequestCard.submit')}
              </Button>
            </div>
          )}

          <div className="mt-2">
            <Button
              type="button"
              size="sm"
              variant="ghost"
              disabled={responding}
              onClick={() =>
                onRespond(request.question_id, { action: 'decline' })
              }
            >
              {t('questionRequestCard.decline')}
            </Button>
          </div>
        </div>
      </div>
    </div>
  );
}

function QuestionIcon() {
  return (
    <span className="mt-0.5 shrink-0 rounded-md border border-sky-300/60 bg-sky-100/70 p-1 text-sky-700 dark:border-sky-500/30 dark:bg-sky-900/40 dark:text-sky-200">
      <CircleHelp className="h-3.5 w-3.5" />
    </span>
  );
}

function QuestionField({
  field,
  value,
  disabled,
  onChange,
}: {
  field: SchemaField;
  value: FieldValue | undefined;
  disabled: boolean;
  onChange: (value: FieldValue) => void;
}) {
  const label = (
    <div className="text-xs font-medium text-sky-900/90 dark:text-sky-100/90">
      {field.label}
      {field.description ? (
        <span className="ml-1.5 font-normal text-sky-800/70 dark:text-sky-100/60">
          {field.description}
        </span>
      ) : null}
    </div>
  );

  switch (field.kind) {
    case 'select':
      return (
        <div className="space-y-1">
          {label}
          <div className="flex flex-wrap gap-1.5">
            {field.choices.map((choice) => (
              <Button
                key={choice.value}
                type="button"
                size="sm"
                variant={value === choice.value ? 'default' : 'outline'}
                disabled={disabled}
                title={choice.description ?? undefined}
                onClick={() => onChange(choice.value)}
              >
                {choice.label}
              </Button>
            ))}
          </div>
        </div>
      );
    case 'multiselect': {
      const selected = Array.isArray(value) ? value : [];
      const toggle = (choiceValue: string) =>
        onChange(
          selected.includes(choiceValue)
            ? selected.filter((item) => item !== choiceValue)
            : [...selected, choiceValue]
        );
      return (
        <div className="space-y-1">
          {label}
          <div className="flex flex-wrap gap-1.5">
            {field.choices.map((choice) => (
              <Button
                key={choice.value}
                type="button"
                size="sm"
                variant={selected.includes(choice.value) ? 'default' : 'outline'}
                disabled={disabled}
                title={choice.description ?? undefined}
                onClick={() => toggle(choice.value)}
              >
                {choice.label}
              </Button>
            ))}
          </div>
        </div>
      );
    }
    case 'boolean':
      return (
        <label className="flex cursor-pointer items-center gap-2 text-xs text-sky-900/90 dark:text-sky-100/90">
          <input
            type="checkbox"
            className="h-3.5 w-3.5 accent-sky-600"
            checked={value === true}
            disabled={disabled}
            onChange={(event) => onChange(event.target.checked)}
          />
          {field.label}
          {field.description ? (
            <span className="text-sky-800/70 dark:text-sky-100/60">
              {field.description}
            </span>
          ) : null}
        </label>
      );
    case 'number':
      return (
        <div className="space-y-1">
          {label}
          <Input
            type="number"
            className="h-8 max-w-48 text-xs"
            value={value === undefined ? '' : String(value)}
            min={field.minimum ?? undefined}
            max={field.maximum ?? undefined}
            step={field.integer ? 1 : undefined}
            disabled={disabled}
            onChange={(event) => {
              const raw = event.target.value;
              if (raw === '') {
                onChange('');
                return;
              }
              const parsed = field.integer ? parseInt(raw, 10) : Number(raw);
              if (!Number.isNaN(parsed)) onChange(parsed);
            }}
          />
        </div>
      );
    default:
      return (
        <div className="space-y-1">
          {label}
          <Input
            type="text"
            className="h-8 text-xs"
            value={typeof value === 'string' ? value : ''}
            disabled={disabled}
            onChange={(event) => onChange(event.target.value)}
          />
        </div>
      );
  }
}

type FieldValue = string | number | boolean | string[];

type Choice = { value: string; label: string; description?: string | null };

type SchemaField = {
  name: string;
  label: string;
  description: string | null;
  required: boolean;
  kind: 'select' | 'multiselect' | 'boolean' | 'number' | 'text';
  choices: Choice[];
  integer?: boolean;
  minimum?: number | null;
  maximum?: number | null;
  defaultValue?: FieldValue;
};

function initialValues(fields: SchemaField[]): Record<string, FieldValue> {
  const values: Record<string, FieldValue> = {};
  for (const field of fields) {
    if (field.defaultValue !== undefined) values[field.name] = field.defaultValue;
  }
  return values;
}

/**
 * Parse the elicitation form schema (JSON Schema restricted to primitive-typed
 * properties) into renderable fields. Unknown shapes degrade to a text input —
 * the user can always answer, never gets stuck.
 */
function parseSchemaFields(
  schema: unknown,
  legacyOptions: string[]
): SchemaField[] {
  const root = asObject(schema);
  const properties = asObject(root?.properties);
  if (!properties || Object.keys(properties).length === 0) {
    // Degraded fallback: a plain options list becomes one single-select field.
    if (legacyOptions.length > 0) {
      return [
        {
          name: 'answer',
          label: '',
          description: null,
          required: true,
          kind: 'select',
          choices: legacyOptions.map((option) => ({
            value: option,
            label: option,
          })),
        },
      ];
    }
    return [
      {
        name: 'answer',
        label: '',
        description: null,
        required: true,
        kind: 'text',
        choices: [],
      },
    ];
  }

  const required = new Set(
    Array.isArray(root?.required)
      ? (root!.required as unknown[]).filter(
          (name): name is string => typeof name === 'string'
        )
      : []
  );

  return Object.entries(properties).map(([name, rawProp]) => {
    const prop = asObject(rawProp) ?? {};
    const base = {
      name,
      label: typeof prop.title === 'string' ? prop.title : name,
      description:
        typeof prop.description === 'string' ? prop.description : null,
      required: required.has(name),
    };
    const type = typeof prop.type === 'string' ? prop.type : 'string';

    if (type === 'boolean') {
      return {
        ...base,
        kind: 'boolean' as const,
        choices: [],
        defaultValue:
          typeof prop.default === 'boolean' ? prop.default : undefined,
      };
    }
    if (type === 'number' || type === 'integer') {
      return {
        ...base,
        kind: 'number' as const,
        choices: [],
        integer: type === 'integer',
        minimum: typeof prop.minimum === 'number' ? prop.minimum : null,
        maximum: typeof prop.maximum === 'number' ? prop.maximum : null,
        defaultValue:
          typeof prop.default === 'number' ? prop.default : undefined,
      };
    }
    if (type === 'array') {
      return {
        ...base,
        kind: 'multiselect' as const,
        choices: multiSelectChoices(prop.items),
        defaultValue: Array.isArray(prop.default)
          ? (prop.default as unknown[]).filter(
              (item): item is string => typeof item === 'string'
            )
          : undefined,
      };
    }

    const choices = singleSelectChoices(prop);
    return {
      ...base,
      kind: choices.length > 0 ? ('select' as const) : ('text' as const),
      choices,
      defaultValue: typeof prop.default === 'string' ? prop.default : undefined,
    };
  });
}

/** `enum: [..]` (untitled) or `oneOf: [{const, title}]` (titled) single-select. */
function singleSelectChoices(prop: Record<string, unknown>): Choice[] {
  if (Array.isArray(prop.enum)) {
    return (prop.enum as unknown[])
      .filter((value): value is string => typeof value === 'string')
      .map((value) => ({ value, label: value }));
  }
  if (Array.isArray(prop.oneOf)) {
    return enumOptionChoices(prop.oneOf as unknown[]);
  }
  return [];
}

/** Array items: `{type:"string", enum:[..]}` or `{anyOf:[{const, title}]}`. */
function multiSelectChoices(items: unknown): Choice[] {
  const obj = asObject(items);
  if (!obj) return [];
  if (Array.isArray(obj.enum)) {
    return (obj.enum as unknown[])
      .filter((value): value is string => typeof value === 'string')
      .map((value) => ({ value, label: value }));
  }
  if (Array.isArray(obj.anyOf)) {
    return enumOptionChoices(obj.anyOf as unknown[]);
  }
  return [];
}

function enumOptionChoices(options: unknown[]): Choice[] {
  return options.flatMap((raw) => {
    const option = asObject(raw);
    const value = option?.const;
    if (typeof value !== 'string') return [];
    return [
      {
        value,
        label: typeof option?.title === 'string' ? option.title : value,
        description:
          typeof option?.description === 'string' ? option.description : null,
      },
    ];
  });
}

function asObject(value: unknown): Record<string, unknown> | null {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}
