import { FolderOpen, GitBranch } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import { useProjectRepos } from '@/hooks';
import { importedProjectName } from '@/lib/importedProject';

export function RecentProjectItem({
  project,
  depth,
  onClick,
  onContextMenu,
  showPath = true,
}: {
  project: {
    id: string;
    name: string;
    root_path?: string;
    is_git?: boolean;
    is_home?: boolean;
  };
  depth: number;
  onClick: () => void;
  onContextMenu: (event: React.MouseEvent<HTMLButtonElement>) => void;
  showPath?: boolean;
}) {
  const { t } = useTranslation(['app', 'common']);
  const { data: repos } = useProjectRepos(project.id);
  const repoPath = project.root_path || repos?.[0]?.path || '';
  const Icon = project.is_git ? GitBranch : FolderOpen;
  const name = importedProjectName(project, t);

  return (
    <button
      onClick={onClick}
      onContextMenu={onContextMenu}
      data-basic-guide={project.is_home ? 'welcome-global-project' : undefined}
      className="group flex w-full items-center gap-3 rounded px-2 py-1.5 text-left text-sm transition-colors hover:bg-muted/60"
      style={{ paddingLeft: `${8 + depth * 12}px` }}
      title={
        showPath
          ? t('welcomePage.recentProjectTooltip')
          : repoPath || t('welcomePage.recentProjectTooltip')
      }
    >
      <Icon className="h-3.5 w-3.5 shrink-0 text-muted-foreground" />
      <span className="truncate font-medium text-foreground transition-colors">
        {name}
      </span>
      {showPath && repoPath ? (
        <span className="flex-1 truncate text-right font-mono text-xs text-muted-foreground">
          {repoPath}
        </span>
      ) : null}
    </button>
  );
}

export function flattenProjectTree<
  T extends { id: string; parent_project_id?: string | null },
>(projects: T[]): Array<{ project: T; depth: number }> {
  const byParent = new Map<string | null, T[]>();
  for (const project of projects) {
    const parent = project.parent_project_id ?? null;
    const list = byParent.get(parent) ?? [];
    list.push(project);
    byParent.set(parent, list);
  }
  const result: Array<{ project: T; depth: number }> = [];
  const walk = (parentId: string | null, depth: number) => {
    for (const project of byParent.get(parentId) ?? []) {
      result.push({ project, depth });
      walk(project.id, depth + 1);
    }
  };
  walk(null, 0);
  const seen = new Set(result.map((entry) => entry.project.id));
  for (const project of projects) {
    if (!seen.has(project.id)) {
      result.push({ project, depth: 0 });
    }
  }
  return result;
}
