import { Braces, MessageSquare, Workflow } from 'lucide-react';
import { useTranslation } from 'react-i18next';

import type { AutomationTemplateView } from '@/lib/api/automations';

type AutomationTemplateListProps = {
  templates: AutomationTemplateView[];
  onSelectTurn: (templateId: string) => void;
  onSelectWorkflow: () => void;
};

export function AutomationTemplateList({
  templates,
  onSelectTurn,
  onSelectWorkflow,
}: AutomationTemplateListProps) {
  const { t } = useTranslation('settings');

  return (
    <aside
      className="settings-surface automation-template-list w-[340px] shrink-0 overflow-hidden rounded-lg"
      data-testid="automation-template-list"
    >
      <div className="border-b px-4 py-3.5">
        <div className="flex items-center gap-2">
          <span className="grid size-8 place-items-center rounded-lg bg-[var(--surface-control)] text-muted-foreground">
            <Workflow className="size-4" />
          </span>
          <div className="min-w-0">
            <h4 className="text-sm font-semibold">
              {t('automations.templates')}
            </h4>
            <p className="text-[11px] text-muted-foreground">
              {t('automations.templatesDraft')}
            </p>
          </div>
        </div>
      </div>

      <div className="space-y-4 p-3">
        <section>
          <p className="mb-1.5 px-1 text-[10px] font-semibold uppercase tracking-[0.12em] text-muted-foreground">
            {t('automations.targetWorkflow')}
          </p>
          <button
            type="button"
            className="group flex !h-auto !min-h-0 w-full items-start gap-3 rounded-lg p-2.5 text-left transition-colors hover:bg-[var(--surface-control-hover)] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--focus-ring)]"
            aria-label={t('automations.researchTemplateTitle')}
            onClick={onSelectWorkflow}
          >
            <span className="grid size-8 shrink-0 place-items-center rounded-lg bg-primary/10 text-primary">
              <Workflow className="size-4" />
            </span>
            <span className="min-w-0">
              <span className="block text-xs font-semibold text-foreground">
                {t('automations.researchTemplateTitle')}
              </span>
              <span className="mt-0.5 block text-[11px] leading-4 text-muted-foreground">
                {t('automations.researchTemplateDescription')}
              </span>
            </span>
          </button>
        </section>

        <section>
          <p className="mb-1.5 px-1 text-[10px] font-semibold uppercase tracking-[0.12em] text-muted-foreground">
            {t('automations.singleSession')}
          </p>
          <div className="space-y-1">
            {templates.length ? (
              templates.map((template) => (
                <button
                  type="button"
                  key={template.id}
                  className="group flex !h-auto !min-h-0 w-full items-start gap-3 rounded-lg p-2.5 text-left transition-colors hover:bg-[var(--surface-control-hover)] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--focus-ring)]"
                  aria-label={template.draft.name}
                  onClick={() => onSelectTurn(template.id)}
                >
                  <span className="grid size-8 shrink-0 place-items-center rounded-lg bg-[var(--surface-control)] text-muted-foreground group-hover:text-foreground">
                    <Braces className="size-4" />
                  </span>
                  <span className="min-w-0">
                    <span className="block truncate text-xs font-semibold text-foreground">
                      {template.draft.name}
                    </span>
                    <span className="mt-0.5 block line-clamp-2 text-[11px] leading-4 text-muted-foreground">
                      {template.draft.launch.displayText}
                    </span>
                  </span>
                </button>
              ))
            ) : (
              <div className="flex items-center gap-2 px-2.5 py-3 text-xs text-muted-foreground">
                <MessageSquare className="size-3.5" />
                {t('automations.templatesEmpty')}
              </div>
            )}
          </div>
        </section>
      </div>
    </aside>
  );
}
