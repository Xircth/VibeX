import { Braces, MessageSquare, Workflow } from 'lucide-react';
import { useTranslation } from 'react-i18next';

import type { AutomationTemplateView } from '@/lib/api/automations';
import { Button } from '@/components/ui/button';

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
            <p className="text-xs text-muted-foreground">
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
          <Button
            type="button"
            variant="row"
            size="row"
            className="group"
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
              <span className="mt-0.5 block text-xs leading-4 text-muted-foreground">
                {t('automations.researchTemplateDescription')}
              </span>
            </span>
          </Button>
        </section>

        <section>
          <p className="mb-1.5 px-1 text-[10px] font-semibold uppercase tracking-[0.12em] text-muted-foreground">
            {t('automations.singleSession')}
          </p>
          <div className="space-y-1">
            {templates.length ? (
              templates.map((template) => (
                <Button
                  type="button"
                  key={template.id}
                  variant="row"
                  size="row"
                  className="group"
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
                    <span className="mt-0.5 block line-clamp-2 text-xs leading-4 text-muted-foreground">
                      {template.draft.launch.displayText}
                    </span>
                  </span>
                </Button>
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
