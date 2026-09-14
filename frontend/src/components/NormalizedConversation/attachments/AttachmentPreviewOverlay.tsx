import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useLayoutEffect,
  useState,
  type ReactNode,
} from 'react';
import { createPortal } from 'react-dom';
import { useTranslation } from 'react-i18next';
import { FileWarning, Loader2, X } from 'lucide-react';
import { AstryxMarkdown } from '@/components/NormalizedConversation/AstryxMarkdown';
import { useBinaryAssetPreview, useFileContent } from '@/hooks/useFileContent';
import {
  getFilePreviewForm,
  type FilePreviewKind,
} from '@/utils/filePreviewKind';

const HOST_SELECTOR =
  '[data-conversation-preview-host], .right-panel-conversation-region';

export type AttachmentPreviewTarget = {
  fileName: string;
  filePath: string;
  previewKind: FilePreviewKind;
};

type AttachmentPreviewContextValue = {
  open: (target: AttachmentPreviewTarget) => void;
};

const AttachmentPreviewContext =
  createContext<AttachmentPreviewContextValue | null>(null);

export function useOptionalAttachmentPreview() {
  return useContext(AttachmentPreviewContext);
}

export function AttachmentPreviewProvider({
  children,
}: {
  children: ReactNode;
}) {
  const [target, setTarget] = useState<AttachmentPreviewTarget | null>(null);
  const open = useCallback((next: AttachmentPreviewTarget) => {
    setTarget(next);
  }, []);

  return (
    <AttachmentPreviewContext.Provider value={{ open }}>
      {children}
      {target ? (
        <AttachmentPreviewOverlay
          target={target}
          onClose={() => setTarget(null)}
        />
      ) : null}
    </AttachmentPreviewContext.Provider>
  );
}

function canKanbanPreview(target: AttachmentPreviewTarget): boolean {
  if (target.previewKind === 'pdf') return true;
  return getFilePreviewForm(target.fileName || target.filePath) === 'markdown';
}

function AttachmentPreviewOverlay({
  target,
  onClose,
}: {
  target: AttachmentPreviewTarget;
  onClose: () => void;
}) {
  const { t } = useTranslation('conversation');
  const [host, setHost] = useState<HTMLElement | null>(null);

  useLayoutEffect(() => {
    const node = document.querySelector(HOST_SELECTOR);
    setHost(node instanceof HTMLElement ? node : null);
  }, []);

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key !== 'Escape') return;
      event.stopPropagation();
      onClose();
    };
    window.addEventListener('keydown', onKeyDown, true);
    return () => window.removeEventListener('keydown', onKeyDown, true);
  }, [onClose]);

  const overlay = (
    <div
      data-testid="attachment-preview-backdrop"
      className="absolute inset-0 z-40 flex items-stretch justify-center bg-background/70 p-5 backdrop-blur-md"
    >
      <div
        role="dialog"
        aria-modal="true"
        aria-labelledby="attachment-preview-title"
        data-testid="attachment-preview-overlay"
        className="flex h-full max-h-full w-full max-w-3xl flex-col overflow-hidden rounded-xl bg-[var(--surface-control)] text-popover-foreground shadow-[var(--shadow-popover)]"
      >
        <header className="flex h-10 shrink-0 items-center gap-2 px-4">
          <h2
            id="attachment-preview-title"
            className="min-w-0 flex-1 truncate text-sm font-medium text-foreground"
          >
            {target.fileName}
          </h2>
          <button
            type="button"
            className="inline-flex h-7 w-7 items-center justify-center rounded-md text-muted-foreground transition-colors hover:bg-[var(--surface-control-hover)] hover:text-foreground focus:outline-none focus:ring-2 focus:ring-[var(--focus-ring)]"
            onClick={onClose}
            aria-label={t('attachments.closePreview')}
          >
            <X className="h-4 w-4" />
          </button>
        </header>
        <div className="mx-3 mb-3 min-h-0 flex-1 overflow-hidden rounded-xl bg-background">
          {canKanbanPreview(target) ? (
            <AttachmentPreviewBody target={target} />
          ) : (
            <UnsupportedPreview />
          )}
        </div>
      </div>
    </div>
  );

  if (!host) return overlay;
  return createPortal(overlay, host);
}

function UnsupportedPreview() {
  const { t } = useTranslation('conversation');
  return (
    <div
      data-testid="attachment-preview-unsupported"
      className="flex h-full flex-col items-center justify-center gap-3 px-6 text-center text-muted-foreground"
    >
      <FileWarning className="h-10 w-10 opacity-50" />
      <p className="text-sm font-medium text-foreground">
        {t('attachments.kanbanUnsupported')}
      </p>
    </div>
  );
}

function AttachmentPreviewBody({
  target,
}: {
  target: AttachmentPreviewTarget;
}) {
  if (target.previewKind === 'pdf') {
    return <PdfPreview path={target.filePath} title={target.fileName} />;
  }
  return <MarkdownPreview path={target.filePath} />;
}

function PdfPreview({ path, title }: { path: string; title: string }) {
  const { assetUrl, isLoading, error } = useBinaryAssetPreview(path || null);
  if (isLoading) {
    return <PreviewLoading />;
  }
  if (!assetUrl || error) {
    return <UnsupportedPreview />;
  }
  return (
    <object
      data={assetUrl}
      type="application/pdf"
      className="h-full w-full bg-background"
    >
      <iframe src={assetUrl} title={title} className="h-full w-full border-0" />
    </object>
  );
}

function MarkdownPreview({ path }: { path: string }) {
  const { data, isLoading, error } = useFileContent(path || null);
  if (isLoading) {
    return <PreviewLoading />;
  }
  if (data == null || error) {
    return <UnsupportedPreview />;
  }
  return (
    <div className="h-full overflow-y-auto px-4 py-3">
      <AstryxMarkdown value={data} />
    </div>
  );
}

function PreviewLoading() {
  return (
    <div className="flex h-full items-center justify-center text-muted-foreground">
      <Loader2 className="h-5 w-5 animate-spin motion-reduce:animate-none" />
    </div>
  );
}
