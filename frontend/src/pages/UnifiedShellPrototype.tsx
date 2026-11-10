import { useMemo, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import '@astryxdesign/core/reset.css';
import '@astryxdesign/core/astryx.css';
import '@astryxdesign/theme-neutral/theme.css';
import '@/styles/legacy/index.css';
import logoRecreated from '@/assets/logo-recreated.svg';
import {
  Activity,
  AppWindow,
  ArrowLeft,
  Bot,
  ChevronDown,
  Code2,
  Columns2,
  FileCode2,
  FolderGit2,
  FolderOpen,
  GitBranch,
  GitPullRequest,
  Globe,
  Kanban,
  LayoutGrid,
  Maximize2,
  MessagesSquare,
  Moon,
  Palette,
  PanelLeftClose,
  PanelLeftOpen,
  Plus,
  Search,
  Send,
  Server,
  Settings,
  Sparkles,
  Sun,
  Terminal,
  TrendingUp,
  Users,
  Wifi,
  X,
} from 'lucide-react';
import { cn } from '@/lib/utils';

type TopMode = 'workspace' | 'dashboard';
type LeftPanelId = 'files' | 'git' | 'sessions' | 'bots';
type BStageMode = 'tabs' | 'canvas';
type DashboardSection = 'tasks' | 'repositories' | 'metrics';

type SurfaceKind =
  | 'bot-space'
  | 'group-space'
  | 'session'
  | 'code'
  | 'terminal'
  | 'browser'
  | 'process';

interface HostItem {
  id: string;
  name: string;
  address: string;
  os: string;
  latencyMs: number;
  status: 'online' | 'busy';
  cpuLoad: number;
  memUsedGb: string;
  activeAgents: number;
}

interface ProjectItem {
  id: string;
  hostId: string;
  name: string;
  rootPath: string;
  defaultBranch: string;
  runningSessions: number;
  unreadBots: number;
  repoCount: number;
}

interface StageTabItem {
  id: string;
  title: string;
  subtitle: string;
  kind: SurfaceKind;
  badge?: string;
  worktreeBranch?: string;
  worktreePath?: string;
}

const HOSTS: HostItem[] = [
  {
    id: 'local',
    name: 'Local Host (本机)',
    address: '127.0.0.1 · Windows 11 Pro',
    os: 'Windows',
    latencyMs: 1,
    status: 'online',
    cpuLoad: 24,
    memUsedGb: '18.4 / 64 GB',
    activeAgents: 3,
  },
  {
    id: 'mac-studio',
    name: 'Mac Studio M3 Ultra',
    address: '192.168.1.88 · macOS Sequoia',
    os: 'macOS',
    latencyMs: 12,
    status: 'busy',
    cpuLoad: 68,
    memUsedGb: '92.0 / 192 GB',
    activeAgents: 7,
  },
  {
    id: 'cloud-devbox',
    name: 'Cloud GPU DevBox (us-west)',
    address: '10.24.8.109 · Ubuntu 24.04',
    os: 'Linux',
    latencyMs: 38,
    status: 'online',
    cpuLoad: 41,
    memUsedGb: '44.2 / 128 GB',
    activeAgents: 4,
  },
];

const PROJECTS: ProjectItem[] = [
  {
    id: 'vibex',
    hostId: 'local',
    name: 'VibeX',
    rootPath: 'C:/Users/18190/Documents/projects/VibeX',
    defaultBranch: 'main',
    runningSessions: 3,
    unreadBots: 2,
    repoCount: 2,
  },
  {
    id: 'vibex-plugins',
    hostId: 'local',
    name: 'vibex-plugin-registry',
    rootPath: 'C:/Users/18190/Documents/projects/vibex-plugins',
    defaultBranch: 'main',
    runningSessions: 1,
    unreadBots: 0,
    repoCount: 1,
  },
  {
    id: 'core-engine',
    hostId: 'mac-studio',
    name: 'vibex-agent-runtime',
    rootPath: '~/workspace/vibex-agent-runtime',
    defaultBranch: 'feat/multi-host',
    runningSessions: 4,
    unreadBots: 3,
    repoCount: 3,
  },
  {
    id: 'llm-eval',
    hostId: 'cloud-devbox',
    name: 'benchmark-harness',
    rootPath: '/srv/projects/benchmark-harness',
    defaultBranch: 'main',
    runningSessions: 2,
    unreadBots: 1,
    repoCount: 1,
  },
];

const INITIAL_STAGE_ITEMS: StageTabItem[] = [
  {
    id: 'group-shell-refactor',
    title: '#Shell重构攻坚群',
    subtitle: 'GroupSpace · 4 位成员 (@主管Bot, @UI设计师, @前端架构, @QA)',
    kind: 'group-space',
    badge: '3 条新进展',
  },
  {
    id: 'bot-ui-designer',
    title: '@UI设计师',
    subtitle: 'BotSpace · 一对一协作空间',
    kind: 'bot-space',
    badge: '在线',
  },
  {
    id: 'session-shell-nav',
    title: '实现 A/B 区 Shell Nav 合并布局',
    subtitle: '会话详情 · Claude Opus 4.6',
    kind: 'session',
    badge: '运行中',
    worktreeBranch: 'wt/feat-shell-nav',
    worktreePath: '.vibex/worktrees/s-901-shell-nav',
  },
  {
    id: 'code-appshell',
    title: 'AppShell.tsx',
    subtitle: 'frontend/src/components/layout/AppShell.tsx',
    kind: 'code',
    badge: '+84 -29',
  },
  {
    id: 'terminal-dev',
    title: 'pnpm tauri dev',
    subtitle: '终端 · PID 16496 (端口 3000)',
    kind: 'terminal',
    badge: '03:42:18',
  },
  {
    id: 'browser-preview',
    title: '内置浏览器 · 127.0.0.1:3000',
    subtitle: 'Browser Surface · 实时热重载预览',
    kind: 'browser',
    badge: 'HMR 就绪',
  },
];

export function UnifiedShellPrototype() {
  const navigate = useNavigate();

  // Theme & Shell State
  const [darkShell, setDarkShell] = useState(false);
  const [topMode, setTopMode] = useState<TopMode>('workspace');
  const [leftPanel, setLeftPanel] = useState<LeftPanelId>('bots');
  const [leftDrawerOpen, setLeftDrawerOpen] = useState(true);
  // 工作区 B区表现形式（自由标签 vs 无限画布）通过「设置 - 外观」调整
  const [bStageMode, setBStageMode] = useState<BStageMode>('tabs');
  const [splitPaneOpen, setSplitPaneOpen] = useState(true);
  const [dashboardSection, setDashboardSection] =
    useState<DashboardSection>('tasks');
  const [settingsOpen, setSettingsOpen] = useState(false);

  // Host & Project Context (No global worktree selector!)
  const [selectedHostId, setSelectedHostId] = useState<string>('local');
  const [selectedProjectId, setSelectedProjectId] = useState<string>('vibex');
  const [hostMenuOpen, setHostMenuOpen] = useState(false);
  const [projectMenuOpen, setProjectMenuOpen] = useState(false);

  // Stage Tabs & Active Selection
  const [openItems, setOpenItems] =
    useState<StageTabItem[]>(INITIAL_STAGE_ITEMS);
  const [activeTabId, setActiveTabId] = useState<string>(
    'group-shell-refactor'
  );
  const [secondaryTabId, setSecondaryTabId] =
    useState<string>('session-shell-nav');
  const [canvasZoom, setCanvasZoom] = useState<number>(100);
  const [sessionScopeFilter, setSessionScopeFilter] = useState<
    'project' | 'all-host'
  >('project');

  const currentHost = useMemo(
    () => HOSTS.find((h) => h.id === selectedHostId) ?? HOSTS[0],
    [selectedHostId]
  );

  const hostProjects = useMemo(
    () => PROJECTS.filter((p) => p.hostId === selectedHostId),
    [selectedHostId]
  );

  const currentProject = useMemo(
    () =>
      PROJECTS.find((p) => p.id === selectedProjectId) ??
      hostProjects[0] ??
      PROJECTS[0],
    [selectedProjectId, hostProjects]
  );

  const activeItem = useMemo(
    () => openItems.find((item) => item.id === activeTabId) ?? openItems[0],
    [openItems, activeTabId]
  );

  const secondaryItem = useMemo(
    () =>
      openItems.find(
        (item) => item.id === secondaryTabId && item.id !== activeItem?.id
      ) ??
      openItems.find((item) => item.id !== activeItem?.id) ??
      openItems[0],
    [openItems, secondaryTabId, activeItem]
  );

  const handleSelectHost = (hostId: string) => {
    setSelectedHostId(hostId);
    const firstProj = PROJECTS.find((p) => p.hostId === hostId);
    if (firstProj) {
      setSelectedProjectId(firstProj.id);
    }
    setHostMenuOpen(false);
  };

  const openOrFocusStageItem = (item: StageTabItem) => {
    setOpenItems((prev) =>
      prev.some((x) => x.id === item.id) ? prev : [...prev, item]
    );
    setActiveTabId(item.id);
    if (topMode !== 'workspace') {
      setTopMode('workspace');
    }
  };

  const closeStageItem = (id: string) => {
    if (openItems.length <= 1) return;
    const next = openItems.filter((item) => item.id !== id);
    setOpenItems(next);
    if (activeTabId === id) {
      setActiveTabId(next[0].id);
    }
  };

  const showLeftDrawer = topMode === 'workspace' && leftDrawerOpen;

  return (
    <div
      data-testid="unified-shell-prototype"
      className={cn('legacy-design', darkShell && 'dark')}
      style={{ height: '100vh', width: '100vw', overflow: 'hidden' }}
    >
      <div
        style={{
          height: '100%',
          width: '100%',
          backgroundColor: darkShell ? '#111318' : '#ECECEF',
          color: darkShell ? '#F4F4F5' : '#27272A',
        }}
        className="flex h-full w-full flex-col overflow-hidden select-none font-sans transition-colors duration-200"
      >
        {/* ===================================================================
            A区 · 顶部一体式导航栏 (Top Shell Nav - 无底边框，与左侧栏融为一体)
           =================================================================== */}
        <header
          data-tauri-drag-region
          className="relative z-30 flex h-11 shrink-0 items-center justify-between px-3"
        >
          {/* 左上角：Logo + Host 选择器 + Project 选择器（去掉页面级 Worktree 切换） */}
          <div className="flex items-center gap-1.5">
            <button
              type="button"
              onClick={() => navigate('/local-projects')}
              className={cn(
                'group flex h-8 items-center gap-2 rounded-lg px-2 text-xs font-medium transition-colors',
                darkShell
                  ? 'hover:bg-white/10 text-zinc-200'
                  : 'hover:bg-black/[0.06] text-zinc-700'
              )}
              title="返回现网页面"
            >
              <img
                src={logoRecreated}
                alt="VibeX"
                className="h-5 w-5 shrink-0 rounded-[4px]"
              />
              <span className="hidden sm:inline-flex items-center gap-1 text-[11px] opacity-75 group-hover:opacity-100">
                <ArrowLeft className="h-3 w-3" />
                返回现网
              </span>
            </button>

            <span
              className={cn(
                'text-xs',
                darkShell ? 'text-zinc-600' : 'text-zinc-300'
              )}
            >
              /
            </span>

            {/* 1. 新增：Host 选择器 */}
            <div className="relative">
              <button
                type="button"
                onClick={() => {
                  setHostMenuOpen((v) => !v);
                  setProjectMenuOpen(false);
                }}
                data-testid="host-selector-trigger"
                className={cn(
                  'flex h-7 items-center gap-1.5 rounded-lg px-2.5 text-xs font-medium transition-all',
                  darkShell
                    ? 'bg-white/[0.06] hover:bg-white/[0.11] text-zinc-100'
                    : 'bg-black/[0.05] hover:bg-black/[0.08] text-zinc-800'
                )}
              >
                <Server className="h-3.5 w-3.5 text-emerald-500" />
                <span className="max-w-[140px] truncate">
                  {currentHost.name}
                </span>
                <span className="inline-flex items-center gap-1 rounded-full bg-emerald-500/15 px-1.5 py-0.2 text-[10px] font-medium text-emerald-600 dark:text-emerald-400 tabular-nums">
                  <span className="h-1.5 w-1.5 rounded-full bg-emerald-500" />
                  {currentHost.latencyMs}ms
                </span>
                <ChevronDown className="h-3 w-3 opacity-60" />
              </button>

              {hostMenuOpen && (
                <div
                  className={cn(
                    'absolute left-0 top-9 z-50 w-80 rounded-xl p-1.5 shadow-xl ring-1',
                    darkShell
                      ? 'bg-[#1A1D24] ring-white/10 text-zinc-100'
                      : 'bg-white ring-black/10 text-zinc-800'
                  )}
                >
                  <div className="flex items-center justify-between px-2.5 py-1.5 text-[11px] font-medium opacity-60">
                    <span>切换连接主机 (Host) · 单窗口直连</span>
                    <span className="tabular-nums">{HOSTS.length} 台可用</span>
                  </div>
                  {HOSTS.map((host) => {
                    const active = host.id === currentHost.id;
                    return (
                      <button
                        key={host.id}
                        type="button"
                        onClick={() => handleSelectHost(host.id)}
                        className={cn(
                          'flex w-full items-start justify-between rounded-lg px-2.5 py-2 text-left text-xs transition-colors',
                          active
                            ? darkShell
                              ? 'bg-white/10'
                              : 'bg-zinc-100 font-medium'
                            : darkShell
                              ? 'hover:bg-white/5'
                              : 'hover:bg-zinc-50'
                        )}
                      >
                        <div className="min-w-0">
                          <div className="flex items-center gap-1.5">
                            <span className="h-2 w-2 rounded-full bg-emerald-500" />
                            <span className="truncate font-medium">
                              {host.name}
                            </span>
                          </div>
                          <div className="mt-0.5 text-[11px] opacity-60">
                            {host.address}
                          </div>
                        </div>
                        <div className="shrink-0 text-right text-[11px] tabular-nums">
                          <div className="text-emerald-500 font-medium">
                            {host.latencyMs}ms
                          </div>
                          <div className="opacity-60">
                            {host.activeAgents} Agents · CPU {host.cpuLoad}%
                          </div>
                        </div>
                      </button>
                    );
                  })}
                  <div
                    className={cn(
                      'mt-1 border-t pt-1',
                      darkShell ? 'border-white/10' : 'border-zinc-100'
                    )}
                  >
                    <button
                      type="button"
                      onClick={() => setHostMenuOpen(false)}
                      className={cn(
                        'flex w-full items-center gap-1.5 rounded-lg px-2.5 py-1.5 text-xs font-medium text-blue-500 transition-colors',
                        darkShell ? 'hover:bg-white/5' : 'hover:bg-blue-50/60'
                      )}
                    >
                      <Plus className="h-3.5 w-3.5" />
                      连接新的远程 Host 节点...
                    </button>
                  </div>
                </div>
              )}
            </div>
          </div>

          {/* 顶部正中：归并后的双模态切换（工作区 vs 看板，彻底去掉独立的“协作空间”Tab） */}
          <div
            className={cn(
              'flex items-center rounded-xl p-0.5',
              darkShell ? 'bg-white/[0.07]' : 'bg-black/[0.06]'
            )}
          >
            <button
              type="button"
              data-testid="top-tab-workspace"
              onClick={() => setTopMode('workspace')}
              className={cn(
                'flex h-7 items-center gap-1.5 rounded-[10px] px-3.5 text-xs font-medium transition-all',
                topMode === 'workspace'
                  ? darkShell
                    ? 'bg-zinc-800 text-white shadow-sm'
                    : 'bg-white text-zinc-900 shadow-sm'
                  : 'opacity-65 hover:opacity-100'
              )}
            >
              <Code2 className="h-3.5 w-3.5" />
              <span>工作区</span>
              <span className="rounded-full bg-blue-500/15 px-1.5 text-[10px] font-semibold text-blue-500 tabular-nums">
                {openItems.length}
              </span>
            </button>

            <button
              type="button"
              data-testid="top-tab-dashboard"
              onClick={() => setTopMode('dashboard')}
              className={cn(
                'flex h-7 items-center gap-1.5 rounded-[10px] px-3.5 text-xs font-medium transition-all',
                topMode === 'dashboard'
                  ? darkShell
                    ? 'bg-zinc-800 text-white shadow-sm'
                    : 'bg-white text-zinc-900 shadow-sm'
                  : 'opacity-65 hover:opacity-100'
              )}
            >
              <Kanban className="h-3.5 w-3.5" />
              <span>看板</span>
            </button>
          </div>

          {/* 顶部右侧：全局搜索 + 设置(外观)快捷入口 */}
          <div className="flex items-center gap-2">
            <div
              className={cn(
                'hidden lg:flex h-7 w-60 items-center gap-1.5 rounded-full px-3 text-xs transition-colors',
                darkShell
                  ? 'bg-white/[0.06] text-zinc-400 ring-1 ring-white/10'
                  : 'bg-white/80 text-zinc-500 ring-1 ring-black/[0.06]'
              )}
            >
              <Search className="h-3.5 w-3.5 opacity-60" />
              <span className="truncate">搜索文件、Bot、会话或命令...</span>
              <kbd className="ml-auto text-[10px] opacity-50">⌘K</kbd>
            </div>

            <button
              type="button"
              data-testid="open-appearance-settings-top"
              onClick={() => setSettingsOpen(true)}
              className={cn(
                'flex h-7 items-center gap-1.5 rounded-lg px-2.5 text-xs font-medium transition-colors',
                darkShell
                  ? 'bg-white/[0.06] hover:bg-white/12 text-zinc-200'
                  : 'bg-black/[0.05] hover:bg-black/[0.09] text-zinc-700'
              )}
              title="在「设置 → 外观」中切换工作区 B 区表现形式（自由标签 / 无限画布）与主题"
            >
              <Palette className="h-3.5 w-3.5 text-indigo-500" />
              <span>
                外观：{bStageMode === 'tabs' ? '自由标签' : '无限画布'}
              </span>
            </button>
          </div>
        </header>

        {/* ===================================================================
            主体区域：左侧 A区 (窄轨 + 工作区可选左侧面板) + 右侧 B区 (白色圆角主舞台)
           =================================================================== */}
        <div className="flex min-h-0 flex-1 overflow-hidden">
          {/* A区 · 左侧边栏 (Activity Rail)
              - 工作区模式：文件树、Git面板、会话列表、Bot列表
              - 看板模式：计量统计、仓库面板、任务面板 */}
          <aside className="flex w-12 shrink-0 flex-col items-center justify-between py-2">
            <div className="flex flex-col items-center gap-1.5">
              {topMode === 'workspace'
                ? (
                    [
                      {
                        id: 'files',
                        label: '文件树',
                        icon: FolderOpen,
                        badge: null,
                      },
                      {
                        id: 'git',
                        label: 'Git 面板',
                        icon: GitBranch,
                        badge: '4',
                      },
                      {
                        id: 'sessions',
                        label: '会话列表',
                        icon: MessagesSquare,
                        badge: String(currentProject.runningSessions),
                      },
                      {
                        id: 'bots',
                        label: 'Bot 列表 (含群空间)',
                        icon: Bot,
                        badge:
                          currentProject.unreadBots > 0
                            ? String(currentProject.unreadBots)
                            : null,
                      },
                    ] as const
                  ).map((item) => {
                    const Icon = item.icon;
                    const isSelected =
                      leftDrawerOpen && leftPanel === item.id;
                    return (
                      <button
                        key={item.id}
                        type="button"
                        data-testid={`rail-workspace-${item.id}`}
                        onClick={() => {
                          if (leftPanel === item.id) {
                            setLeftDrawerOpen((v) => !v);
                          } else {
                            setLeftPanel(item.id);
                            setLeftDrawerOpen(true);
                          }
                        }}
                        title={item.label}
                        className={cn(
                          'relative flex h-9 w-9 items-center justify-center rounded-xl transition-all',
                          isSelected
                            ? darkShell
                              ? 'bg-white/14 text-white shadow-xs'
                              : 'bg-black/[0.09] text-zinc-900 shadow-xs'
                            : 'opacity-60 hover:opacity-100 hover:bg-black/[0.04] dark:hover:bg-white/[0.05]'
                        )}
                      >
                        <Icon className="h-4 w-4" />
                        {item.badge && (
                          <span className="absolute -right-0.5 -top-0.5 flex h-4 min-w-4 items-center justify-center rounded-full bg-blue-500 px-1 text-[9px] font-semibold text-white tabular-nums">
                            {item.badge}
                          </span>
                        )}
                      </button>
                    );
                  })
                : (
                    [
                      {
                        id: 'metrics',
                        label: '计量统计',
                        icon: TrendingUp,
                      },
                      {
                        id: 'repositories',
                        label: '仓库面板',
                        icon: FolderGit2,
                      },
                      {
                        id: 'tasks',
                        label: '任务面板',
                        icon: Kanban,
                      },
                    ] as const
                  ).map((sec) => {
                    const Icon = sec.icon;
                    const isSelected = dashboardSection === sec.id;
                    return (
                      <button
                        key={sec.id}
                        type="button"
                        data-testid={`rail-dashboard-${sec.id}`}
                        onClick={() => setDashboardSection(sec.id)}
                        title={`看板 · ${sec.label}`}
                        className={cn(
                          'relative flex h-9 w-9 items-center justify-center rounded-xl transition-all',
                          isSelected
                            ? darkShell
                              ? 'bg-white/14 text-white shadow-xs'
                              : 'bg-black/[0.09] text-zinc-900 shadow-xs'
                            : 'opacity-60 hover:opacity-100 hover:bg-black/[0.04] dark:hover:bg-white/[0.05]'
                        )}
                      >
                        <Icon className="h-4 w-4" />
                      </button>
                    );
                  })}
            </div>

            <div className="flex flex-col items-center gap-1.5">
              {topMode === 'workspace' && (
                <button
                  type="button"
                  onClick={() => setLeftDrawerOpen((v) => !v)}
                  className="flex h-8 w-8 items-center justify-center rounded-lg opacity-60 hover:opacity-100"
                  title={leftDrawerOpen ? '收起左侧面板' : '展开左侧面板'}
                >
                  {leftDrawerOpen ? (
                    <PanelLeftClose className="h-4 w-4" />
                  ) : (
                    <PanelLeftOpen className="h-4 w-4" />
                  )}
                </button>
              )}
              <button
                type="button"
                data-testid="open-settings-rail"
                onClick={() => setSettingsOpen(true)}
                className={cn(
                  'flex h-8 w-8 items-center justify-center rounded-lg transition-colors',
                  settingsOpen
                    ? 'bg-blue-500 text-white opacity-100'
                    : 'opacity-70 hover:opacity-100 hover:bg-black/[0.05]'
                )}
                title="设置 → 外观（调整工作区自由标签 / 无限画布）"
              >
                <Settings className="h-4 w-4" />
              </button>
            </div>
          </aside>

          {/* A区 · 左侧二级面板 (仅工作区模式显示；看板模式自动收起，少一个左侧栏部分) */}
          {showLeftDrawer && (
            <section className="flex w-64 shrink-0 flex-col px-2 pb-1 pt-1">
              {/* 1. 文件树面板 */}
              {leftPanel === 'files' && (
                <div className="flex flex-1 flex-col overflow-hidden">
                  <div className="mb-2 flex items-center justify-between px-2">
                    <span className="text-xs font-semibold">
                      项目文件树 ({currentProject.name})
                    </span>
                    <span className="rounded bg-black/[0.06] dark:bg-white/10 px-1.5 py-0.5 text-[10px] opacity-70">
                      固定主目录
                    </span>
                  </div>
                  <div className="space-y-0.5 overflow-y-auto px-1 text-xs">
                    <div className="flex items-center gap-1.5 rounded-lg px-2 py-1.5 font-medium opacity-80">
                      <ChevronDown className="h-3.5 w-3.5" />
                      <FolderOpen className="h-3.5 w-3.5 text-amber-500" />
                      <span>src/components/layout</span>
                    </div>
                    {[
                      {
                        id: 'code-appshell',
                        name: 'AppShell.tsx',
                        path: 'frontend/src/components/layout/AppShell.tsx',
                        mod: 'M',
                      },
                      {
                        id: 'code-topnav',
                        name: 'HostProjectHeader.tsx',
                        path: 'frontend/src/components/layout/HostProjectHeader.tsx',
                        mod: 'U',
                      },
                      {
                        id: 'code-sidenav',
                        name: 'UnifiedSideNav.tsx',
                        path: 'frontend/src/components/layout/UnifiedSideNav.tsx',
                        mod: 'M',
                      },
                    ].map((file) => {
                      const selected = activeItem?.id === file.id;
                      return (
                        <button
                          key={file.id}
                          type="button"
                          onClick={() =>
                            openOrFocusStageItem({
                              id: file.id,
                              title: file.name,
                              subtitle: file.path,
                              kind: 'code',
                              badge: file.mod === 'M' ? '已修改' : '新增',
                            })
                          }
                          className={cn(
                            'ml-3 flex w-[calc(100%-12px)] items-center justify-between rounded-full px-3 py-1.5 text-left transition-colors',
                            selected
                              ? darkShell
                                ? 'bg-white/14 text-white font-medium'
                                : 'bg-black/[0.09] text-zinc-900 font-medium'
                              : 'opacity-75 hover:opacity-100 hover:bg-black/[0.04]'
                          )}
                        >
                          <span className="flex items-center gap-1.5 truncate">
                            <FileCode2 className="h-3.5 w-3.5 shrink-0 text-blue-500" />
                            <span className="truncate">{file.name}</span>
                          </span>
                          <span className="text-[10px] font-mono text-amber-500">
                            {file.mod}
                          </span>
                        </button>
                      );
                    })}
                  </div>
                </div>
              )}

              {/* 2. Git 面板 */}
              {leftPanel === 'git' && (
                <div className="flex flex-1 flex-col overflow-hidden">
                  <div className="mb-2 flex items-center justify-between px-2">
                    <span className="text-xs font-semibold">
                      Git 变更 ({currentProject.defaultBranch})
                    </span>
                    <span className="text-[11px] opacity-60 tabular-nums">
                      4 个文件
                    </span>
                  </div>
                  <div className="space-y-1 overflow-y-auto px-1 text-xs">
                    {[
                      {
                        file: 'AppShell.tsx',
                        stat: '+84 -29',
                        desc: '合并 A/B 区 Shell 导航与圆角主舞台',
                      },
                      {
                        file: 'Toolbar.tsx',
                        stat: '+42 -118',
                        desc: '移除顶栏 Worktree 选择器与协作空间 Tab',
                      },
                      {
                        file: 'HostSwitcher.tsx',
                        stat: '+136 -0',
                        desc: '左上角新增跨主机单窗口直连选择器',
                      },
                      {
                        file: 'SessionWorktreeBadge.tsx',
                        stat: '+64 -12',
                        desc: 'Worktree 与会话实例内置绑定',
                      },
                    ].map((g) => (
                      <button
                        key={g.file}
                        type="button"
                        onClick={() =>
                          openOrFocusStageItem({
                            id: `git-${g.file}`,
                            title: `Diff · ${g.file}`,
                            subtitle: g.desc,
                            kind: 'code',
                            badge: g.stat,
                          })
                        }
                        className={cn(
                          'w-full rounded-xl p-2 text-left transition-colors',
                          darkShell
                            ? 'hover:bg-white/[0.07]'
                            : 'hover:bg-black/[0.05]'
                        )}
                      >
                        <div className="flex items-center justify-between font-medium">
                          <span className="truncate">{g.file}</span>
                          <span className="font-mono text-[10px] text-emerald-500 tabular-nums">
                            {g.stat}
                          </span>
                        </div>
                        <div className="mt-0.5 truncate text-[11px] opacity-60">
                          {g.desc}
                        </div>
                      </button>
                    ))}
                  </div>
                </div>
              )}

              {/* 3. 会话列表面板 */}
              {leftPanel === 'sessions' && (
                <div className="flex flex-1 flex-col overflow-hidden">
                  <div className="mb-2 flex items-center justify-between px-2">
                    <span className="text-xs font-semibold">会话列表</span>
                    <div
                      className={cn(
                        'flex rounded-md p-0.5 text-[10px]',
                        darkShell ? 'bg-white/10' : 'bg-black/[0.06]'
                      )}
                    >
                      <button
                        type="button"
                        onClick={() => setSessionScopeFilter('project')}
                        className={cn(
                          'rounded px-1.5 py-0.5',
                          sessionScopeFilter === 'project' &&
                            (darkShell
                              ? 'bg-zinc-800 text-white'
                              : 'bg-white text-zinc-900 shadow-2xs')
                        )}
                      >
                        当前项目
                      </button>
                      <button
                        type="button"
                        onClick={() => setSessionScopeFilter('all-host')}
                        className={cn(
                          'rounded px-1.5 py-0.5',
                          sessionScopeFilter === 'all-host' &&
                            (darkShell
                              ? 'bg-zinc-800 text-white'
                              : 'bg-white text-zinc-900 shadow-2xs')
                        )}
                      >
                        当前 Host 全部
                      </button>
                    </div>
                  </div>

                  <div className="space-y-1 overflow-y-auto px-1 text-xs">
                    {[
                      {
                        id: 'session-shell-nav',
                        title: '实现 A/B 区 Shell Nav 合并布局',
                        agent: 'Claude Opus 4.6',
                        wt: 'wt/feat-shell-nav',
                        wtPath: '.vibex/worktrees/s-901-shell-nav',
                        status: '运行中',
                      },
                      {
                        id: 'session-host-rpc',
                        title: '重构 Host -> Project 多节点 RPC 路由',
                        agent: 'Codex Pro',
                        wt: 'wt/multi-host-rpc',
                        wtPath: '.vibex/worktrees/s-902-host-rpc',
                        status: '等待确认',
                      },
                      {
                        id: 'session-icon-fix',
                        title: '修复 Win11 任务栏图标 AppUserModel 缓存',
                        agent: 'Gemini 2.5 Pro',
                        wt: 'main (项目主目录)',
                        wtPath: 'C:/Users/18190/Documents/projects/VibeX',
                        status: '已完成',
                      },
                    ].map((sess) => {
                      const isActive = activeItem?.id === sess.id;
                      return (
                        <button
                          key={sess.id}
                          type="button"
                          onClick={() =>
                            openOrFocusStageItem({
                              id: sess.id,
                              title: sess.title,
                              subtitle: `会话详情 · ${sess.agent}`,
                              kind: 'session',
                              badge: sess.status,
                              worktreeBranch: sess.wt,
                              worktreePath: sess.wtPath,
                            })
                          }
                          className={cn(
                            'w-full rounded-xl p-2.5 text-left transition-all',
                            isActive
                              ? darkShell
                                ? 'bg-white/12 text-white shadow-2xs'
                                : 'bg-black/[0.08] text-zinc-900 shadow-2xs'
                              : darkShell
                                ? 'hover:bg-white/[0.06]'
                                : 'hover:bg-black/[0.04]'
                          )}
                        >
                          <div className="truncate font-medium">
                            {sess.title}
                          </div>
                          <div className="mt-1 flex items-center justify-between text-[10px] opacity-70">
                            <span>{sess.agent}</span>
                            <span className="text-blue-500 font-medium">
                              {sess.status}
                            </span>
                          </div>
                          <div
                            className={cn(
                              'mt-1.5 inline-flex items-center gap-1 rounded-md px-1.5 py-0.5 font-mono text-[10px]',
                              darkShell
                                ? 'bg-white/[0.07] text-zinc-300'
                                : 'bg-white/75 text-zinc-600'
                            )}
                          >
                            <GitBranch className="h-2.5 w-2.5 text-purple-500" />
                            <span>内置 Worktree: {sess.wt}</span>
                          </div>
                        </button>
                      );
                    })}
                  </div>
                </div>
              )}

              {/* 4. Bot 列表面板（原「协作空间」归并至此） */}
              {leftPanel === 'bots' && (
                <div className="flex flex-1 flex-col overflow-hidden">
                  <div className="mb-2 flex items-center justify-between px-2">
                    <span className="text-xs font-semibold">Bot 与协作空间</span>
                    <span className="rounded bg-emerald-500/15 px-1.5 py-0.5 text-[10px] font-medium text-emerald-600 dark:text-emerald-400">
                      跨项目常驻
                    </span>
                  </div>

                  <div className="space-y-3 overflow-y-auto px-1 text-xs">
                    <div>
                      <div className="mb-1 flex items-center justify-between px-2 text-[10px] font-semibold uppercase tracking-wider opacity-50">
                        <span>GroupSpace · 多 Bot 群聊</span>
                        <Plus className="h-3 w-3 cursor-pointer" />
                      </div>
                      <div className="space-y-0.5">
                        {[
                          {
                            id: 'group-shell-refactor',
                            name: '#Shell重构攻坚群',
                            members: '4 Bot · 正在讨论 A/B 分区细节',
                            unread: 3,
                          },
                          {
                            id: 'group-release-ops',
                            name: '#桌面端发版巡检群',
                            members: '3 Bot · CI 全部通过',
                            unread: 0,
                          },
                        ].map((grp) => {
                          const selected = activeItem?.id === grp.id;
                          return (
                            <button
                              key={grp.id}
                              type="button"
                              onClick={() =>
                                openOrFocusStageItem({
                                  id: grp.id,
                                  title: grp.name,
                                  subtitle: `GroupSpace · ${grp.members}`,
                                  kind: 'group-space',
                                  badge:
                                    grp.unread > 0
                                      ? `${grp.unread} 条新消息`
                                      : '活跃',
                                })
                              }
                              className={cn(
                                'flex w-full items-center justify-between rounded-xl px-2.5 py-2 text-left transition-colors',
                                selected
                                  ? darkShell
                                    ? 'bg-white/14 text-white font-medium'
                                    : 'bg-black/[0.09] text-zinc-900 font-medium'
                                  : 'opacity-80 hover:opacity-100 hover:bg-black/[0.04]'
                              )}
                            >
                              <div className="min-w-0">
                                <div className="flex items-center gap-1.5">
                                  <Users className="h-3.5 w-3.5 shrink-0 text-indigo-500" />
                                  <span className="truncate">{grp.name}</span>
                                </div>
                                <div className="mt-0.5 truncate text-[10px] opacity-60">
                                  {grp.members}
                                </div>
                              </div>
                              {grp.unread > 0 && (
                                <span className="ml-1 rounded-full bg-indigo-500 px-1.5 py-0.2 text-[10px] font-semibold text-white tabular-nums">
                                  {grp.unread}
                                </span>
                              )}
                            </button>
                          );
                        })}
                      </div>
                    </div>

                    <div>
                      <div className="mb-1 flex items-center justify-between px-2 text-[10px] font-semibold uppercase tracking-wider opacity-50">
                        <span>BotSpace · 专属 Bot</span>
                        <Plus className="h-3 w-3 cursor-pointer" />
                      </div>
                      <div className="space-y-0.5">
                        {[
                          {
                            id: 'bot-ui-designer',
                            name: '@UI设计师',
                            role: '视觉规范 / 原型设计 / 交互架构',
                            state: '正在输出原型',
                          },
                          {
                            id: 'bot-arch',
                            name: '@系统架构师',
                            role: 'Host -> Project RPC 与状态模型',
                            state: '空闲待命',
                          },
                          {
                            id: 'bot-rust',
                            name: '@Rust后端专家',
                            role: 'Tauri 窗口管理与守护进程',
                            state: '后台执行中',
                          },
                        ].map((bot) => {
                          const selected = activeItem?.id === bot.id;
                          return (
                            <button
                              key={bot.id}
                              type="button"
                              onClick={() =>
                                openOrFocusStageItem({
                                  id: bot.id,
                                  title: bot.name,
                                  subtitle: `BotSpace · ${bot.role}`,
                                  kind: 'bot-space',
                                  badge: bot.state,
                                })
                              }
                              className={cn(
                                'flex w-full items-center justify-between rounded-xl px-2.5 py-2 text-left transition-colors',
                                selected
                                  ? darkShell
                                    ? 'bg-white/14 text-white font-medium'
                                    : 'bg-black/[0.09] text-zinc-900 font-medium'
                                  : 'opacity-80 hover:opacity-100 hover:bg-black/[0.04]'
                              )}
                            >
                              <div className="min-w-0">
                                <div className="flex items-center gap-1.5">
                                  <Bot className="h-3.5 w-3.5 shrink-0 text-emerald-500" />
                                  <span className="truncate">{bot.name}</span>
                                </div>
                                <div className="mt-0.5 truncate text-[10px] opacity-60">
                                  {bot.role}
                                </div>
                              </div>
                              <span className="h-2 w-2 shrink-0 rounded-full bg-emerald-500" />
                            </button>
                          );
                        })}
                      </div>
                    </div>
                  </div>
                </div>
              )}

              {/* 左侧面板底部快捷拉起 B区工具（终端/浏览器/进程） */}
              <div
                className={cn(
                  'mt-2 rounded-xl p-2 text-[11px]',
                  darkShell ? 'bg-white/[0.04]' : 'bg-black/[0.04]'
                )}
              >
                <div className="mb-1.5 font-medium opacity-65">
                  在右侧 B 区快速打开环境面板：
                </div>
                <div className="grid grid-cols-3 gap-1">
                  <button
                    type="button"
                    onClick={() => openOrFocusStageItem(INITIAL_STAGE_ITEMS[4])}
                    className={cn(
                      'flex items-center justify-center gap-1 rounded-lg py-1 font-medium transition-colors',
                      darkShell
                        ? 'bg-white/8 hover:bg-white/15'
                        : 'bg-white/80 hover:bg-white shadow-2xs'
                    )}
                  >
                    <Terminal className="h-3 w-3" />
                    终端
                  </button>
                  <button
                    type="button"
                    onClick={() => openOrFocusStageItem(INITIAL_STAGE_ITEMS[5])}
                    className={cn(
                      'flex items-center justify-center gap-1 rounded-lg py-1 font-medium transition-colors',
                      darkShell
                        ? 'bg-white/8 hover:bg-white/15'
                        : 'bg-white/80 hover:bg-white shadow-2xs'
                    )}
                  >
                    <Globe className="h-3 w-3" />
                    浏览器
                  </button>
                  <button
                    type="button"
                    onClick={() =>
                      openOrFocusStageItem({
                        id: 'process-monitor',
                        title: '执行进程监控 (3)',
                        subtitle: 'Execution Processes · 实时进程流',
                        kind: 'process',
                        badge: '运行中',
                      })
                    }
                    className={cn(
                      'flex items-center justify-center gap-1 rounded-lg py-1 font-medium transition-colors',
                      darkShell
                        ? 'bg-white/8 hover:bg-white/15'
                        : 'bg-white/80 hover:bg-white shadow-2xs'
                    )}
                  >
                    <Activity className="h-3 w-3" />
                    进程
                  </button>
                </div>
              </div>
            </section>
          )}

          {/* =================================================================
              B区 · 白色内嵌圆角主舞台 (Main Inset Stage)
              - 工作区模式：表现形式由「设置 → 外观」控制（自由标签 vs 无限画布）
              - 看板模式：无二级左栏，由左侧边栏按钮直接切换「计量统计 / 仓库面板 / 任务面板」
             ================================================================= */}
          <main
            style={{
              backgroundColor: darkShell ? '#191C24' : '#FFFFFF',
            }}
            className={cn(
              'mr-2.5 flex min-w-0 flex-1 flex-col overflow-hidden rounded-2xl shadow-sm ring-1 transition-all duration-200',
              darkShell
                ? 'text-zinc-100 ring-white/[0.08]'
                : 'text-zinc-900 ring-black/[0.06]'
            )}
          >
            {topMode === 'workspace' ? (
              bStageMode === 'tabs' ? (
                /* -------------------------------------------------------------
                   B区表现形式 1：自由标签模式 (Free Tabs + 可选分屏)
                   ------------------------------------------------------------- */
                <div className="flex h-full flex-col overflow-hidden">
                  <div
                    className={cn(
                      'flex h-12 shrink-0 items-center justify-between border-b px-3',
                      darkShell ? 'border-white/[0.07]' : 'border-zinc-100'
                    )}
                  >
                    <div className="flex items-center gap-1.5 overflow-x-auto py-1">
                      {openItems.map((tab) => {
                        const isPrimary = tab.id === activeItem?.id;
                        const isSecondary =
                          splitPaneOpen && tab.id === secondaryItem?.id;
                        return (
                          <div
                            key={tab.id}
                            onClick={() => setActiveTabId(tab.id)}
                            className={cn(
                              'group flex h-8 cursor-pointer items-center gap-2 rounded-xl px-3 text-xs font-medium transition-all',
                              isPrimary
                                ? darkShell
                                  ? 'bg-blue-500/20 text-blue-300 ring-1 ring-blue-500/40'
                                  : 'bg-zinc-900 text-white shadow-xs'
                                : isSecondary
                                  ? darkShell
                                    ? 'bg-white/10 text-zinc-200 ring-1 ring-white/15'
                                    : 'bg-zinc-200/80 text-zinc-800'
                                  : darkShell
                                    ? 'bg-white/[0.04] text-zinc-400 hover:bg-white/[0.08]'
                                    : 'bg-zinc-100/80 text-zinc-600 hover:bg-zinc-200/60'
                            )}
                          >
                            <SurfaceKindIcon kind={tab.kind} />
                            <span className="max-w-[140px] truncate">
                              {tab.title}
                            </span>
                            {tab.worktreeBranch && (
                              <span
                                className={cn(
                                  'rounded px-1 py-0.2 font-mono text-[9px]',
                                  isPrimary
                                    ? 'bg-white/20 text-white'
                                    : 'bg-purple-500/15 text-purple-600 dark:text-purple-300'
                                )}
                              >
                                {tab.worktreeBranch}
                              </span>
                            )}
                            <button
                              type="button"
                              onClick={(e) => {
                                e.stopPropagation();
                                closeStageItem(tab.id);
                              }}
                              className="opacity-40 hover:opacity-100"
                            >
                              <X className="h-3 w-3" />
                            </button>
                          </div>
                        );
                      })}
                    </div>

                    <div className="flex shrink-0 items-center gap-1.5 pl-2">
                      <button
                        type="button"
                        onClick={() => setSplitPaneOpen((v) => !v)}
                        className={cn(
                          'flex h-7 items-center gap-1 rounded-lg px-2.5 text-xs font-medium transition-colors',
                          splitPaneOpen
                            ? 'bg-blue-500/15 text-blue-600 dark:text-blue-400'
                            : darkShell
                              ? 'bg-white/5 text-zinc-400 hover:bg-white/10'
                              : 'bg-zinc-100 text-zinc-600 hover:bg-zinc-200'
                        )}
                      >
                        <Columns2 className="h-3.5 w-3.5" />
                        <span>{splitPaneOpen ? '双栏并排中' : '开启分屏'}</span>
                      </button>
                    </div>
                  </div>

                  <div className="flex min-h-0 flex-1 divide-x divide-zinc-100 dark:divide-white/[0.07]">
                    <div className="flex min-w-0 flex-1 flex-col overflow-hidden">
                      {activeItem && (
                        <StageSurfaceView
                          item={activeItem}
                          darkShell={darkShell}
                          project={currentProject}
                          host={currentHost}
                        />
                      )}
                    </div>
                    {splitPaneOpen && secondaryItem && (
                      <div className="hidden xl:flex min-w-0 flex-1 flex-col overflow-hidden">
                        <div
                          className={cn(
                            'flex h-8 items-center justify-between border-b px-3 text-[11px]',
                            darkShell
                              ? 'border-white/[0.06] bg-white/[0.02]'
                              : 'border-zinc-100 bg-zinc-50/60'
                          )}
                        >
                          <span className="font-medium opacity-75">
                            右侧伴随分屏：{secondaryItem.title}
                          </span>
                          <div className="flex items-center gap-1">
                            {openItems
                              .filter((x) => x.id !== activeItem?.id)
                              .slice(0, 4)
                              .map((cand) => (
                                <button
                                  key={cand.id}
                                  type="button"
                                  onClick={() => setSecondaryTabId(cand.id)}
                                  className={cn(
                                    'rounded px-1.5 py-0.5 text-[10px]',
                                    cand.id === secondaryItem.id
                                      ? 'bg-blue-500 text-white'
                                      : 'opacity-60 hover:opacity-100'
                                  )}
                                >
                                  {cand.title.slice(0, 10)}
                                </button>
                              ))}
                          </div>
                        </div>
                        <StageSurfaceView
                          item={secondaryItem}
                          darkShell={darkShell}
                          project={currentProject}
                          host={currentHost}
                        />
                      </div>
                    )}
                  </div>
                </div>
              ) : (
                /* -------------------------------------------------------------
                   B区表现形式 2：无限画布模式 (Infinite Canvas，由设置-外观切换)
                   ------------------------------------------------------------- */
                <div className="relative flex h-full flex-col overflow-hidden">
                  <div className="pointer-events-none absolute left-4 right-4 top-3 z-20 flex items-center justify-between">
                    <div
                      className={cn(
                        'pointer-events-auto flex items-center gap-2 rounded-xl px-3 py-1.5 text-xs shadow-sm ring-1 backdrop-blur-md',
                        darkShell
                          ? 'bg-zinc-900/85 ring-white/10'
                          : 'bg-white/90 ring-black/8'
                      )}
                    >
                      <Sparkles className="h-3.5 w-3.5 text-indigo-500" />
                      <span className="font-medium">
                        B区 · 无限画布模式（通过「设置 → 外观」切换）
                      </span>
                    </div>

                    <div
                      className={cn(
                        'pointer-events-auto flex items-center gap-1 rounded-xl p-1 text-xs shadow-sm ring-1 backdrop-blur-md tabular-nums',
                        darkShell
                          ? 'bg-zinc-900/85 ring-white/10'
                          : 'bg-white/90 ring-black/8'
                      )}
                    >
                      {[85, 100, 115].map((z) => (
                        <button
                          key={z}
                          type="button"
                          onClick={() => setCanvasZoom(z)}
                          className={cn(
                            'rounded-lg px-2 py-0.5 text-[11px] font-medium',
                            canvasZoom === z
                              ? 'bg-indigo-500 text-white'
                              : 'opacity-70 hover:opacity-100'
                          )}
                        >
                          {z}%
                        </button>
                      ))}
                    </div>
                  </div>

                  <div
                    className="flex-1 overflow-auto p-6 pt-16"
                    style={{
                      backgroundImage: darkShell
                        ? 'radial-gradient(rgba(255,255,255,0.10) 1px, transparent 1px)'
                        : 'radial-gradient(rgba(0,0,0,0.10) 1px, transparent 1px)',
                      backgroundSize: '20px 20px',
                    }}
                  >
                    <div
                      className="grid grid-cols-1 gap-4 md:grid-cols-2 xl:grid-cols-3"
                      style={{
                        transform: `scale(${canvasZoom / 100})`,
                        transformOrigin: 'top left',
                      }}
                    >
                      {openItems.map((node) => (
                        <div
                          key={node.id}
                          onClick={() => setActiveTabId(node.id)}
                          className={cn(
                            'flex h-80 flex-col overflow-hidden rounded-2xl border shadow-md transition-all cursor-pointer',
                            activeItem?.id === node.id
                              ? 'ring-2 ring-blue-500 border-transparent'
                              : darkShell
                                ? 'border-white/10 bg-[#1E222B]/95 hover:border-white/20'
                                : 'border-zinc-200/80 bg-white/95 hover:border-zinc-300'
                          )}
                        >
                          <div
                            className={cn(
                              'flex items-center justify-between border-b px-3 py-2 text-xs',
                              darkShell
                                ? 'border-white/8 bg-white/[0.02]'
                                : 'border-zinc-100 bg-zinc-50/70'
                            )}
                          >
                            <div className="flex items-center gap-1.5 font-semibold truncate">
                              <SurfaceKindIcon kind={node.kind} />
                              <span className="truncate">{node.title}</span>
                            </div>
                            <div className="flex items-center gap-1">
                              {node.worktreeBranch && (
                                <span className="rounded bg-purple-500/15 px-1.5 py-0.2 font-mono text-[10px] text-purple-500">
                                  {node.worktreeBranch}
                                </span>
                              )}
                              <button
                                type="button"
                                onClick={(e) => {
                                  e.stopPropagation();
                                  setActiveTabId(node.id);
                                  setBStageMode('tabs');
                                }}
                                className="rounded p-1 opacity-60 hover:bg-black/5 hover:opacity-100"
                                title="切回自由标签最大化查看"
                              >
                                <Maximize2 className="h-3 w-3" />
                              </button>
                            </div>
                          </div>
                          <div className="flex-1 overflow-hidden text-xs">
                            <StageSurfaceView
                              item={node}
                              darkShell={darkShell}
                              project={currentProject}
                              host={currentHost}
                              compact
                            />
                          </div>
                        </div>
                      ))}
                    </div>
                  </div>
                </div>
              )
            ) : (
              /* ---------------------------------------------------------------
                 模式二：看板全面化 (Dashboard Mode)
                 - 左侧边栏按钮直接切换：计量统计 / 仓库面板 / 任务面板
                 - A区少一个二级左侧栏，B区全宽显示当前选中的看板面板
                 --------------------------------------------------------------- */
              <div className="flex h-full flex-col overflow-hidden">
                <div
                  className={cn(
                    'flex h-12 shrink-0 items-center justify-between border-b px-6',
                    darkShell ? 'border-white/[0.07]' : 'border-zinc-100'
                  )}
                >
                  <div className="flex items-center gap-3">
                    <h2 className="text-sm font-semibold">
                      {currentProject.name} ·{' '}
                      {dashboardSection === 'metrics'
                        ? '计量统计面板'
                        : dashboardSection === 'repositories'
                          ? '仓库与会话 Worktree 池面板'
                          : '任务面板'}
                    </h2>
                    <span className="rounded-full bg-emerald-500/15 px-2.5 py-0.5 text-[11px] font-medium text-emerald-600 dark:text-emerald-400">
                      由左侧边栏图标直接切换 · A区无二级左栏
                    </span>
                  </div>
                </div>

                <div className="flex-1 overflow-y-auto p-6">
                  {dashboardSection === 'tasks' && (
                    <div className="grid grid-cols-1 gap-4 md:grid-cols-4">
                      {[
                        {
                          col: '待规划 (Backlog)',
                          count: 2,
                          items: [
                            {
                              title:
                                '支持远程 Host SSH 免密一键部署 Agent 守护进程',
                              bot: '@Rust后端专家',
                              wt: '待创建会话自动分配',
                              tag: 'Host架构',
                            },
                            {
                              title: '看板仓库面板支持 Submodule 批量拉取',
                              bot: '@系统架构师',
                              wt: '待创建会话自动分配',
                              tag: '仓库面板',
                            },
                          ],
                        },
                        {
                          col: '执行中 (In Progress)',
                          count: 2,
                          items: [
                            {
                              title: 'A/B 区 Shell Nav 合并与去分割线视觉重构',
                              bot: '@UI设计师',
                              wt: 'wt/feat-shell-nav (会话内置)',
                              tag: 'UI重构',
                            },
                            {
                              title: '移除页面级 Worktree 切换，改为会话内置属性',
                              bot: '@系统架构师',
                              wt: 'wt/session-worktree (会话内置)',
                              tag: '核心模型',
                            },
                          ],
                        },
                        {
                          col: '评审中 (In Review)',
                          count: 1,
                          items: [
                            {
                              title: '归并独立协作空间 Tab 至工作区左侧 Bot 面板',
                              bot: '#Shell重构攻坚群',
                              wt: 'wt/merge-collab-tab (会话内置)',
                              tag: '导航收敛',
                            },
                          ],
                        },
                        {
                          col: '已完成 (Done)',
                          count: 2,
                          items: [
                            {
                              title:
                                'Win11 任务栏图标 AppUserModelID 动态哈希破除缓存',
                              bot: '@UI设计师',
                              wt: '已合并回 main 并清理 Worktree',
                              tag: '桌面端',
                            },
                            {
                              title: 'VibeX 彩色全息光感全套图标 SVG/PNG 规范化',
                              bot: '@UI设计师',
                              wt: '已合并回 main',
                              tag: '品牌视觉',
                            },
                          ],
                        },
                      ].map((lane) => (
                        <div
                          key={lane.col}
                          className={cn(
                            'flex flex-col rounded-2xl p-3.5',
                            darkShell ? 'bg-white/[0.03]' : 'bg-zinc-50/90'
                          )}
                        >
                          <div className="mb-3 flex items-center justify-between px-1">
                            <span className="text-xs font-semibold">
                              {lane.col}
                            </span>
                            <span className="rounded-full bg-black/8 dark:bg-white/10 px-2 py-0.5 text-[11px] font-medium tabular-nums">
                              {lane.count}
                            </span>
                          </div>
                          <div className="space-y-2.5">
                            {lane.items.map((card) => (
                              <div
                                key={card.title}
                                onClick={() => {
                                  setTopMode('workspace');
                                  setActiveTabId('session-shell-nav');
                                }}
                                className={cn(
                                  'cursor-pointer rounded-xl border p-3 shadow-2xs transition-all hover:-translate-y-0.5',
                                  darkShell
                                    ? 'border-white/8 bg-[#1E222B] hover:border-blue-500/40'
                                    : 'border-zinc-200/70 bg-white hover:border-blue-400'
                                )}
                              >
                                <div className="flex items-center justify-between text-[10px]">
                                  <span className="rounded bg-blue-500/15 px-1.5 py-0.5 font-medium text-blue-500">
                                    {card.tag}
                                  </span>
                                  <span className="text-emerald-500 font-medium">
                                    {card.bot}
                                  </span>
                                </div>
                                <div className="mt-2 text-xs font-medium leading-snug">
                                  {card.title}
                                </div>
                                <div className="mt-2.5 flex items-center gap-1 font-mono text-[10px] opacity-60">
                                  <GitBranch className="h-3 w-3 text-purple-500" />
                                  <span className="truncate">{card.wt}</span>
                                </div>
                              </div>
                            ))}
                          </div>
                        </div>
                      ))}
                    </div>
                  )}

                  {dashboardSection === 'repositories' && (
                    <div className="space-y-5">
                      <div className="grid grid-cols-1 gap-4 md:grid-cols-3">
                        <div
                          className={cn(
                            'rounded-2xl border p-4',
                            darkShell
                              ? 'border-white/10 bg-white/[0.02]'
                              : 'border-zinc-200/80 bg-zinc-50/50'
                          )}
                        >
                          <div className="flex items-center justify-between">
                            <span className="text-xs font-semibold opacity-70">
                              项目主目录状态（页面固定环境）
                            </span>
                            <FolderGit2 className="h-4 w-4 text-blue-500" />
                          </div>
                          <div className="mt-2 font-mono text-sm font-semibold">
                            {currentProject.rootPath}
                          </div>
                          <div className="mt-1 text-xs opacity-65">
                            基准分支：{currentProject.defaultBranch} · 页面环境永不偏离主目录
                          </div>
                        </div>

                        <div
                          className={cn(
                            'rounded-2xl border p-4',
                            darkShell
                              ? 'border-white/10 bg-white/[0.02]'
                              : 'border-zinc-200/80 bg-zinc-50/50'
                          )}
                        >
                          <div className="flex items-center justify-between">
                            <span className="text-xs font-semibold opacity-70">
                              会话内置 Worktree 活跃池
                            </span>
                            <GitBranch className="h-4 w-4 text-purple-500" />
                          </div>
                          <div className="mt-2 text-2xl font-bold tabular-nums">
                            3 个挂载中
                          </div>
                          <div className="mt-1 text-xs opacity-65">
                            每个并发会话自动维护独立 Worktree，结束后自动归并回收
                          </div>
                        </div>

                        <div
                          className={cn(
                            'rounded-2xl border p-4',
                            darkShell
                              ? 'border-white/10 bg-white/[0.02]'
                              : 'border-zinc-200/80 bg-zinc-50/50'
                          )}
                        >
                          <div className="flex items-center justify-between">
                            <span className="text-xs font-semibold opacity-70">
                              待合并会话分支
                            </span>
                            <GitPullRequest className="h-4 w-4 text-emerald-500" />
                          </div>
                          <div className="mt-2 text-2xl font-bold tabular-nums">
                            2 个可合入 main
                          </div>
                          <div className="mt-1 text-xs text-emerald-500">
                            无冲突 · 支持一键 Squash Merge 回项目主目录
                          </div>
                        </div>
                      </div>

                      <div
                        className={cn(
                          'rounded-2xl border overflow-hidden',
                          darkShell ? 'border-white/10' : 'border-zinc-200/80'
                        )}
                      >
                        <div
                          className={cn(
                            'flex items-center justify-between border-b px-4 py-3 text-xs font-semibold',
                            darkShell
                              ? 'border-white/10 bg-white/[0.03]'
                              : 'border-zinc-200/80 bg-zinc-50'
                          )}
                        >
                          <span>
                            会话内置 Worktree 托管列表（与具体 Conversation 强绑定）
                          </span>
                          <span className="text-[11px] font-normal opacity-65">
                            不再支持将整个页面切换到某个 Worktree
                          </span>
                        </div>
                        <div className="divide-y divide-zinc-100 dark:divide-white/8 text-xs">
                          {[
                            {
                              branch: 'wt/feat-shell-nav',
                              session: '实现 A/B 区 Shell Nav 合并布局',
                              bot: '@UI设计师',
                              changes: '+182 -44',
                              state: '会话进行中',
                            },
                            {
                              branch: 'wt/multi-host-rpc',
                              session: '重构 Host -> Project 多节点 RPC 路由',
                              bot: '@系统架构师',
                              changes: '+310 -89',
                              state: '可合入主目录',
                            },
                            {
                              branch: 'wt/rust-taskbar-ico',
                              session: '修复 Win11 任务栏图标缓存',
                              bot: '@Rust后端专家',
                              changes: '+95 -12',
                              state: '已合入 · 待清理目录',
                            },
                          ].map((row) => (
                            <div
                              key={row.branch}
                              className="flex items-center justify-between px-4 py-3"
                            >
                              <div className="flex items-center gap-3">
                                <span className="rounded-md bg-purple-500/15 px-2 py-1 font-mono text-[11px] font-medium text-purple-500">
                                  {row.branch}
                                </span>
                                <div>
                                  <div className="font-medium">
                                    {row.session}
                                  </div>
                                  <div className="text-[11px] opacity-60">
                                    绑定执行者：{row.bot}
                                  </div>
                                </div>
                              </div>
                              <div className="flex items-center gap-4 tabular-nums">
                                <span className="font-mono text-emerald-500">
                                  {row.changes}
                                </span>
                                <span className="rounded-full bg-black/5 dark:bg-white/10 px-2.5 py-0.5 text-[11px]">
                                  {row.state}
                                </span>
                                <button
                                  type="button"
                                  onClick={() => {
                                    setTopMode('workspace');
                                    setActiveTabId('session-shell-nav');
                                  }}
                                  className="rounded-lg bg-blue-500 px-2.5 py-1 text-[11px] font-medium text-white hover:bg-blue-600"
                                >
                                  查看绑定会话
                                </button>
                              </div>
                            </div>
                          ))}
                        </div>
                      </div>
                    </div>
                  )}

                  {dashboardSection === 'metrics' && (
                    <div className="space-y-5 tabular-nums">
                      <div className="grid grid-cols-1 gap-4 md:grid-cols-4">
                        {[
                          {
                            label: '今日总 Token 消耗 (全 Host)',
                            val: '4,820,910',
                            delta: '+18.4% 较昨日',
                          },
                          {
                            label: '当前活跃 Bot 并发数',
                            val: '14 Agents',
                            delta: '分布在 3 台 Host',
                          },
                          {
                            label: '平均单回合响应耗时',
                            val: '6.8 s',
                            delta: '-1.2s 提速',
                          },
                          {
                            label: '今日预估模型算力成本',
                            val: '$19.42',
                            delta: '缓存命中率 87.3%',
                          },
                        ].map((m) => (
                          <div
                            key={m.label}
                            className={cn(
                              'rounded-2xl border p-4',
                              darkShell
                                ? 'border-white/10 bg-white/[0.02]'
                                : 'border-zinc-200/80 bg-zinc-50/50'
                            )}
                          >
                            <div className="text-xs opacity-65">{m.label}</div>
                            <div className="mt-2 text-2xl font-bold">
                              {m.val}
                            </div>
                            <div className="mt-1 text-[11px] text-emerald-500">
                              {m.delta}
                            </div>
                          </div>
                        ))}
                      </div>

                      <div
                        className={cn(
                          'rounded-2xl border p-4',
                          darkShell ? 'border-white/10' : 'border-zinc-200/80'
                        )}
                      >
                        <div className="mb-3 text-xs font-semibold">
                          各 Host 节点实时资源与 Token 计量分布
                        </div>
                        <div className="space-y-3 text-xs">
                          {HOSTS.map((h) => (
                            <div
                              key={h.id}
                              className="flex items-center justify-between rounded-xl bg-black/[0.03] dark:bg-white/[0.03] p-3"
                            >
                              <div>
                                <div className="font-semibold">{h.name}</div>
                                <div className="text-[11px] opacity-60">
                                  {h.address}
                                </div>
                              </div>
                              <div className="flex items-center gap-6">
                                <div>
                                  <div className="opacity-60 text-[10px]">
                                    CPU 水位
                                  </div>
                                  <div className="font-semibold">
                                    {h.cpuLoad}%
                                  </div>
                                </div>
                                <div>
                                  <div className="opacity-60 text-[10px]">
                                    内存占用
                                  </div>
                                  <div className="font-semibold">
                                    {h.memUsedGb}
                                  </div>
                                </div>
                                <div>
                                  <div className="opacity-60 text-[10px]">
                                    运行中 Agent
                                  </div>
                                  <div className="font-semibold text-blue-500">
                                    {h.activeAgents} 个
                                  </div>
                                </div>
                              </div>
                            </div>
                          ))}
                        </div>
                      </div>
                    </div>
                  )}
                </div>
              </div>
            )}
          </main>
        </div>

        {/* ===================================================================
            A区 · 底部一体式状态栏 (Bottom Shell Status Bar)
            左下角放置：Project 项目选择器（固定绑定项目主目录，不随 Worktree 切换）
           =================================================================== */}
        <footer className="relative z-30 flex h-8 shrink-0 items-center justify-between px-3 text-[11px] tabular-nums">
          <div className="flex items-center gap-2.5">
            {/* 左下角：Project 选择器（向上弹出项目列表，复用项目栏状态） */}
            <div className="relative">
              <button
                type="button"
                onClick={() => {
                  setProjectMenuOpen((v) => !v);
                  setHostMenuOpen(false);
                }}
                data-testid="project-selector-trigger"
                className={cn(
                  'flex h-6 items-center gap-1.5 rounded-lg px-2.5 text-xs font-medium transition-all',
                  darkShell
                    ? 'bg-white/[0.08] hover:bg-white/[0.14] text-zinc-100'
                    : 'bg-black/[0.06] hover:bg-black/[0.1] text-zinc-800'
                )}
              >
                <FolderOpen className="h-3.5 w-3.5 text-amber-500" />
                <span className="font-semibold">{currentProject.name}</span>
                <span
                  className={cn(
                    'hidden md:inline-flex items-center gap-1 rounded px-1.5 py-0.2 text-[10px] font-normal',
                    darkShell
                      ? 'bg-white/[0.06] text-zinc-400'
                      : 'bg-black/[0.05] text-zinc-500'
                  )}
                  title="项目页面环境固定在项目主目录，不再随 Worktree 切换"
                >
                  主目录固定 · {currentProject.defaultBranch}
                </span>
                <ChevronDown className="h-3 w-3 rotate-180 opacity-60" />
              </button>

              {projectMenuOpen && (
                <div
                  className={cn(
                    'absolute bottom-8 left-0 z-50 w-96 rounded-xl p-1.5 shadow-2xl ring-1',
                    darkShell
                      ? 'bg-[#1A1D24] ring-white/10 text-zinc-100'
                      : 'bg-white ring-black/10 text-zinc-800'
                  )}
                >
                  <div className="flex items-center justify-between px-2.5 py-1.5 text-[11px] font-medium opacity-60">
                    <span>{currentHost.name} 下的项目（复用项目栏状态）</span>
                    <span>无页面级 Worktree 切换</span>
                  </div>
                  {PROJECTS.map((proj) => {
                    const isCurrent = proj.id === currentProject.id;
                    const hostObj = HOSTS.find((h) => h.id === proj.hostId);
                    return (
                      <button
                        key={proj.id}
                        type="button"
                        onClick={() => {
                          setSelectedHostId(proj.hostId);
                          setSelectedProjectId(proj.id);
                          setProjectMenuOpen(false);
                        }}
                        className={cn(
                          'flex w-full items-center justify-between rounded-lg px-2.5 py-2 text-left text-xs transition-colors',
                          isCurrent
                            ? darkShell
                              ? 'bg-white/10'
                              : 'bg-zinc-100 font-medium'
                            : darkShell
                              ? 'hover:bg-white/5'
                              : 'hover:bg-zinc-50'
                        )}
                      >
                        <div className="min-w-0 pr-2">
                          <div className="flex items-center gap-1.5">
                            <span
                              className={cn(
                                'h-2 w-2 rounded-full',
                                proj.runningSessions > 0
                                  ? 'bg-blue-500 animate-pulse'
                                  : 'bg-zinc-400'
                              )}
                            />
                            <span className="truncate font-semibold">
                              {proj.name}
                            </span>
                            <span className="rounded bg-black/5 dark:bg-white/10 px-1.5 py-0.2 text-[10px] opacity-75">
                              {hostObj?.name.split(' ')[0]}
                            </span>
                          </div>
                          <div className="mt-0.5 truncate font-mono text-[10px] opacity-55">
                            {proj.rootPath}
                          </div>
                        </div>
                        <div className="shrink-0 text-right text-[11px] tabular-nums">
                          <span className="inline-flex items-center gap-1 text-blue-500">
                            {proj.runningSessions} 活跃会话
                          </span>
                          {proj.unreadBots > 0 && (
                            <div className="text-[10px] text-amber-500">
                              {proj.unreadBots} Bot 未读
                            </div>
                          )}
                        </div>
                      </button>
                    );
                  })}
                </div>
              )}
            </div>

            <span className="opacity-40">·</span>
            <span className="font-mono opacity-70">
              {currentProject.rootPath}
            </span>
            <span className="opacity-40">·</span>
            <span className="flex items-center gap-1 font-medium text-emerald-600 dark:text-emerald-400">
              <Wifi className="h-3 w-3" />
              Host: {currentHost.name} ({currentHost.latencyMs}ms)
            </span>
            <span className="opacity-40">·</span>
            <span className="opacity-70">
              当前模式:{' '}
              {topMode === 'workspace'
                ? `工作区 (${bStageMode === 'tabs' ? '自由标签' : '无限画布'})`
                : `看板 (${
                    dashboardSection === 'metrics'
                      ? '计量统计'
                      : dashboardSection === 'repositories'
                        ? '仓库面板'
                        : '任务面板'
                  })`}
            </span>
          </div>

          <div className="flex items-center gap-3 opacity-75">
            <span>活跃 Bot: 4</span>
            <span>·</span>
            <span>后台进程: 2</span>
            <span>·</span>
            <span>MCP: 4 servers ready</span>
          </div>
        </footer>

        {/* ===================================================================
            设置 → 外观 (Settings · Appearance) 弹窗
            用于调整工作区 B 区表现形式（自由标签 vs 无限画布）及 A区 Shell 主题
           =================================================================== */}
        {settingsOpen && (
          <div
            className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 backdrop-blur-xs"
            onClick={() => setSettingsOpen(false)}
          >
            <div
              onClick={(e) => e.stopPropagation()}
              style={{
                backgroundColor: darkShell ? '#181B22' : '#FFFFFF',
              }}
              className={cn(
                'flex w-[620px] overflow-hidden rounded-2xl shadow-2xl ring-1',
                darkShell
                  ? 'text-zinc-100 ring-white/12'
                  : 'text-zinc-900 ring-black/10'
              )}
            >
              {/* 设置左侧分类栏 */}
              <div
                style={{
                  backgroundColor: darkShell ? '#12151B' : '#F4F4F6',
                }}
                className="flex w-44 shrink-0 flex-col justify-between p-3 text-xs"
              >
                <div className="space-y-1">
                  <div className="px-2 py-1.5 text-[11px] font-semibold opacity-55">
                    VibeX 设置
                  </div>
                  <button
                    type="button"
                    className={cn(
                      'flex w-full items-center gap-2 rounded-xl px-2.5 py-2 font-medium',
                      darkShell
                        ? 'bg-white/12 text-white'
                        : 'bg-white text-zinc-900 shadow-2xs'
                    )}
                  >
                    <Palette className="h-3.5 w-3.5 text-indigo-500" />
                    <span>外观 (Appearance)</span>
                  </button>
                  <button
                    type="button"
                    className="flex w-full items-center gap-2 rounded-xl px-2.5 py-2 opacity-60"
                  >
                    <Server className="h-3.5 w-3.5" />
                    <span>Host 节点管理</span>
                  </button>
                  <button
                    type="button"
                    className="flex w-full items-center gap-2 rounded-xl px-2.5 py-2 opacity-60"
                  >
                    <Bot className="h-3.5 w-3.5" />
                    <span>Agent 与模型</span>
                  </button>
                </div>
                <div className="px-2 text-[10px] opacity-50">
                  修改立即实时生效
                </div>
              </div>

              {/* 设置右侧：外观配置 */}
              <div className="flex-1 p-5 text-xs">
                <div className="flex items-center justify-between border-b pb-3 dark:border-white/10">
                  <div>
                    <div className="text-sm font-semibold">外观设置</div>
                    <div className="mt-0.5 text-[11px] opacity-65">
                      配置工作区 B 区主舞台的表现形式与 A 区 Shell 外壳主题
                    </div>
                  </div>
                  <button
                    type="button"
                    data-testid="close-settings-modal"
                    onClick={() => setSettingsOpen(false)}
                    className="rounded-lg p-1 opacity-60 hover:bg-black/5 hover:opacity-100"
                  >
                    <X className="h-4 w-4" />
                  </button>
                </div>

                {/* 1. 工作区 B 区表现形式：自由标签 vs 无限画布 */}
                <div className="mt-4">
                  <div className="font-semibold">
                    工作区 B 区主舞台表现形式
                  </div>
                  <div className="mt-0.5 text-[11px] opacity-65">
                    控制 BotSpace、GroupSpace、会话、终端、文件在 B 区的组织方式
                  </div>

                  <div className="mt-2.5 grid grid-cols-2 gap-3">
                    <button
                      type="button"
                      data-testid="settings-b-mode-tabs"
                      onClick={() => setBStageMode('tabs')}
                      className={cn(
                        'flex flex-col items-start rounded-xl border p-3 text-left transition-all',
                        bStageMode === 'tabs'
                          ? 'border-blue-500 bg-blue-500/[0.06] ring-2 ring-blue-500/30'
                          : darkShell
                            ? 'border-white/10 hover:border-white/20'
                            : 'border-zinc-200 hover:border-zinc-300'
                      )}
                    >
                      <div className="flex items-center gap-1.5 font-semibold">
                        <AppWindow className="h-4 w-4 text-blue-500" />
                        <span>自由标签 (Free Tabs)</span>
                      </div>
                      <p className="mt-1 text-[11px] leading-relaxed opacity-70">
                        顶部圆润胶囊标签栏 + 左右并排分屏，适合专注编码与对照对话。
                      </p>
                    </button>

                    <button
                      type="button"
                      data-testid="settings-b-mode-canvas"
                      onClick={() => setBStageMode('canvas')}
                      className={cn(
                        'flex flex-col items-start rounded-xl border p-3 text-left transition-all',
                        bStageMode === 'canvas'
                          ? 'border-indigo-500 bg-indigo-500/[0.06] ring-2 ring-indigo-500/30'
                          : darkShell
                            ? 'border-white/10 hover:border-white/20'
                            : 'border-zinc-200 hover:border-zinc-300'
                      )}
                    >
                      <div className="flex items-center gap-1.5 font-semibold">
                        <LayoutGrid className="h-4 w-4 text-indigo-500" />
                        <span>无限画布 (Infinite Canvas)</span>
                      </div>
                      <p className="mt-1 text-[11px] leading-relaxed opacity-70">
                        在二维点阵画布中平铺所有已打开的群空间、Bot、会话与终端节点。
                      </p>
                    </button>
                  </div>
                </div>

                {/* 2. A 区 Shell 外壳配色 */}
                <div className="mt-5">
                  <div className="font-semibold">A 区 Shell Nav 主题模式</div>
                  <div className="mt-2 grid grid-cols-2 gap-3">
                    <button
                      type="button"
                      onClick={() => setDarkShell(false)}
                      className={cn(
                        'flex items-center gap-2 rounded-xl border p-2.5 text-left transition-all',
                        !darkShell
                          ? 'border-blue-500 bg-blue-500/[0.06] font-medium'
                          : 'border-white/10 opacity-75'
                      )}
                    >
                      <Sun className="h-4 w-4 text-amber-500" />
                      <span>浅色一体灰 + 纯白 B 区</span>
                    </button>
                    <button
                      type="button"
                      onClick={() => setDarkShell(true)}
                      className={cn(
                        'flex items-center gap-2 rounded-xl border p-2.5 text-left transition-all',
                        darkShell
                          ? 'border-blue-500 bg-blue-500/[0.06] font-medium'
                          : 'border-zinc-200 opacity-75'
                      )}
                    >
                      <Moon className="h-4 w-4 text-indigo-400" />
                      <span>深空一体黑 + 暗色 B 区</span>
                    </button>
                  </div>
                </div>
              </div>
            </div>
          </div>
        )}
      </div>
    </div>
  );
}

function SurfaceKindIcon({ kind }: { kind: SurfaceKind }) {
  switch (kind) {
    case 'group-space':
      return <Users className="h-3.5 w-3.5 shrink-0 text-indigo-500" />;
    case 'bot-space':
      return <Bot className="h-3.5 w-3.5 shrink-0 text-emerald-500" />;
    case 'session':
      return <MessagesSquare className="h-3.5 w-3.5 shrink-0 text-blue-500" />;
    case 'code':
      return <FileCode2 className="h-3.5 w-3.5 shrink-0 text-amber-500" />;
    case 'terminal':
      return <Terminal className="h-3.5 w-3.5 shrink-0 text-purple-500" />;
    case 'browser':
      return <Globe className="h-3.5 w-3.5 shrink-0 text-cyan-500" />;
    case 'process':
      return <Activity className="h-3.5 w-3.5 shrink-0 text-rose-500" />;
  }
}

function StageSurfaceView({
  item,
  darkShell,
  project,
  host,
  compact = false,
}: {
  item: StageTabItem;
  darkShell: boolean;
  project: ProjectItem;
  host: HostItem;
  compact?: boolean;
}) {
  if (item.kind === 'group-space' || item.kind === 'bot-space') {
    const isGroup = item.kind === 'group-space';
    return (
      <div className="flex h-full flex-col justify-between p-4">
        <div className="space-y-3 overflow-y-auto">
          <div
            className={cn(
              'flex items-center justify-between rounded-xl p-3 text-xs',
              darkShell ? 'bg-white/[0.04]' : 'bg-zinc-50'
            )}
          >
            <div>
              <div className="flex items-center gap-2 font-semibold">
                <SurfaceKindIcon kind={item.kind} />
                <span>{item.title}</span>
                <span className="rounded bg-indigo-500/15 px-1.5 py-0.5 text-[10px] font-medium text-indigo-500">
                  原「协作空间」已无缝融入 B 区主舞台
                </span>
              </div>
              <div className="mt-0.5 text-[11px] opacity-65">
                {item.subtitle} · 可与右侧代码、终端或会话并排分屏
              </div>
            </div>
          </div>

          <div className="space-y-2.5 text-xs">
            <div
              className={cn(
                'rounded-xl p-3',
                darkShell ? 'bg-white/[0.03]' : 'bg-zinc-50/80'
              )}
            >
              <div className="flex items-center justify-between text-[11px] opacity-60">
                <span className="font-semibold text-blue-500">Person (你)</span>
                <span>23:36</span>
              </div>
              <p className="mt-1 leading-relaxed">
                在看板中，左侧边栏的按钮应该改为计量统计、仓库面板、任务面板；在工作区的自由标签和无限画布应该是通过设置-外观进行调整的。
              </p>
            </div>

            <div
              className={cn(
                'rounded-xl border p-3',
                darkShell
                  ? 'border-emerald-500/20 bg-emerald-500/[0.05]'
                  : 'border-emerald-500/20 bg-emerald-50/40'
              )}
            >
              <div className="flex items-center justify-between text-[11px]">
                <span className="font-semibold text-emerald-600 dark:text-emerald-400">
                  @UI设计师
                </span>
                <span className="opacity-60">刚刚</span>
              </div>
              <p className="mt-1 leading-relaxed">
                已同步更新！现在切换到顶部「看板」时，左侧窄边栏会自动切换为{' '}
                <strong>计量统计、仓库面板、任务面板</strong> 三个入口；工作区 B 区的{' '}
                <strong>自由标签 / 无限画布</strong> 则收进了左下角（及顶栏右侧）的{' '}
                <strong>设置 → 外观</strong> 面板中。
              </p>
            </div>

            {isGroup && !compact && (
              <div
                className={cn(
                  'rounded-xl border p-3',
                  darkShell
                    ? 'border-indigo-500/20 bg-indigo-500/[0.05]'
                    : 'border-indigo-500/20 bg-indigo-50/40'
                )}
              >
                <div className="flex items-center justify-between text-[11px]">
                  <span className="font-semibold text-indigo-500">
                    @系统架构师
                  </span>
                  <span className="opacity-60">刚刚</span>
                </div>
                <p className="mt-1 leading-relaxed">
                  这样顶栏彻底干净了！用户的布局习惯（偏好自由标签还是无限画布）属于低频外观偏好，放在「设置 → 外观」里非常合理。
                </p>
              </div>
            )}
          </div>
        </div>

        {!compact && (
          <div
            className={cn(
              'mt-3 flex items-center gap-2 rounded-xl border px-3 py-2',
              darkShell
                ? 'border-white/10 bg-white/[0.03]'
                : 'border-zinc-200 bg-zinc-50/50'
            )}
          >
            <input
              type="text"
              readOnly
              placeholder={`在 ${item.title} 中发送消息或 @Bot 派发任务...`}
              className="w-full bg-transparent text-xs outline-none"
            />
            <button
              type="button"
              className="flex h-7 w-7 items-center justify-center rounded-lg bg-blue-500 text-white"
            >
              <Send className="h-3.5 w-3.5" />
            </button>
          </div>
        )}
      </div>
    );
  }

  if (item.kind === 'session') {
    return (
      <div className="flex h-full flex-col justify-between p-4">
        <div className="space-y-3 overflow-y-auto">
          <div
            className={cn(
              'flex flex-wrap items-center justify-between gap-2 rounded-xl border p-3 text-xs',
              darkShell
                ? 'border-purple-500/30 bg-purple-500/10'
                : 'border-purple-200 bg-purple-50/70'
            )}
          >
            <div className="flex items-center gap-2">
              <GitBranch className="h-4 w-4 text-purple-500" />
              <div>
                <div className="font-semibold">
                  会话内置 Worktree 隔离环境：
                  <span className="ml-1 font-mono text-purple-600 dark:text-purple-300">
                    {item.worktreeBranch ?? 'wt/feat-shell-nav'}
                  </span>
                </div>
                <div className="text-[11px] opacity-75">
                  挂载路径：<code>{item.worktreePath}</code> · 不影响项目全局主目录 ({project.rootPath})
                </div>
              </div>
            </div>
            <span className="rounded-md bg-purple-500 px-2 py-1 text-[10px] font-medium text-white">
              合并回主目录
            </span>
          </div>

          <div className="space-y-2 text-xs">
            <div
              className={cn(
                'rounded-xl p-3',
                darkShell ? 'bg-white/[0.03]' : 'bg-zinc-50'
              )}
            >
              <div className="font-semibold text-blue-500">执行轨迹 · Step 1</div>
              <div className="mt-1 opacity-80">
                已在当前会话专属 Worktree 中更新 <code>AppShell.tsx</code> 与{' '}
                <code>HostProjectSelector.tsx</code>，主窗口环境保持在项目根目录不变。
              </div>
            </div>
            <div
              className={cn(
                'rounded-xl p-3 font-mono text-[11px]',
                darkShell
                  ? 'bg-black/40 text-emerald-400'
                  : 'bg-zinc-900 text-emerald-400'
              )}
            >
              <div>$ git worktree list</div>
              <div className="opacity-80">
                {project.rootPath} [main] (页面固定主环境)
              </div>
              <div className="text-purple-300">
                {item.worktreePath} [{item.worktreeBranch}] (当前会话内置绑定)
              </div>
            </div>
          </div>
        </div>
      </div>
    );
  }

  if (item.kind === 'code') {
    return (
      <div className="flex h-full flex-col p-4 font-mono text-xs">
        <div className="mb-2 flex items-center justify-between text-[11px] opacity-60 font-sans">
          <span>{item.subtitle}</span>
          <span>固定读取自项目主目录或聚焦会话 Diff</span>
        </div>
        <div
          className={cn(
            'flex-1 overflow-auto rounded-xl p-3.5 leading-relaxed',
            darkShell ? 'bg-black/35 text-zinc-200' : 'bg-zinc-50 text-zinc-800'
          )}
        >
          <div className="text-zinc-400">
            // A区 (Shell Nav) 与 B区 (Inset Stage) 融合架构示例
          </div>
          <div>
            <span className="text-purple-500">export function</span>{' '}
            <span className="text-blue-500 font-semibold">
              VibeXUnifiedShell
            </span>
            () {'{'}
          </div>
          <div className="pl-4 text-emerald-600 dark:text-emerald-400">
            + // 左上角：Host 选择器 + Project 选择器（移除页面级 Worktree 切换）
          </div>
          <div className="pl-4">return (</div>
          <div className="pl-8">
            &lt;<span className="text-amber-600">ShellZoneA</span>{' '}
            background="unified-gray" border="none"&gt;
          </div>
          <div className="pl-12">
            &lt;<span className="text-amber-600">TopBar</span>{' '}
            left={'{<HostAndProjectPicker />}'}{' '}
            center={'{<WorkspaceOrDashboardTabs />}'} /&gt;
          </div>
          <div className="pl-12">
            &lt;<span className="text-amber-600">LeftRail</span>{' '}
            workspacePanels={'{["files", "git", "sessions", "bots"]}'}{' '}
            dashboardPanels={'{["metrics", "repositories", "tasks"]}'} /&gt;
          </div>
          <div className="pl-12">
            &lt;<span className="text-amber-600">InsetStageZoneB</span>{' '}
            appearanceMode={'{settings.appearance.stageMode}'} rounded="2xl" /&gt;
          </div>
          <div className="pl-8">
            &lt;/<span className="text-amber-600">ShellZoneA</span>&gt;
          </div>
          <div className="pl-4">);</div>
          <div>{'}'}</div>
        </div>
      </div>
    );
  }

  return (
    <div className="flex h-full flex-col p-4 text-xs">
      <div className="mb-2 flex items-center justify-between">
        <span className="font-semibold">{item.title}</span>
        <span className="rounded bg-emerald-500/15 px-2 py-0.5 text-[10px] text-emerald-500">
          Host: {host.name}
        </span>
      </div>
      <div
        className={cn(
          'flex-1 rounded-xl p-3 font-mono text-[11px] leading-relaxed',
          darkShell ? 'bg-black/40 text-zinc-300' : 'bg-zinc-900 text-zinc-200'
        )}
      >
        <div className="text-emerald-400">
          ➜ {project.name} ({project.rootPath})
        </div>
        <div className="mt-1 opacity-80">
          [Vite HMR] Ready at http://127.0.0.1:3000/prototype/unified-shell
        </div>
        <div className="mt-1 text-blue-300">
          [Host RPC] Connected to {host.name} ({host.latencyMs}ms)
        </div>
      </div>
    </div>
  );
}
