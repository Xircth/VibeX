import { useState, useRef, useEffect } from 'react';
import { useTranslation } from 'react-i18next';
import { ExternalLink, RefreshCw, Copy, Loader2, Pause, X } from 'lucide-react';
import { Button } from '@/components/ui/button';
import {
  Tooltip,
  TooltipContent,
  TooltipProvider,
  TooltipTrigger,
} from '@/components/ui/tooltip';
import { NewCardHeader } from '@/components/ui/new-card';
import { Input } from '@/components/ui/input';

interface PreviewToolbarProps {
  mode: 'noServer' | 'error' | 'ready';
  url?: string;
  onRefresh: () => void;
  onCopyUrl: () => void;
  onStop: () => void;
  isStopping?: boolean;
  customUrl: string | null;
  detectedUrl: string | undefined;
  onUrlChange: (url: string | null) => void;
}

export function PreviewToolbar({
  mode,
  url,
  onRefresh,
  onCopyUrl,
  onStop,
  isStopping,
  customUrl,
  detectedUrl,
  onUrlChange,
}: PreviewToolbarProps) {
  const { t } = useTranslation(['tasks', 'common']);
  const [isEditing, setIsEditing] = useState(false);
  const [urlInput, setUrlInput] = useState('');
  const inputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    if (isEditing && inputRef.current) {
      inputRef.current.focus();
      inputRef.current.select();
    }
  }, [isEditing]);

  const handleStartEdit = () => {
    setUrlInput(url ?? '');
    setIsEditing(true);
  };

  const handleSubmit = () => {
    const trimmed = urlInput.trim();
    if (!trimmed || trimmed === detectedUrl) {
      // Empty input or detected URL: reset to detected
      onUrlChange(null);
    } else {
      onUrlChange(trimmed);
    }
    setIsEditing(false);
  };

  const handleKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === 'Enter') {
      handleSubmit();
    } else if (e.key === 'Escape') {
      setIsEditing(false);
    }
  };

  const handleClearCustomUrl = () => {
    onUrlChange(null);
  };

  const actions =
    mode !== 'noServer' ? (
      <>
        <TooltipProvider>
          <Tooltip>
            <TooltipTrigger asChild>
              <Button
                variant="icon"
                aria-label={t('previewToolbar.refreshPreview')}
                onClick={onRefresh}
              >
                <RefreshCw className="h-4 w-4" />
              </Button>
            </TooltipTrigger>
            <TooltipContent side="bottom">
              {t('previewToolbar.refreshPreview')}
            </TooltipContent>
          </Tooltip>
        </TooltipProvider>

        <TooltipProvider>
          <Tooltip>
            <TooltipTrigger asChild>
              <Button
                variant="icon"
                aria-label={t('previewToolbar.copyUrl')}
                onClick={onCopyUrl}
                disabled={!url}
              >
                <Copy className="h-4 w-4" />
              </Button>
            </TooltipTrigger>
            <TooltipContent side="bottom">
              {t('previewToolbar.copyUrl')}
            </TooltipContent>
          </Tooltip>
        </TooltipProvider>

        <TooltipProvider>
          <Tooltip>
            <TooltipTrigger asChild>
              <Button
                variant="icon"
                aria-label={t('previewToolbar.openInNewTab')}
                asChild
                disabled={!url}
              >
                <a
                  href={url}
                  target="_blank"
                  rel="noopener noreferrer"
                  className="flex items-center"
                >
                  <ExternalLink className="h-4 w-4" />
                </a>
              </Button>
            </TooltipTrigger>
            <TooltipContent side="bottom">
              {t('previewToolbar.openInNewTab')}
            </TooltipContent>
          </Tooltip>
        </TooltipProvider>

        <div className="h-4 w-px bg-border" />

        <TooltipProvider>
          <Tooltip>
            <TooltipTrigger asChild>
              <Button
                variant="icon"
                aria-label={t('previewToolbar.stopDevServer')}
                onClick={onStop}
                disabled={isStopping}
              >
                {isStopping ? (
                  <Loader2 className="h-4 w-4 animate-spin" />
                ) : (
                  <Pause className="h-4 w-4 text-destructive" />
                )}
              </Button>
            </TooltipTrigger>
            <TooltipContent side="bottom">
              {t('previewToolbar.stopDevServer')}
            </TooltipContent>
          </Tooltip>
        </TooltipProvider>
      </>
    ) : undefined;

  return (
    <NewCardHeader className="shrink-0" actions={actions}>
      <div className="flex items-center gap-2 min-w-0">
        {isEditing ? (
          <Input
            ref={inputRef}
            type="text"
            value={urlInput}
            onChange={(e) => setUrlInput(e.target.value)}
            onBlur={handleSubmit}
            onKeyDown={handleKeyDown}
            className="h-7 text-sm font-mono flex-1"
            placeholder="http://localhost:3000"
          />
        ) : (
          <>
            <button
              onClick={handleStartEdit}
              className="text-sm text-muted-foreground font-mono truncate hover:text-foreground transition-colors cursor-text text-left"
              aria-live="polite"
              title={t('previewToolbar.clickToEditUrl')}
            >
              {url || <Loader2 className="h-4 w-4 animate-spin" />}
            </button>
            {customUrl !== null && (
              <TooltipProvider>
                <Tooltip>
                  <TooltipTrigger asChild>
                    <Button
                      variant="ghost"
                      size="sm"
                      onClick={handleClearCustomUrl}
                      className="h-5 w-5 p-0 shrink-0"
                    >
                      <X className="h-3 w-3" />
                    </Button>
                  </TooltipTrigger>
                  <TooltipContent side="bottom">
                    {t('previewToolbar.resetToDetectedUrl')}
                  </TooltipContent>
                </Tooltip>
              </TooltipProvider>
            )}
          </>
        )}
      </div>
    </NewCardHeader>
  );
}
