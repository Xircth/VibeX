import { useTranslation } from 'react-i18next';

export type PluginInspectTab = 'readme' | 'contents' | 'tree' | 'config';

const TAB_LABEL: Record<
  PluginInspectTab,
  | 'plugins.readmeTab'
  | 'plugins.contentsTab'
  | 'plugins.packageTab'
  | 'plugins.configTab'
> = {
  readme: 'plugins.readmeTab',
  contents: 'plugins.contentsTab',
  tree: 'plugins.packageTab',
  config: 'plugins.configTab',
};

export function PluginInspectTabs({
  value,
  tabs,
  onChange,
}: {
  value: PluginInspectTab;
  tabs: PluginInspectTab[];
  onChange: (value: PluginInspectTab) => void;
}) {
  const { t } = useTranslation('settings');

  return (
    <div
      className="product-plugin-underline-tabs"
      role="tablist"
      aria-label={t('plugins.productDetailTabs')}
      onKeyDown={(event) => {
        const index = tabs.findIndex((tab) => tab === value);
        let next = index;
        if (event.key === 'ArrowRight') next = (index + 1) % tabs.length;
        else if (event.key === 'ArrowLeft') {
          next = (index - 1 + tabs.length) % tabs.length;
        } else if (event.key === 'Home') next = 0;
        else if (event.key === 'End') next = tabs.length - 1;
        else return;
        event.preventDefault();
        const tab = tabs[next];
        onChange(tab);
        event.currentTarget
          .querySelector<HTMLButtonElement>(`[data-plugin-tab="${tab}"]`)
          ?.focus();
      }}
    >
      {tabs.map((tab) => {
        const active = tab === value;
        return (
          <button
            key={tab}
            type="button"
            role="tab"
            data-plugin-tab={tab}
            aria-selected={active}
            tabIndex={active ? 0 : -1}
            className={active ? 'is-active' : undefined}
            onClick={() => onChange(tab)}
          >
            {t(TAB_LABEL[tab])}
          </button>
        );
      })}
    </div>
  );
}
