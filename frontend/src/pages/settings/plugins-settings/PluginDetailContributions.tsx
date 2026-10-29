import { AlertTriangle, ArrowLeft, Loader2 } from 'lucide-react';
import type { Dispatch, SetStateAction } from 'react';
import { useTranslation } from 'react-i18next';

import { AstryxMarkdown } from '@/components/NormalizedConversation/AstryxMarkdown';
import { Button } from '@/components/ui/button';
import type {
  PluginControlContributions,
  PluginControlItem,
} from '@/lib/api/plugins';
import { cn } from '@/lib/utils';
import type { PluginDetailMode } from './pluginConstants';

export function PluginDetailContributions({
  plugin,
  mode,
  openContributions,
  setMode,
  contributions,
  contributionsLoading,
  contributionsError,
  selectedSkillId,
  selectedMcpId,
  setSelectedSkillId,
  setSelectedMcpId,
}: {
  plugin: PluginControlItem;
  mode: PluginDetailMode;
  openContributions: (nextMode: PluginDetailMode) => void;
  setMode: Dispatch<SetStateAction<PluginDetailMode>>;
  contributions: PluginControlContributions | null;
  contributionsLoading: boolean;
  contributionsError: string | null;
  selectedSkillId: string | null;
  selectedMcpId: string | null;
  setSelectedSkillId: Dispatch<SetStateAction<string | null>>;
  setSelectedMcpId: Dispatch<SetStateAction<string | null>>;
}) {
  const { t } = useTranslation('settings');
  const selectedSkill =
    contributions?.skills.find((skill) => skill.id === selectedSkillId) ??
    contributions?.skills[0];
  const selectedMcp =
    contributions?.mcpServers.find((server) => server.id === selectedMcpId) ??
    contributions?.mcpServers[0];

  return (
    <>
      <nav
        className="plugin-contribution-mode-nav"
        aria-label={t('plugins.contributionNavigation')}
      >
        {plugin.skills.length ? (
          <button
            type="button"
            aria-current={mode === 'skills' ? 'page' : undefined}
            onClick={() => void openContributions('skills')}
          >
            {t('plugins.skillsCount', { count: plugin.skills.length })}
          </button>
        ) : null}
        {(plugin.mcpCount ?? 0) > 0 ? (
          <button
            type="button"
            aria-current={mode === 'mcp' ? 'page' : undefined}
            onClick={() => void openContributions('mcp')}
          >
            {t('plugins.mcpCount', { count: plugin.mcpCount })}
          </button>
        ) : null}
      </nav>

      {mode === 'skills' ? (
        <section
          className="plugin-contribution-browser"
          role="region"
          aria-label={t('plugins.skillsRegionAria', { name: plugin.name })}
        >
          <header className="plugin-contribution-browser-header">
            <Button
              size="sm"
              variant="ghost"
              onClick={() => setMode('overview')}
            >
              <ArrowLeft className="mr-1.5 h-3.5 w-3.5" />
              {t('plugins.backToOverview')}
            </Button>
            <h4>{t('plugins.skillsViewTitle')}</h4>
          </header>
          {contributionsLoading ? (
            <div className="plugin-contribution-loading" role="status">
              <Loader2 className="animate-spin" aria-hidden="true" />
              {t('plugins.contributionsLoading')}
            </div>
          ) : contributionsError ? (
            <div className="plugin-hub-error" role="alert">
              <AlertTriangle aria-hidden="true" />
              <span>{contributionsError}</span>
            </div>
          ) : (
            <div className="plugin-contribution-browser-grid">
              <nav aria-label={t('plugins.skillListAria')}>
                {contributions?.skills.map((skill) => (
                  <button
                    key={skill.id}
                    type="button"
                    aria-label={skill.id}
                    className={cn(
                      selectedSkill?.id === skill.id && 'is-selected'
                    )}
                    onClick={() => setSelectedSkillId(skill.id)}
                  >
                    <strong>{skill.id}</strong>
                    <code>{skill.path}</code>
                  </button>
                ))}
              </nav>
              {selectedSkill ? (
                <article className="plugin-contribution-preview">
                  <div className="plugin-contribution-preview-path">
                    <code>{selectedSkill.path}</code>
                  </div>
                  <div className="plugin-skill-markdown">
                    <AstryxMarkdown value={selectedSkill.content} />
                  </div>
                </article>
              ) : null}
            </div>
          )}
        </section>
      ) : null}

      {mode === 'mcp' ? (
        <section
          className="plugin-contribution-browser"
          role="region"
          aria-label={t('plugins.mcpRegionAria', { name: plugin.name })}
        >
          <header className="plugin-contribution-browser-header">
            <Button
              size="sm"
              variant="ghost"
              onClick={() => setMode('overview')}
            >
              <ArrowLeft className="mr-1.5 h-3.5 w-3.5" />
              {t('plugins.backToOverview')}
            </Button>
            <h4>{t('plugins.mcpViewTitle')}</h4>
          </header>
          {contributionsLoading ? (
            <div className="plugin-contribution-loading" role="status">
              <Loader2 className="animate-spin" aria-hidden="true" />
              {t('plugins.contributionsLoading')}
            </div>
          ) : contributionsError ? (
            <div className="plugin-hub-error" role="alert">
              <AlertTriangle aria-hidden="true" />
              <span>{contributionsError}</span>
            </div>
          ) : (
            <div className="plugin-contribution-browser-grid">
              <nav aria-label={t('plugins.mcpListAria')}>
                {contributions?.mcpServers.map((server) => (
                  <button
                    key={server.id}
                    type="button"
                    aria-label={server.id}
                    className={cn(
                      selectedMcp?.id === server.id && 'is-selected'
                    )}
                    onClick={() => setSelectedMcpId(server.id)}
                  >
                    <strong>{server.id}</strong>
                  </button>
                ))}
              </nav>
              {selectedMcp ? (
                <article className="plugin-contribution-preview">
                  <pre className="plugin-mcp-json">
                    <code>{JSON.stringify(selectedMcp.config, null, 2)}</code>
                  </pre>
                </article>
              ) : null}
            </div>
          )}
        </section>
      ) : null}
    </>
  );
}
