import { useCallback, useEffect, useState, type ComponentType } from 'react';
import { Outlet, useLocation, useNavigate } from 'react-router-dom';
import {
  ArrowLeft,
  Bot,
  BookOpenText,
  Code2,
  Keyboard,
  PlugZap,
  Settings,
  Sun,
} from 'lucide-react';
import { Button } from '@/components/ui/button';
import { cn } from '@/lib/utils';
import { WindowControls } from '@/components/settings/WindowControls';
import { Logo } from '@/components/Logo';
import { getCurrentWindow } from '@tauri-apps/api/window';

interface SettingsNavItem {
  path: string;
  label: string;
  icon: ComponentType<{ className?: string }>;
}

const SETTINGS_NAV_ITEMS: SettingsNavItem[] = [
  { path: '/settings/agents', label: 'Agent', icon: Bot },
  { path: '/settings/skills', label: '技能', icon: BookOpenText },
  { path: '/settings/mcp', label: 'MCP', icon: PlugZap },
  { path: '/settings/shortcuts', label: '交互', icon: Keyboard },
  { path: '/settings/editor', label: '编辑', icon: Code2 },
  { path: '/settings/appearance', label: '外观', icon: Sun },
  { path: '/settings/system', label: '系统', icon: Settings },
];

export function SettingsLayout() {
  const location = useLocation();
  const navigate = useNavigate();
  const isWindows = navigator.platform.toLowerCase().includes('win');
  const [isStandaloneWindow, setIsStandaloneWindow] = useState(false);

  useEffect(() => {
    getCurrentWindow().label !== 'main' && setIsStandaloneWindow(true);
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
    getCurrentWindow()
      .startDragging()
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
            <span className="text-sm font-semibold tracking-tight text-foreground">
              设置
            </span>
          </div>
        </div>

        {isStandaloneWindow && isWindows && (
          <div
            className="absolute right-0 top-0 z-30 flex items-center h-full"
            onMouseDown={(event) => event.stopPropagation()}
          >
            <WindowControls />
          </div>
        )}
      </div>

      <div className="flex-1 min-h-0 flex">
        <aside className="settings-sidebar w-56 shrink-0 p-3">
          <div className="px-1 pb-2 text-[11px] font-medium text-muted-foreground">
            偏好设置
          </div>
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
                    'settings-nav-button w-full justify-start',
                    active && 'is-active'
                  )}
                  type="button"
                  onClick={() => navigateTo(item.path)}
                  aria-current={active ? 'page' : undefined}
                >
                  <span className="inline-flex items-center gap-1">
                    <Icon className="h-3.5 w-3.5" />
                    {item.label}
                  </span>
                </Button>
              );
            })}
          </nav>
        </aside>

        <section
          className="flex-1 min-w-0 min-h-0 p-4 overflow-y-auto [scrollbar-gutter:stable]"
          style={{ scrollbarGutter: 'stable' }}
        >
          <Outlet />
        </section>
      </div>
    </div>
  );
}
