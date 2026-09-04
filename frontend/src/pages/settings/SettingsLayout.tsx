import {
  Suspense,
  useCallback,
  useEffect,
  useState,
  type ComponentType,
} from 'react';
import {
  Outlet,
  useLocation,
  useNavigate,
  useSearchParams,
} from 'react-router-dom';
import { useTranslation } from 'react-i18next';
import {
  Bot,
  BookOpenText,
  Clock,
  FileText,
  GitBranch,
  GitFork,
  Globe,
  Keyboard,
  MessageSquareText,
  PlugZap,
  Puzzle,
  SendHorizontal,
  Settings,
  SlidersHorizontal,
  Sun,
} from 'lucide-react';

import { Button } from '@/components/ui/button';
import {
  preloadSettingsPath,
  scheduleRemainingSettingsPreload,
} from '@/lib/settingsPreload';
import { cn } from '@/lib/utils';
import { useBackendCapabilities } from '@/lib/transport';

import { AgentSettingsLoading } from './AgentSettingsLoading';
import { SettingsSearch } from './SettingsSearchField';
import { SETTINGS_SEARCH_ENTRIES } from './settingsSearchCatalog';
import { applySettingsSearchHighlight } from './settingsSearchQuery';
import { syncSettingsWindowTitle } from './syncSettingsWindowTitle';

interface SettingsNavItem {
  path: string;
  /** Key under the `settings:nav` namespace. */
  labelKey: string;
  icon: ComponentType<{ className?: string }>;
  capability?: string;
  anyOf?: string[];
}

const SETTINGS_NAV_ITEMS: SettingsNavItem[] = [
  {
    path: '/settings/agents',
    labelKey: 'agents',
    icon: Bot,
    capability: 'application.call',
  },
  { path: '/settings/appearance', labelKey: 'appearance', icon: Sun },
  {
    path: '/settings/general',
    labelKey: 'general',
    icon: SlidersHorizontal,
    capability: 'application.call',
  },
  {
    path: '/settings/mcp',
    labelKey: 'mcp',
    icon: PlugZap,
    capability: 'application.call',
  },
  {
    path: '/settings/skills',
    labelKey: 'skills',
    icon: BookOpenText,
    capability: 'application.call',
  },
  {
    path: '/settings/instructions',
    labelKey: 'instructions',
    icon: MessageSquareText,
    capability: 'application.call',
  },
  { path: '/settings/shortcuts', labelKey: 'shortcuts', icon: Keyboard },
  {
    path: '/settings/version-control',
    labelKey: 'versionControl',
    icon: GitBranch,
    capability: 'application.call',
  },
  {
    path: '/settings/worktrees',
    labelKey: 'worktrees',
    icon: GitFork,
    capability: 'application.call',
  },
  {
    path: '/settings/chat-channels',
    labelKey: 'chatChannels',
    icon: SendHorizontal,
    capability: 'application.call',
  },
  {
    path: '/settings/automations',
    labelKey: 'automations',
    icon: Clock,
    capability: 'automation.read',
  },
  {
    path: '/plugins',
    labelKey: 'plugins',
    icon: Puzzle,
    capability: 'plugin.read',
  },
  {
    path: '/settings/web-service',
    labelKey: 'webService',
    icon: Globe,
    anyOf: ['desktop.tauri', 'device.pair'],
  },
  {
    path: '/settings/logs',
    labelKey: 'logs',
    icon: FileText,
    capability: 'application.call',
  },
  {
    path: '/settings/system',
    labelKey: 'system',
    icon: Settings,
    capability: 'application.call',
  },
];

export function SettingsLayout() {
  const location = useLocation();
  const navigate = useNavigate();
  const [searchParams, setSearchParams] = useSearchParams();
  const { t, i18n } = useTranslation('settings');
  const { capabilities, supports } = useBackendCapabilities();
  const [searchQuery, setSearchQuery] = useState('');
  const highlightId = searchParams.get('highlight');
  const searching = searchQuery.trim().length > 0;

  const navigateTo = useCallback(
    (path: string) => {
      if (location.pathname === path) return;
      navigate(path);
    },
    [location.pathname, navigate]
  );

  const jumpToSetting = useCallback(
    (path: string, id: string) => {
      const target = `${path}?highlight=${encodeURIComponent(id)}`;
      navigate(target);
    },
    [navigate]
  );

  useEffect(() => scheduleRemainingSettingsPreload(), []);

  useEffect(() => {
    void syncSettingsWindowTitle(t('windowTitle'));
  }, [i18n.language, t]);

  useEffect(() => {
    if (!highlightId) return;
    const entry = SETTINGS_SEARCH_ENTRIES.find(
      (item) => item.id === highlightId
    );
    const label = entry ? t(entry.labelKey) : highlightId;
    let cancelled = false;
    let attempts = 0;
    const tick = () => {
      if (cancelled) return;
      const root =
        document.querySelector('[data-settings-content]') ??
        document.querySelector('.settings-page');
      if (root && applySettingsSearchHighlight(root, label)) {
        const next = new URLSearchParams(searchParams);
        next.delete('highlight');
        setSearchParams(next, { replace: true });
        return;
      }
      attempts += 1;
      if (attempts < 40) window.setTimeout(tick, 50);
    };
    const timer = window.setTimeout(tick, 0);
    return () => {
      cancelled = true;
      window.clearTimeout(timer);
    };
  }, [highlightId, location.pathname, searchParams, setSearchParams, t]);

  return (
    <div className="settings-page settings-shell fixed inset-0 flex flex-col overflow-hidden text-foreground">
      <div className="flex min-h-0 flex-1">
        <aside className="settings-sidebar m-3 w-56 shrink-0 overflow-y-auto p-2.5">
          <SettingsSearch
            query={searchQuery}
            onQueryChange={setSearchQuery}
            supports={supports}
            onSelect={jumpToSetting}
          />
          {searching ? null : (
            <nav className="space-y-1" aria-busy={capabilities === null}>
              {SETTINGS_NAV_ITEMS.filter((item) => {
                if (item.anyOf) return item.anyOf.some((cap) => supports(cap));
                return !item.capability || supports(item.capability);
              }).map((item) => {
                const Icon = item.icon;
                const active =
                  location.pathname === item.path ||
                  location.pathname.startsWith(`${item.path}/`);

                return (
                  <Button
                    key={item.path}
                    variant="ghost"
                    size="sm"
                    className={cn(
                      'settings-nav-button h-8 w-full justify-start text-sm',
                      active && 'is-active'
                    )}
                    type="button"
                    onClick={() => navigateTo(item.path)}
                    onMouseEnter={() => preloadSettingsPath(item.path)}
                    onFocus={() => preloadSettingsPath(item.path)}
                    aria-current={active ? 'page' : undefined}
                  >
                    <span className="inline-flex items-center gap-2">
                      <Icon className="h-4 w-4" />
                      {t(`nav.${item.labelKey}`)}
                    </span>
                  </Button>
                );
              })}
            </nav>
          )}
        </aside>

        <section
          data-settings-content
          className={cn(
            'min-h-0 min-w-0 flex-1 p-4',
            location.pathname === '/plugins'
              ? 'flex flex-col overflow-hidden'
              : 'overflow-y-auto'
          )}
        >
          <Suspense fallback={<SettingsContentFallback />}>
            <Outlet />
          </Suspense>
        </section>
      </div>
    </div>
  );
}

function SettingsContentFallback() {
  const { pathname } = useLocation();
  if (
    pathname === '/settings/agents' ||
    pathname.startsWith('/settings/agents/')
  ) {
    return <AgentSettingsLoading />;
  }
  return <SettingsSectionLoading />;
}

function SettingsSectionLoading() {
  return (
    <div
      className="agent-settings-loading flex flex-col gap-4"
      role="status"
      aria-busy="true"
    >
      <section className="settings-surface" aria-hidden="true">
        <div className="agent-section-heading">
          <span className="agent-settings-loading-line agent-settings-loading-line-heading" />
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
