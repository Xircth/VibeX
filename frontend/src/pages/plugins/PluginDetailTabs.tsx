import { FileText, SlidersHorizontal } from 'lucide-react';
import { useTranslation } from 'react-i18next';

export type PluginDetailTab = 'content' | 'config';

const TABS: Array<{
  value: PluginDetailTab;
  icon: typeof FileText;
  label: 'plugins.contentTab' | 'plugins.configTab';
}> = [
  { value: 'content', icon: FileText, label: 'plugins.contentTab' },
  { value: 'config', icon: SlidersHorizontal, label: 'plugins.configTab' },
];

export function PluginDetailTabs({
  value,
  onChange,
}: {
  value: PluginDetailTab;
  onChange: (value: PluginDetailTab) => void;
}) {
  const { t } = useTranslation('settings');

  return (
    <div
      className="product-plugin-detail-tabs"
      role="tablist"
      aria-label={t('plugins.productDetailTabs')}
      onKeyDown={(event) => {
        const index = TABS.findIndex((tab) => tab.value === value);
        let next = index;
        if (event.key === 'ArrowRight') next = (index + 1) % TABS.length;
        else if (event.key === 'ArrowLeft') {
          next = (index - 1 + TABS.length) % TABS.length;
        } else if (event.key === 'Home') next = 0;
        else if (event.key === 'End') next = TABS.length - 1;
        else return;
        event.preventDefault();
        const tab = TABS[next];
        onChange(tab.value);
        event.currentTarget
          .querySelector<HTMLButtonElement>(`[data-plugin-tab="${tab.value}"]`)
          ?.focus();
      }}
    >
      {TABS.map((tab) => {
        const Icon = tab.icon;
        const active = tab.value === value;
        return (
          <button
            key={tab.value}
            type="button"
            role="tab"
            data-plugin-tab={tab.value}
            aria-selected={active}
            tabIndex={active ? 0 : -1}
            className={active ? 'is-active' : undefined}
            onClick={() => onChange(tab.value)}
          >
            <Icon aria-hidden="true" />
            {t(tab.label)}
          </button>
        );
      })}
    </div>
  );
}
