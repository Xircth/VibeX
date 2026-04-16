import { memo } from 'react';
import {
  GitPullRequest,
  ExternalLink,
  RefreshCw,
  Loader2,
  AlertCircle,
  GitBranch,
  ArrowRight,
} from 'lucide-react';
import type { OpenPrInfo } from 'shared/types';

interface GitPRsViewProps {
  prs: OpenPrInfo[];
  isLoading: boolean;
  error: string | null;
  onRefresh: () => void;
}

export const GitPRsView = memo(function GitPRsView({
  prs,
  isLoading,
  error,
  onRefresh,
}: GitPRsViewProps) {
  const openInBrowser = (url: string) => {
    window.open(url, '_blank');
  };

  return (
    <div className="flex flex-col h-full min-h-0">
      {/* Header */}
      <div className="flex items-center gap-1 px-2 py-1.5 border-b border-border/30 shrink-0">
        <GitPullRequest className="h-3 w-3 text-muted-foreground" />
        <span className="text-xs font-medium text-foreground flex-1">
          Pull Requests
        </span>
        <span className="text-[10px] text-muted-foreground mr-1">
          {prs.length} open
        </span>
        <button
          className="p-0.5 rounded text-muted-foreground hover:text-foreground hover:bg-accent/50 transition-colors"
          onClick={onRefresh}
          title="Refresh"
          disabled={isLoading}
        >
          {isLoading ? (
            <Loader2 className="h-3 w-3 animate-spin" />
          ) : (
            <RefreshCw className="h-3 w-3" />
          )}
        </button>
      </div>

      {/* Error */}
      {error && (
        <div className="flex items-center gap-1.5 px-2 py-1.5 text-destructive bg-destructive/5 border-b border-border/30">
          <AlertCircle className="h-3 w-3 shrink-0" />
          <span className="text-[10px] truncate">{error}</span>
        </div>
      )}

      {/* Content */}
      <div className="flex-1 overflow-y-auto min-h-0">
        {isLoading && prs.length === 0 ? (
          <div className="flex items-center justify-center h-full text-muted-foreground text-xs">
            <Loader2 className="h-4 w-4 animate-spin mr-1.5" />
            Loading pull requests...
          </div>
        ) : prs.length === 0 ? (
          <div className="flex flex-col items-center justify-center h-full text-muted-foreground">
            <GitPullRequest className="h-6 w-6 opacity-30 mb-2" />
            <span className="text-xs">No open pull requests</span>
          </div>
        ) : (
          <div className="flex flex-col">
            {prs.map((pr) => (
              <button
                key={Number(pr.number)}
                className="flex flex-col gap-1 px-2 py-2 border-b border-border/20 hover:bg-accent/30 transition-colors text-left group"
                onClick={() => openInBrowser(pr.url)}
                title={`Open PR #${pr.number} in browser`}
              >
                <div className="flex items-start gap-1.5">
                  <GitPullRequest className="h-3 w-3 text-green-500 shrink-0 mt-0.5" />
                  <div className="flex-1 min-w-0">
                    <div className="flex items-center gap-1">
                      <span className="text-xs font-medium text-foreground truncate">
                        {pr.title}
                      </span>
                      <ExternalLink className="h-2.5 w-2.5 text-muted-foreground opacity-0 group-hover:opacity-100 transition-opacity shrink-0" />
                    </div>
                    <div className="flex items-center gap-1 mt-0.5">
                      <span className="text-[10px] text-muted-foreground">
                        #{String(pr.number)}
                      </span>
                      <span className="text-[10px] text-muted-foreground/50">
                        |
                      </span>
                      <div className="flex items-center gap-0.5 text-[10px] text-muted-foreground truncate">
                        <GitBranch className="h-2.5 w-2.5" />
                        <span className="font-mono truncate">
                          {pr.head_branch}
                        </span>
                        <ArrowRight className="h-2 w-2 shrink-0" />
                        <span className="font-mono truncate">
                          {pr.base_branch}
                        </span>
                      </div>
                    </div>
                  </div>
                </div>
              </button>
            ))}
          </div>
        )}
      </div>
    </div>
  );
});
