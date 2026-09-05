import { useTranslation } from 'react-i18next';

export function AgentSettingsLoading() {
  const { t } = useTranslation('settings');

  return (
    <div
      className="agent-settings-scroll agent-settings-loading flex h-full min-h-0 flex-col gap-4 overflow-hidden pb-24"
      role="status"
      aria-busy="true"
      aria-label={t('agents.loadingAgent')}
    >
      <div className="flex shrink-0 items-center gap-2" aria-hidden="true">
        <nav className="agent-management-bar">
          <span className="agent-management-bar-surface" />
          <div className="agent-management-bar-scroll">
            {Array.from({ length: 6 }, (_, index) => (
              <span
                className="agent-management-bar-item agent-settings-loading-mark"
                key={index}
              />
            ))}
          </div>
          <span className="agent-management-bar-item agent-management-bar-add agent-settings-loading-mark" />
        </nav>
        <span className="agent-settings-loading-refresh" />
      </div>

      <header className="agent-detail-header" aria-hidden="true">
        <div className="agent-detail-header-identity">
          <span className="agent-detail-icon agent-settings-loading-bone" />
          <div className="agent-detail-header-copy agent-settings-loading-copy">
            <span className="agent-settings-loading-line agent-settings-loading-line-title" />
            <span className="agent-settings-loading-line agent-settings-loading-line-meta" />
          </div>
        </div>
        <div className="agent-detail-header-actions">
          <span className="agent-settings-loading-chip" />
          <span className="agent-settings-loading-action" />
          <span className="agent-settings-loading-action" />
        </div>
      </header>

      <section className="settings-surface" aria-hidden="true">
        <div className="agent-section-heading">
          <span className="agent-settings-loading-line agent-settings-loading-line-heading" />
          <span className="agent-settings-loading-action" />
        </div>
        <ul className="agent-settings-loading-rows">
          <li />
          <li />
          <li />
        </ul>
      </section>

      <section className="settings-surface" aria-hidden="true">
        <div className="agent-section-heading">
          <span className="agent-settings-loading-line agent-settings-loading-line-heading" />
        </div>
        <ul className="agent-settings-loading-rows">
          <li />
          <li />
        </ul>
      </section>
    </div>
  );
}
