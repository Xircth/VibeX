import { memo, useMemo, useState } from 'react';
import {
  CircleDot,
  CheckCircle2,
  MessageSquare,
  ExternalLink,
  RefreshCw,
  Loader2,
  Github,
} from 'lucide-react';
import type { GitHubIssueInfo } from 'shared/types';
import { Button } from '@/components/ui/button';
import { getGitHostErrorPresentation } from '@/lib/gitHostUiErrors';
import { GitHubCliSetupModal } from './GitHubCliSetupModal';

interface GitIssuesViewProps {
  issues: GitHubIssueInfo[];
  isLoading: boolean;
  error: string | null;
  issueState: 'open' | 'closed' | 'all';
  onSetIssueState: (state: 'open' | 'closed' | 'all') => void;
  onRefresh: () => void;
}

function formatTimeAgo(dateStr: string): string {
  const date = new Date(dateStr);
  const now = new Date();
  const diffMs = now.getTime() - date.getTime();
  const diffDays = Math.floor(diffMs / (1000 * 60 * 60 * 24));

  if (diffDays === 0) return 'today';
  if (diffDays === 1) return 'yesterday';
  if (diffDays < 30) return `${diffDays}d ago`;
  if (diffDays < 365) return `${Math.floor(diffDays / 30)}mo ago`;
  return `${Math.floor(diffDays / 365)}y ago`;
}

function IssueRow({ issue }: { issue: GitHubIssueInfo }) {
  const isOpen = (issue.state ?? '').toUpperCase() === 'OPEN';
  const labels = issue.labels ?? [];

  return (
    <button
      className="w-full text-left px-2 py-1.5 hover:bg-accent/30 transition-colors group border-b border-border/10 last:border-b-0"
      onClick={() => window.open(issue.url, '_blank')}
    >
      <div className="flex items-start gap-1.5">
        {isOpen ? (
          <CircleDot className="h-3.5 w-3.5 text-[hsl(var(--success))] mt-0.5 shrink-0" />
        ) : (
          <CheckCircle2 className="h-3.5 w-3.5 text-[hsl(var(--status-running))] mt-0.5 shrink-0" />
        )}
        <div className="flex-1 min-w-0">
          <div className="flex items-center gap-1">
            <span className="text-xs text-foreground font-medium truncate">
              {issue.title}
            </span>
            <ExternalLink className="h-2.5 w-2.5 text-muted-foreground opacity-0 group-hover:opacity-100 shrink-0" />
          </div>
          <div className="flex items-center gap-2 mt-0.5">
            <span className="text-[10px] text-muted-foreground">
              #{String(issue.number)}
            </span>
            <span className="text-[10px] text-muted-foreground">
              {issue.author?.login ?? ''}
            </span>
            <span className="text-[10px] text-muted-foreground">
              {formatTimeAgo(issue.created_at)}
            </span>
            {Number(issue.comments_count) > 0 && (
              <span className="text-[10px] text-muted-foreground flex items-center gap-0.5">
                <MessageSquare className="h-2.5 w-2.5" />
                {String(issue.comments_count)}
              </span>
            )}
          </div>
          {labels.length > 0 && (
            <div className="flex flex-wrap gap-1 mt-1">
              {labels.map((label) => (
                <span
                  key={label.name}
                  className="text-[9px] px-1.5 py-0.5 rounded-full font-medium"
                  style={{
                    backgroundColor: `#${label.color}20`,
                    color: `#${label.color}`,
                    border: `1px solid #${label.color}40`,
                  }}
                >
                  {label.name}
                </span>
              ))}
            </div>
          )}
        </div>
      </div>
    </button>
  );
}

export const GitIssuesView = memo(function GitIssuesView({
  issues,
  isLoading,
  error,
  issueState,
  onSetIssueState,
  onRefresh,
}: GitIssuesViewProps) {
  const [setupModalOpen, setSetupModalOpen] = useState(false);
  const errorPresentation = useMemo(
    () => getGitHostErrorPresentation(error, 'Issues'),
    [error]
  );

  return (
    <div className="flex flex-col h-full min-h-0">
      {/* Filter bar */}
      <div className="flex items-center gap-1 px-2 py-1 border-b border-border/30 shrink-0">
        <div className="flex items-center gap-0.5 text-[10px]">
          {(['open', 'closed', 'all'] as const).map((s) => (
            <button
              key={s}
              className={`px-1.5 py-0.5 rounded transition-colors capitalize ${
                issueState === s
                  ? 'bg-accent text-foreground'
                  : 'text-muted-foreground hover:text-foreground'
              }`}
              onClick={() => onSetIssueState(s)}
            >
              {s}
            </button>
          ))}
        </div>
        <div className="flex-1" />
        <button
          type="button"
          className="p-1 rounded text-muted-foreground hover:text-foreground hover:bg-accent/50 transition-colors"
          onClick={() => setSetupModalOpen(true)}
          title="GitHub CLI 设置与登录"
        >
          <Github className="h-3 w-3" />
        </button>
        <button
          type="button"
          className="p-1 rounded text-muted-foreground hover:text-foreground hover:bg-accent/50 transition-colors disabled:opacity-40"
          onClick={onRefresh}
          disabled={isLoading}
          title="Refresh issues"
        >
          {isLoading ? (
            <Loader2 className="h-3 w-3 animate-spin" />
          ) : (
            <RefreshCw className="h-3 w-3" />
          )}
        </button>
      </div>

      {/* Content */}
      <div className="flex-1 overflow-y-auto min-h-0">
        {isLoading && issues.length === 0 ? (
          <div className="h-full flex items-center justify-center text-muted-foreground text-xs">
            <Loader2 className="h-4 w-4 animate-spin mr-1.5" />
            Loading issues...
          </div>
        ) : issues.length > 0 ? (
          issues.map((issue) => (
            <IssueRow key={Number(issue.number)} issue={issue} />
          ))
        ) : errorPresentation ? (
          <div className="h-full flex flex-col items-center justify-center px-4 text-center">
            <CircleDot className="h-7 w-7 text-muted-foreground/35 mb-2" />
            <p className="text-xs font-medium text-foreground">
              暂无可用 Issue
            </p>
            <p className="mt-1 text-[11px] text-muted-foreground leading-relaxed">
              {errorPresentation.requiresGhSetup
                ? '未检测到可用的 GitHub CLI (gh) 或尚未登录 GitHub 账号。请完成安装与登录后查看 Issue。'
                : errorPresentation.title}
            </p>
            {!errorPresentation.requiresGhSetup && errorPresentation.hint && (
              <p className="mt-1 text-[10px] text-muted-foreground/80 leading-relaxed">
                {errorPresentation.hint}
              </p>
            )}
            <Button
              type="button"
              size="sm"
              variant="outline"
              className="mt-3 h-7 px-2.5 text-xs gap-1.5"
              onClick={() => setSetupModalOpen(true)}
            >
              <Github className="h-3.5 w-3.5" />
              <span>安装 / 登录 GitHub CLI</span>
            </Button>
          </div>
        ) : (
          <div className="h-full flex items-center justify-center text-muted-foreground text-xs">
            <div className="text-center space-y-1">
              <CircleDot className="h-6 w-6 opacity-40 mx-auto" />
              <p>No {issueState} issues</p>
            </div>
          </div>
        )}
      </div>

      <GitHubCliSetupModal
        open={setupModalOpen}
        onOpenChange={setSetupModalOpen}
        onConfigured={onRefresh}
      />
    </div>
  );
});
