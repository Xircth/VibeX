import { memo } from 'react';
import {
  CircleDot,
  CheckCircle2,
  MessageSquare,
  ExternalLink,
  RefreshCw,
  Loader2,
  AlertCircle,
} from 'lucide-react';
import type { GitHubIssueInfo } from 'shared/types';

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
  const isOpen = issue.state.toUpperCase() === 'OPEN';

  return (
    <button
      className="w-full text-left px-2 py-1.5 hover:bg-accent/30 transition-colors group border-b border-border/10 last:border-b-0"
      onClick={() => window.open(issue.url, '_blank')}
    >
      <div className="flex items-start gap-1.5">
        {isOpen ? (
          <CircleDot className="h-3.5 w-3.5 text-green-500 mt-0.5 shrink-0" />
        ) : (
          <CheckCircle2 className="h-3.5 w-3.5 text-purple-500 mt-0.5 shrink-0" />
        )}
        <div className="flex-1 min-w-0">
          <div className="flex items-center gap-1">
            <span className="text-xs text-foreground font-medium truncate">{issue.title}</span>
            <ExternalLink className="h-2.5 w-2.5 text-muted-foreground opacity-0 group-hover:opacity-100 shrink-0" />
          </div>
          <div className="flex items-center gap-2 mt-0.5">
            <span className="text-[10px] text-muted-foreground">#{String(issue.number)}</span>
            <span className="text-[10px] text-muted-foreground">{issue.author.login}</span>
            <span className="text-[10px] text-muted-foreground">{formatTimeAgo(issue.created_at)}</span>
            {Number(issue.comments_count) > 0 && (
              <span className="text-[10px] text-muted-foreground flex items-center gap-0.5">
                <MessageSquare className="h-2.5 w-2.5" />
                {String(issue.comments_count)}
              </span>
            )}
          </div>
          {issue.labels.length > 0 && (
            <div className="flex flex-wrap gap-1 mt-1">
              {issue.labels.map((label) => (
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
  return (
    <div className="flex flex-col h-full">
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
      <div className="flex-1 overflow-y-auto">
        {error && (
          <div className="flex items-center gap-1.5 px-2 py-2 text-[10px] text-destructive">
            <AlertCircle className="h-3 w-3 shrink-0" />
            <span className="truncate">{error}</span>
          </div>
        )}

        {!isLoading && !error && issues.length === 0 && (
          <div className="h-full flex items-center justify-center text-muted-foreground text-xs">
            <div className="text-center space-y-1">
              <CircleDot className="h-6 w-6 opacity-40 mx-auto" />
              <p>No {issueState} issues</p>
            </div>
          </div>
        )}

        {isLoading && issues.length === 0 && (
          <div className="h-full flex items-center justify-center text-muted-foreground text-xs">
            Loading issues...
          </div>
        )}

        {issues.map((issue) => (
          <IssueRow key={Number(issue.number)} issue={issue} />
        ))}
      </div>
    </div>
  );
});
