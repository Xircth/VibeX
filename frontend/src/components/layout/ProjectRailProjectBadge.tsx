import { cn } from '@/lib/utils';

interface ProjectRailProjectBadgeProps {
  name: string;
  active?: boolean;
}

export function getProjectRailMonogram(name: string): string {
  const words = name.trim().split(/\s+/).filter(Boolean);
  if (words.length > 1) {
    return [words[0], words.at(-1)]
      .map((word) => Array.from(word ?? '')[0] ?? '')
      .join('')
      .toLocaleUpperCase();
  }

  return Array.from(words[0] ?? '')
    .slice(0, 2)
    .join('')
    .toLocaleUpperCase();
}

/** Compact project identity for the floating workspace rail. */
export function ProjectRailProjectBadge({
  name,
  active = false,
}: ProjectRailProjectBadgeProps) {
  return (
    <span
      className={cn(
        'project-rail-project-badge',
        active && 'project-rail-project-badge--active'
      )}
      aria-hidden="true"
    >
      <span className="project-rail-project-badge__shine" />
      <span className="project-rail-project-badge__monogram">
        {getProjectRailMonogram(name)}
      </span>
    </span>
  );
}
