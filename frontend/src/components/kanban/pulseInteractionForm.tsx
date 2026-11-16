import { useMemo, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Check, X, Zap } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Checkbox } from '@/components/ui/checkbox';
import i18n from '@/i18n';
import {
  pulseApi,
  type ApprovalOptionSpec,
  type PulseUserInteractionView,
} from '@/lib/api/pulse';
import { cn } from '@/lib/utils';

export type PulseFormFieldType = 'string' | 'number' | 'integer' | 'boolean';

export type TypedPulseFormField = {
  key: string;
  label: string;
  type: PulseFormFieldType;
  description?: string;
  required: boolean;
  enumOptions?: ReadonlyArray<string | number | boolean>;
  defaultValue?: unknown;
};

function normalizeSchemaType(rawType: unknown): PulseFormFieldType {
  if (Array.isArray(rawType)) {
    const firstNonNull = rawType.find(
      (entry) => typeof entry === 'string' && entry !== 'null'
    );
    return normalizeSchemaType(firstNonNull);
  }
  if (
    rawType === 'number' ||
    rawType === 'integer' ||
    rawType === 'boolean' ||
    rawType === 'string'
  ) {
    return rawType;
  }
  return 'string';
}

export function extractTypedFormFields(
  formSchema?: Record<string, unknown> | null
): TypedPulseFormField[] {
  const defaultField: TypedPulseFormField = {
    key: 'response',
    label: i18n.t('panels:pulseDeck.interaction.responseField'),
    type: 'string',
    required: false,
  };

  if (!formSchema || typeof formSchema !== 'object') {
    return [defaultField];
  }

  const requiredSet = new Set<string>(
    Array.isArray(formSchema.required)
      ? formSchema.required.filter(
          (item): item is string => typeof item === 'string'
        )
      : []
  );

  const properties = formSchema.properties;
  if (!properties || typeof properties !== 'object') {
    return [defaultField];
  }

  const entries = Object.entries(properties as Record<string, unknown>);
  if (entries.length === 0) {
    return [defaultField];
  }

  return entries.map(([key, rawProp]) => {
    const prop =
      rawProp && typeof rawProp === 'object'
        ? (rawProp as Record<string, unknown>)
        : {};
    const label =
      typeof prop.title === 'string' && prop.title.trim()
        ? prop.title.trim()
        : key;
    const description =
      typeof prop.description === 'string' && prop.description.trim()
        ? prop.description.trim()
        : undefined;
    const enumOptions = Array.isArray(prop.enum)
      ? prop.enum.filter(
          (opt): opt is string | number | boolean =>
            typeof opt === 'string' ||
            typeof opt === 'number' ||
            typeof opt === 'boolean'
        )
      : undefined;
    const inferredType =
      prop.type !== undefined
        ? normalizeSchemaType(prop.type)
        : enumOptions && enumOptions.length > 0
          ? typeof enumOptions[0] === 'number'
            ? 'number'
            : typeof enumOptions[0] === 'boolean'
              ? 'boolean'
              : 'string'
          : 'string';

    return {
      key,
      label,
      type: inferredType,
      description,
      required: requiredSet.has(key),
      enumOptions:
        enumOptions && enumOptions.length > 0 ? enumOptions : undefined,
      defaultValue: prop.default,
    };
  });
}

export function buildInitialFormDraft(
  fields: readonly TypedPulseFormField[]
): Record<string, string | boolean> {
  const initial: Record<string, string | boolean> = {};
  for (const field of fields) {
    if (field.type === 'boolean' && !field.enumOptions) {
      initial[field.key] = Boolean(field.defaultValue);
    } else if (
      typeof field.defaultValue === 'string' ||
      typeof field.defaultValue === 'number' ||
      typeof field.defaultValue === 'boolean'
    ) {
      initial[field.key] = String(field.defaultValue);
    } else if (
      field.enumOptions &&
      field.enumOptions.length > 0 &&
      field.required
    ) {
      initial[field.key] = String(field.enumOptions[0]);
    } else {
      initial[field.key] = '';
    }
  }
  return initial;
}

export function coerceAndValidateFormValues(
  fields: readonly TypedPulseFormField[],
  draft: Record<string, string | boolean>
):
  | { ok: true; values: Record<string, unknown> }
  | { ok: false; error: string } {
  const values: Record<string, unknown> = {};

  for (const field of fields) {
    const raw = draft[field.key];

    if (field.enumOptions && field.enumOptions.length > 0) {
      const strVal =
        typeof raw === 'string'
          ? raw
          : raw === undefined
            ? ''
            : String(raw);
      if (!strVal) {
        if (field.required) {
          return {
            ok: false,
            error: i18n.t('panels:pulseDeck.interaction.fieldRequired', {
              label: field.label,
            }),
          };
        }
        continue;
      }
      const matched = field.enumOptions.find(
        (candidate) => String(candidate) === strVal
      );
      if (matched === undefined) {
        return {
          ok: false,
          error: i18n.t('panels:pulseDeck.interaction.fieldInvalidSelection', {
            label: field.label,
          }),
        };
      }
      values[field.key] = matched;
      continue;
    }

    if (field.type === 'boolean') {
      values[field.key] = raw === true || raw === 'true';
      continue;
    }

    const text =
      typeof raw === 'string'
        ? raw.trim()
        : raw !== undefined
          ? String(raw).trim()
          : '';

    if (field.type === 'number' || field.type === 'integer') {
      if (!text) {
        if (field.required) {
          return {
            ok: false,
            error: i18n.t('panels:pulseDeck.interaction.fieldRequired', {
              label: field.label,
            }),
          };
        }
        continue;
      }
      const parsed = Number(text);
      if (!Number.isFinite(parsed)) {
        return {
          ok: false,
          error: i18n.t('panels:pulseDeck.interaction.fieldInvalidNumber', {
            label: field.label,
          }),
        };
      }
      if (field.type === 'integer' && !Number.isInteger(parsed)) {
        return {
          ok: false,
          error: i18n.t('panels:pulseDeck.interaction.fieldInvalidInteger', {
            label: field.label,
          }),
        };
      }
      values[field.key] = parsed;
      continue;
    }

    const rawStr =
      typeof raw === 'string' ? raw : raw !== undefined ? String(raw) : '';
    if (field.required && !rawStr.trim()) {
      return {
        ok: false,
        error: i18n.t('panels:pulseDeck.interaction.fieldRequired', {
          label: field.label,
        }),
      };
    }
    values[field.key] = rawStr;
  }

  return { ok: true, values };
}

export interface PulseInteractionLabels {
  approve?: string;
  reject?: string;
  acknowledge?: string;
  submit?: string;
  decisionNoteAria?: string;
  decisionNotePlaceholder?: string;
  noteRequiredError?: string;
  selectPlaceholder?: string;
}

export function PulseInteractionCard({
  interaction,
  onResolved,
  labels,
  className,
}: {
  interaction: PulseUserInteractionView;
  onResolved: (id: string) => void;
  labels?: PulseInteractionLabels;
  className?: string;
}) {
  const { t, i18n: activeI18n } = useTranslation('panels');
  const formFields = useMemo(
    () =>
      interaction.kind === 'ask_form'
        ? extractTypedFormFields(interaction.formSchema)
        : [],
    [interaction.formSchema, interaction.kind, activeI18n.language]
  );

  const [note, setNote] = useState('');
  const [formDraft, setFormDraft] = useState<Record<string, string | boolean>>(
    () => buildInitialFormDraft(formFields)
  );
  const [resolving, setResolving] = useState(false);
  const [errorMsg, setErrorMsg] = useState<string | null>(null);

  const approvalOptions: ApprovalOptionSpec[] =
    interaction.approvalOptions.length > 0
      ? interaction.approvalOptions
      : [
          {
            id: 'approve',
            label: labels?.approve ?? t('pulseDeck.interaction.approve'),
          },
          {
            id: 'reject',
            label: labels?.reject ?? t('pulseDeck.interaction.reject'),
            destructive: true,
          },
        ];

  const kindBadgeLabel =
    interaction.kind === 'approval'
      ? t('pulseDeck.interaction.kindApproval')
      : interaction.kind === 'ask_form'
        ? t('pulseDeck.interaction.kindAskForm')
        : interaction.kind === 'digest'
          ? t('pulseDeck.interaction.kindDigest')
          : t('pulseDeck.interaction.kindNotify');

  const handleResolveOption = async (option: ApprovalOptionSpec) => {
    if (option.requireNote && !note.trim()) {
      setErrorMsg(
        labels?.noteRequiredError ??
          t('pulseDeck.interaction.noteRequiredError')
      );
      return;
    }
    setResolving(true);
    setErrorMsg(null);
    try {
      await pulseApi.resolveUserInteraction({
        interactionId: interaction.id,
        optionId: option.id,
        note: note.trim() || null,
        formValues: null,
      });
      onResolved(interaction.id);
    } catch (err) {
      setErrorMsg(
        err instanceof Error
          ? err.message
          : t('pulseDeck.interaction.errSubmitDecision')
      );
    } finally {
      setResolving(false);
    }
  };

  const handleSubmitForm = async () => {
    const parsed = coerceAndValidateFormValues(formFields, formDraft);
    if (!parsed.ok) {
      setErrorMsg(parsed.error);
      return;
    }
    setResolving(true);
    setErrorMsg(null);
    try {
      await pulseApi.resolveUserInteraction({
        interactionId: interaction.id,
        optionId: 'submit',
        note: note.trim() || null,
        formValues: parsed.values,
      });
      onResolved(interaction.id);
    } catch (err) {
      setErrorMsg(
        err instanceof Error
          ? err.message
          : t('pulseDeck.interaction.errSubmitForm')
      );
    } finally {
      setResolving(false);
    }
  };

  return (
    <div
      data-testid={`pulse-interaction-${interaction.id}`}
      className={cn(
        'rounded-md border border-border bg-muted/40 p-2 text-xs',
        className
      )}
    >
      <div className="flex items-start justify-between gap-2">
        <div className="flex min-w-0 items-center gap-1.5 font-medium text-foreground">
          <Zap
            className={cn(
              'h-3.5 w-3.5 shrink-0',
              interaction.severity === 'urgent'
                ? 'text-destructive'
                : interaction.severity === 'warning'
                  ? 'text-warning'
                  : 'text-primary'
            )}
          />
          <span className="truncate">{interaction.title}</span>
        </div>
        <span className="shrink-0 rounded bg-muted px-1.5 py-0.5 text-[10px] uppercase text-muted-foreground">
          {kindBadgeLabel}
        </span>
      </div>

      {interaction.body ? (
        <p className="mt-1 text-xs text-muted-foreground">{interaction.body}</p>
      ) : null}

      {interaction.kind === 'ask_form' ? (
        <div className="mt-2 space-y-1.5">
          {formFields.map((field) => {
            const fieldId = `pulse-form-${interaction.id}-${field.key}`;
            return (
              <div key={field.key} className="space-y-0.5">
                {field.type === 'boolean' && !field.enumOptions ? (
                  <div className="flex items-center gap-2 rounded bg-background px-2 py-1 text-xs text-foreground">
                    <Checkbox
                      id={fieldId}
                      aria-label={field.label}
                      checked={Boolean(formDraft[field.key])}
                      onCheckedChange={(checked) =>
                        setFormDraft((prev) => ({
                          ...prev,
                          [field.key]: Boolean(checked),
                        }))
                      }
                    />
                    <label
                      htmlFor={fieldId}
                      className="cursor-pointer font-medium"
                    >
                      {field.label}
                    </label>
                    {field.required ? (
                      <span aria-hidden="true" className="text-destructive">
                        *
                      </span>
                    ) : null}
                  </div>
                ) : (
                  <>
                    <div className="flex items-center gap-0.5 text-[11px] font-medium text-foreground">
                      <label htmlFor={fieldId}>{field.label}</label>
                      {field.required ? (
                        <span aria-hidden="true" className="text-destructive">
                          *
                        </span>
                      ) : null}
                    </div>
                    {field.enumOptions ? (
                      <select
                        id={fieldId}
                        aria-label={field.label}
                        required={field.required}
                        value={String(formDraft[field.key] ?? '')}
                        onChange={(event) =>
                          setFormDraft((prev) => ({
                            ...prev,
                            [field.key]: event.target.value,
                          }))
                        }
                        className="raised-control h-7 w-full rounded border border-border bg-background px-2 text-xs text-foreground focus:outline-none"
                      >
                        {!field.required ? (
                          <option value="">
                            {labels?.selectPlaceholder ??
                              t('pulseDeck.interaction.selectPlaceholder')}
                          </option>
                        ) : null}
                        {field.enumOptions.map((option) => (
                          <option key={String(option)} value={String(option)}>
                            {String(option)}
                          </option>
                        ))}
                      </select>
                    ) : (
                      <input
                        id={fieldId}
                        type={
                          field.type === 'number' || field.type === 'integer'
                            ? 'number'
                            : 'text'
                        }
                        step={field.type === 'integer' ? 1 : 'any'}
                        required={field.required}
                        aria-label={field.label}
                        placeholder={field.label}
                        value={String(formDraft[field.key] ?? '')}
                        onChange={(event) =>
                          setFormDraft((prev) => ({
                            ...prev,
                            [field.key]: event.target.value,
                          }))
                        }
                        className={cn(
                          'h-7 w-full rounded border border-border bg-background px-2 text-xs text-foreground focus:outline-none',
                          (field.type === 'number' ||
                            field.type === 'integer') &&
                            'tabular-nums'
                        )}
                      />
                    )}
                  </>
                )}
                {field.description ? (
                  <p className="text-[11px] text-muted-foreground">
                    {field.description}
                  </p>
                ) : null}
              </div>
            );
          })}
          <Button
            type="button"
            size="xs"
            disabled={resolving}
            className="h-6 w-full text-[11px]"
            data-testid={`pulse-interaction-submit-${interaction.id}`}
            onClick={() => void handleSubmitForm()}
          >
            {labels?.submit ?? t('pulseDeck.interaction.submit')}
          </Button>
        </div>
      ) : interaction.kind === 'approval' ? (
        <div className="mt-2 space-y-1.5">
          <input
            type="text"
            aria-label={
              labels?.decisionNoteAria ??
              t('pulseDeck.interaction.decisionNoteAria')
            }
            placeholder={
              labels?.decisionNotePlaceholder ??
              t('pulseDeck.interaction.decisionNotePlaceholder')
            }
            value={note}
            onChange={(event) => setNote(event.target.value)}
            className="h-6 w-full rounded border border-border bg-background px-2 text-[11px] text-foreground focus:outline-none"
          />
          <div className="flex flex-wrap items-center gap-1.5">
            {approvalOptions.map((option) => (
              <Button
                key={option.id}
                type="button"
                size="xs"
                variant={option.destructive ? 'destructive' : 'default'}
                disabled={resolving}
                data-testid={`pulse-approval-${interaction.id}-${option.id}`}
                className="h-6 gap-1 px-2 text-[11px]"
                onClick={() => void handleResolveOption(option)}
              >
                {option.destructive ? (
                  <X className="h-3 w-3" />
                ) : (
                  <Check className="h-3 w-3" />
                )}
                <span>{option.label}</span>
              </Button>
            ))}
          </div>
        </div>
      ) : (
        <div className="mt-2 flex justify-end">
          <Button
            type="button"
            size="xs"
            variant="outline"
            disabled={resolving}
            data-testid={`pulse-acknowledge-${interaction.id}`}
            className="h-6 px-2 text-[11px]"
            onClick={() =>
              void handleResolveOption({
                id: 'acknowledge',
                label:
                  labels?.acknowledge ?? t('pulseDeck.interaction.acknowledge'),
              })
            }
          >
            {labels?.acknowledge ?? t('pulseDeck.interaction.acknowledge')}
          </Button>
        </div>
      )}

      {errorMsg ? (
        <div role="alert" className="mt-1 text-[11px] text-destructive">
          {errorMsg}
        </div>
      ) : null}
    </div>
  );
}
