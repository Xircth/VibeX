import { useEffect } from 'react';
import { NavLink, Outlet } from 'react-router-dom';
import { Settings, Bot, Server, X, FolderOpen, GitBranch } from 'lucide-react';
import { Logo } from '@/components/Logo';
import { Button } from '@/components/ui/button';
import { usePreviousPath } from '@/hooks/usePreviousPath';
import { useKeyExit } from '@/keyboard/hooks';
import { Scope } from '@/keyboard/registry';
import { cn } from '@/lib/utils';
import { useHotkeysContext } from 'react-hotkeys-hook';

const settingsNavLabels: Record<string, { name: string; desc: string }> = {
  general: { name: '常规', desc: '主题、通知和偏好设置' },
  projects: { name: '项目', desc: '项目仓库和配置' },
  repos: { name: '仓库', desc: '仓库脚本和配置' },
  agents: { name: '代理', desc: '编码代理配置' },
  mcp: { name: 'MCP 服务器', desc: '模型上下文协议服务' },
};

const settingsNavigation = [
  {
    path: 'general',
    icon: Settings,
  },
  {
    path: 'projects',
    icon: FolderOpen,
  },
  {
    path: 'repos',
    icon: GitBranch,
  },
  {
    path: 'agents',
    icon: Bot,
  },
  {
    path: 'mcp',
    icon: Server,
  },
];

export function SettingsLayout() {
  const { enableScope, disableScope } = useHotkeysContext();
  const goToPreviousPath = usePreviousPath();

  // Enable SETTINGS scope when component mounts
  useEffect(() => {
    enableScope(Scope.SETTINGS);
    return () => {
      disableScope(Scope.SETTINGS);
    };
  }, [enableScope, disableScope]);

  // Register ESC keyboard shortcut
  useKeyExit(goToPreviousPath, { scope: Scope.SETTINGS });

  return (
    <div className="h-full overflow-auto [scrollbar-gutter:stable]">
      <div className="container mx-auto px-4 py-8">
        {/* Header with title and close button */}
        <div className="sticky top-0 z-10 -mx-4 flex items-center justify-between gap-4 bg-background px-4 py-4">
          <div className="flex min-w-0 items-center gap-4">
            <Logo />
            <div className="min-w-0">
              <h1 className="text-2xl font-semibold">{'设置'}</h1>
            </div>
          </div>
          <Button
            variant="ghost"
            onClick={goToPreviousPath}
            className="flex h-8 items-center gap-1.5 rounded-md border border-foreground/20 px-2 transition-all hover:border-foreground/30 hover:opacity-100 focus:outline-none focus:ring-2 focus:ring-ring focus:ring-offset-2"
          >
            <X className="h-4 w-4" />
            <span className="text-xs font-medium">ESC</span>
          </Button>
        </div>
        <div className="flex flex-col gap-8 lg:flex-row">
          {/* Sidebar Navigation */}
          <aside className="w-full lg:sticky lg:top-24 lg:h-fit lg:max-h-[calc(100vh-8rem)] lg:w-64 lg:shrink-0 lg:overflow-y-auto">
            <div className="space-y-1">
              <nav className="space-y-1">
                {settingsNavigation.map((item) => {
                  const Icon = item.icon;
                  return (
                    <NavLink
                      key={item.path}
                      to={item.path}
                      end
                      className={({ isActive }) =>
                        cn(
                          'flex items-start gap-3 rounded-lg border px-3 py-2 text-sm transition-colors',
                          isActive
                            ? 'border-primary/30 bg-primary text-primary-foreground shadow-sm'
                            : 'border-border/60 bg-background text-foreground hover:bg-muted/60'
                        )
                      }
                    >
                      <Icon className="mt-0.5 h-4 w-4 shrink-0" />
                      <div className="min-w-0 flex-1">
                        <div className="font-medium">
                          {settingsNavLabels[item.path]?.name ?? item.path}
                        </div>
                        <div className="text-xs opacity-80">
                          {settingsNavLabels[item.path]?.desc ?? ''}
                        </div>
                      </div>
                    </NavLink>
                  );
                })}
              </nav>
            </div>
          </aside>

          {/* Main Content */}
          <main className="min-w-0 flex-1">
            <Outlet />
          </main>
        </div>
      </div>
    </div>
  );
}
