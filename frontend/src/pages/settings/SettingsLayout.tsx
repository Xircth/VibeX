import { useCallback, type ComponentType } from 'react';
import { Outlet, useLocation, useNavigate } from 'react-router-dom';
import { useTranslation } from 'react-i18next';
import {
  Bot,
  BookOpenText,
  Clock,
  FileText,
  GitBranch,
  Globe,
  Keyboard,
  MessageSquareText,
  PlugZap,
  Puzzle,
  SendHorizontal,
  Server,
  Settings,
  SlidersHorizontal,
  Smartphone,
  Sun,
} from 'lucide-react';

import { Button } from '@/components/ui/button';
import { cn } from '@/lib/utils';
import { useBackendCapabilities } from '@/lib/transport';

interface SettingsNavItem {
  path: string;
  /** Key under the `settings:nav` namespace. */
  labelKey: string;
  icon: ComponentType<{ className?: string }>;
  capability?: string;
}

const SETTINGS_NAV_ITEMS: SettingsNavItem[] = [
  {
    path: '/settings/agents',
    labelKey: 'agents',
    icon: Bot,
    capability: 'desktop.tauri',
  },
  { path: '/settings/appearance', labelKey: 'appearance', icon: Sun },
  {
    path: '/settings/general',
    labelKey: 'general',
    icon: SlidersHorizontal,
    capability: 'desktop.tauri',
  },
  {
    path: '/settings/model-providers',
    labelKey: 'modelProviders',
    icon: Server,
    capability: 'desktop.tauri',
  },
  {
    path: '/settings/mcp',
    labelKey: 'mcp',
    icon: PlugZap,
    capability: 'desktop.tauri',
  },
  {
    path: '/settings/skills',
    labelKey: 'skills',
    icon: BookOpenText,
    capability: 'desktop.tauri',
  },
  {
    path: '/settings/instructions',
    labelKey: 'instructions',
    icon: MessageSquareText,
    capability: 'desktop.tauri',
  },
  { path: '/settings/shortcuts', labelKey: 'shortcuts', icon: Keyboard },
  {
    path: '/settings/version-control',
    labelKey: 'versionControl',
    icon: GitBranch,
    capability: 'desktop.tauri',
  },
  {
    path: '/settings/chat-channels',
    labelKey: 'chatChannels',
    icon: SendHorizontal,
    capability: 'desktop.tauri',
  },
  {
    path: '/settings/automations',
    labelKey: 'automations',
    icon: Clock,
    capability: 'automation.read',
  },
  {
    path: '/settings/plugins',
    labelKey: 'plugins',
    icon: Puzzle,
    capability: 'plugin.read',
  },
  {
    path: '/settings/web-service',
    labelKey: 'webService',
    icon: Globe,
    capability: 'desktop.tauri',
  },
  {
    path: '/settings/devices',
    labelKey: 'devices',
    icon: Smartphone,
    capability: 'device.pair',
  },
  {
    path: '/settings/logs',
    labelKey: 'logs',
    icon: FileText,
    capability: 'desktop.tauri',
  },
  {
    path: '/settings/system',
    labelKey: 'system',
    icon: Settings,
    capability: 'desktop.tauri',
  },
];

export function SettingsLayout() {
  const location = useLocation();
  const navigate = useNavigate();
  const { t } = useTranslation('settings');
  const { capabilities, supports } = useBackendCapabilities();

  const navigateTo = useCallback(
    (path: string) => {
      if (location.pathname === path) return;
      navigate(path);
    },
    [location.pathname, navigate]
  );

  return (
    <div className="settings-page settings-shell flex h-screen flex-col overflow-hidden text-foreground">
      <div className="flex min-h-0 flex-1">
        <aside className="settings-sidebar m-3 w-56 shrink-0 p-2.5">
          <nav className="space-y-1" aria-busy={capabilities === null}>
            {SETTINGS_NAV_ITEMS.filter(
              (item) => !item.capability || supports(item.capability)
            ).map((item) => {
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
        </aside>

        <section
          className="min-h-0 min-w-0 flex-1 overflow-y-auto p-4 [scrollbar-gutter:stable]"
          style={{ scrollbarGutter: 'stable' }}
        >
          <Outlet />
        </section>
      </div>
    </div>
  );
}
