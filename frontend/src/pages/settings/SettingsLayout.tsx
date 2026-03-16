import { useCallback, useEffect, useState, type ComponentType } from 'react';
import { Outlet, useLocation, useNavigate } from 'react-router-dom';
import {
  ArrowLeft,
  Bot,
  BookOpenText,
  Keyboard,
  PlugZap,
  Settings,
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
  { path: '/settings/agents', label: '代理', icon: Bot },
  { path: '/settings/mcp', label: 'MCP', icon: PlugZap },
  { path: '/settings/skills', label: '技能', icon: BookOpenText },
  { path: '/settings/shortcuts', label: '快捷键', icon: Keyboard },
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

  const handleDragStart = useCallback((e: React.MouseEvent) => {
    // Only start dragging on left mouse button and direct target (not child buttons)
    if (e.button !== 0) return;
    e.preventDefault();
    getCurrentWindow().startDragging().catch(() => {});
  }, []);

  return (
    <div className="settings-page h-screen flex flex-col overflow-hidden bg-background text-foreground">
      {/* Integrated title bar */}
      <div
        className="relative h-10 shrink-0 border-b bg-muted/70 select-none"
        onMouseDown={isStandaloneWindow ? handleDragStart : undefined}
      >
        <div
          className={cn(
            'relative z-10 flex h-full items-center px-3',
            isStandaloneWindow && isWindows && 'pr-[138px]'
          )}
        >
          {/* Back button (only in main window mode) */}
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
          {/* Logo + "设置" — pointer-events-none so drag region works in standalone */}
          <div className={cn('flex items-center gap-3', isStandaloneWindow && 'pointer-events-none')}>
            <Logo showText={false} />
            <span className="text-sm font-semibold tracking-tight text-foreground">设置</span>
          </div>
        </div>

        {/* Window controls — only in standalone window */}
        {isStandaloneWindow && isWindows && (
          <div
            className="absolute right-0 top-0 z-30 flex items-center h-full"
            onMouseDown={(e) => e.stopPropagation()}
          >
            <WindowControls />
          </div>
        )}
      </div>

      <div className="flex-1 min-h-0 flex">
        {/* Left sidebar navigation */}
        <aside className="w-56 shrink-0 border-r p-3">
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
                  variant={active ? 'secondary' : 'ghost'}
                  size="sm"
                  className={cn('w-full justify-start')}
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

        {/* Main content area */}
        <section className="flex-1 min-w-0 min-h-0 p-4 overflow-y-auto">
          <Outlet />
        </section>
      </div>
    </div>
  );
}
