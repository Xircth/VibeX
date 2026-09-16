import { useCallback, useMemo } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import { useTranslation } from 'react-i18next';
import { AppWindow, FolderOpen } from 'lucide-react';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu';
import { Logo } from '@/components/Logo';
import { openLocalAppWindow } from '@/lib/api/appWindow';
import { paths } from '@/lib/paths';
import { useProjects } from '@/hooks/useProjects';
import { useProjectSwitcher } from '@/hooks/useProjectSwitcher';
import { useTauriClient } from '@/lib/desktopShell';

const RECENT_PROJECT_MENU_LIMIT = 6;

export function HomeLogoMenu({ align }: { align: 'start' | 'end' }) {
  const { t } = useTranslation(['panels', 'common']);
  const navigate = useNavigate();
  const { projects } = useProjects();
  const switchProject = useProjectSwitcher();
  const tauriClient = useTauriClient();
  const recentProjects = useMemo(
    () =>
      projects.slice(0, RECENT_PROJECT_MENU_LIMIT).map((project) => ({
        id: project.id,
        name: project.name,
      })),
    [projects]
  );

  const onOpenHome = useCallback(() => {
    navigate(paths.projects());
  }, [navigate]);

  const onSwitchProject = useCallback(
    (projectId: string) => {
      switchProject(projectId, paths.projectSessions(projectId));
    },
    [switchProject]
  );

  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <button
          type="button"
          className="workspace-toolbar-button flex h-9 w-9 shrink-0 items-center justify-center rounded-md p-0 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
          aria-label={t('toolbar.homeOrRecentProjects')}
          title={t('toolbar.homeOrRecentProjects')}
        >
          <Logo showText={false} size="toolbar" />
        </button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align={align}>
        {tauriClient ? (
          <>
            <DropdownMenuItem onSelect={() => openLocalAppWindow()}>
              <AppWindow className="mr-2 h-4 w-4" />
              {t('toolbar.newAppWindow')}
            </DropdownMenuItem>
            <DropdownMenuSeparator />
          </>
        ) : null}
        <DropdownMenuItem onSelect={onOpenHome}>
          <FolderOpen className="mr-2 h-4 w-4" />
          {t('toolbar.backToHome')}
        </DropdownMenuItem>
        <div className="px-2 py-1 text-[11px] text-muted-foreground">
          {t('toolbar.recentProjects')}
        </div>
        {recentProjects.length > 0 ? (
          recentProjects.map((item) => (
            <DropdownMenuItem
              key={item.id}
              onSelect={() => onSwitchProject(item.id)}
              title={item.name}
            >
              <FolderOpen className="mr-2 h-4 w-4" />
              <span className="truncate">{item.name}</span>
            </DropdownMenuItem>
          ))
        ) : (
          <DropdownMenuItem disabled>
            {t('toolbar.noRecentProjects')}
          </DropdownMenuItem>
        )}
        <DropdownMenuItem asChild>
          <Link to={paths.projects()}>
            <FolderOpen className="mr-2 h-4 w-4" />
            Projects
          </Link>
        </DropdownMenuItem>
      </DropdownMenuContent>
    </DropdownMenu>
  );
}
