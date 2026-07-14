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
  Sun,
} from 'lucide-react';

import { Button } from '@/components/ui/button';
import { cn } from '@/lib/utils';

interface SettingsNavItem {
  path: string;
  /** Key under the `settings:nav` namespace. */
  labelKey: string;
  icon: ComponentType<{ className?: string }>;
}

const SETTINGS_NAV_ITEMS: SettingsNavItem[] = [
  { path: '/settings/agents', labelKey: 'agents', icon: Bot },
  { path: '/settings/appearance', labelKey: 'appearance', icon: Sun },
  { path: '/settings/general', labelKey: 'general', icon: SlidersHorizontal },
  { path: '/settings/model-providers', labelKey: 'modelProviders', icon: Server },
  { path: '/settings/mcp', labelKey: 'mcp', icon: PlugZap },
  { path: '/settings/skills', labelKey: 'skills', icon: BookOpenText },
  { path: '/settings/instructions', labelKey: 'instructions', icon: MessageSquareText },
  { path: '/settings/shortcuts', labelKey: 'shortcuts', icon: Keyboard },
  { path: '/settings/version-control', labelKey: 'versionControl', icon: GitBranch },
  { path: '/settings/chat-channels', labelKey: 'chatChannels', icon: SendHorizontal },
  { path: '/settings/automations', labelKey: 'automations', icon: Clock },
  { path: '/settings/plugins', labelKey: 'plugins', icon: Puzzle },
  { path: '/settings/web-service', labelKey: 'webService', icon: Globe },
  { path: '/settings/logs', labelKey: 'logs', icon: FileText },
  { path: '/settings/system', labelKey: 'system', icon: Settings },
];

export function SettingsLayout() {
  const location = useLocation();
  const navigate = useNavigate();
  const { t } = useTranslation('settings');

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
          <nav className="space-y-1">
            {SETTINGS_NAV_ITEMS.map((item) => {
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
