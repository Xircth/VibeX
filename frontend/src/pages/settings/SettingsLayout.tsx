import { useCallback, type ComponentType } from 'react';
import { Outlet, useLocation, useNavigate } from 'react-router-dom';
import {
  Bot,
  BookOpenText,
  Clock,
  GitBranch,
  Globe,
  Keyboard,
  MessageSquareText,
  PlugZap,
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
  label: string;
  icon: ComponentType<{ className?: string }>;
}

const SETTINGS_NAV_ITEMS: SettingsNavItem[] = [
  { path: '/settings/agents', label: 'Agent', icon: Bot },
  { path: '/settings/appearance', label: '外观', icon: Sun },
  { path: '/settings/general', label: '常规', icon: SlidersHorizontal },
  { path: '/settings/model-providers', label: '模型供应商', icon: Server },
  { path: '/settings/mcp', label: 'MCP', icon: PlugZap },
  { path: '/settings/skills', label: '技能', icon: BookOpenText },
  { path: '/settings/instructions', label: '指令', icon: MessageSquareText },
  { path: '/settings/shortcuts', label: '交互', icon: Keyboard },
  { path: '/settings/version-control', label: '版本管理', icon: GitBranch },
  { path: '/settings/chat-channels', label: '消息渠道', icon: SendHorizontal },
  { path: '/settings/automations', label: '自动化', icon: Clock },
  { path: '/settings/web-service', label: 'Web 服务', icon: Globe },
  { path: '/settings/system', label: '系统', icon: Settings },
];

export function SettingsLayout() {
  const location = useLocation();
  const navigate = useNavigate();

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
                    {item.label}
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
