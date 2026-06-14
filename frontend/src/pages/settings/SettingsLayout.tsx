import { useCallback, useEffect, useState, type ComponentType } from 'react';
import { Outlet, useLocation, useNavigate } from 'react-router-dom';
import {
  ArrowLeft,
  Bot,
  BookOpenText,
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
import { getCurrentWindow } from '@tauri-apps/api/window';

import { Logo } from '@/components/Logo';
import { WindowControls } from '@/components/settings/WindowControls';
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
  { path: '/settings/web-service', label: 'Web 服务', icon: Globe },
  { path: '/settings/system', label: '系统', icon: Settings },
];

function getSafeCurrentWindow() {
  try {
    const currentWindow = getCurrentWindow();
    void currentWindow.label;
    return currentWindow;
  } catch {
    return null;
  }
}

export function SettingsLayout() {
  const location = useLocation();
  const navigate = useNavigate();
  const isWindows = navigator.platform.toLowerCase().includes('win');
  const [isStandaloneWindow, setIsStandaloneWindow] = useState(false);

  useEffect(() => {
    const currentWindow = getSafeCurrentWindow();
    if (currentWindow && currentWindow.label !== 'main') {
      setIsStandaloneWindow(true);
    }
  }, []);

  const navigateTo = useCallback(
    (path: string) => {
      if (location.pathname === path) return;
      navigate(path);
    },
    [location.pathname, navigate]
  );

  const handleBack = useCallback(() => {
    navigate(-1);
  }, [navigate]);

  const handleDragStart = useCallback((event: React.MouseEvent) => {
    if (event.button !== 0) return;
    event.preventDefault();
    getSafeCurrentWindow()
      ?.startDragging()
      .catch(() => {});
  }, []);

  return (
    <div className="settings-page settings-shell flex h-screen flex-col overflow-hidden text-foreground">
      <div
        className="settings-titlebar relative h-10 shrink-0 select-none"
        onMouseDown={isStandaloneWindow ? handleDragStart : undefined}
      >
        <div
          className={cn(
            'relative z-10 flex h-full items-center px-3',
            isStandaloneWindow && isWindows && 'pr-[138px]'
          )}
        >
          {!isStandaloneWindow && (
            <Button
              variant="ghost"
              size="sm"
              className="mr-2 h-7 w-7 p-0"
              onClick={handleBack}
            >
              <ArrowLeft className="h-4 w-4" />
            </Button>
          )}
          <div
            className={cn(
              'flex items-center gap-3',
              isStandaloneWindow && 'pointer-events-none'
            )}
          >
            <Logo showText={false} size="window" />
            <span className="text-sm font-semibold tracking-normal text-foreground">
              设置
            </span>
          </div>
        </div>

        {isStandaloneWindow && isWindows && (
          <div
            className="absolute right-0 top-0 z-30 flex h-full items-center"
            onMouseDown={(event) => event.stopPropagation()}
          >
            <WindowControls />
          </div>
        )}
      </div>

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
