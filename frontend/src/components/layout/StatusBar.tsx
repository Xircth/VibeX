import { useProject } from '@/contexts/ProjectContext';
import { APP_NAME } from '@/lib/branding';
import { GitBranch } from 'lucide-react';

export function StatusBar() {
  const { project } = useProject();

  return (
    <div className="h-6 bg-secondary flex items-center px-2 text-secondary-foreground text-[11px] shrink-0 select-none justify-between border-t border-border">
      <div className="flex items-center gap-3">
        {project && (
          <span className="flex items-center gap-1 opacity-90">
            <GitBranch className="h-3 w-3" />
            {project.name}
          </span>
        )}
      </div>
      <div className="flex items-center gap-3">
        <span className="opacity-70">{APP_NAME}</span>
      </div>
    </div>
  );
}
