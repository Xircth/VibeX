import { useEffect, useRef, useState } from 'react';
import { FileOutput, Loader2, SquareArrowOutUpRight, X } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import type { ConversationArtifactReference } from 'shared/types';

import { Button } from '@/components/ui/button';
import {
  tauriBackendTransport,
  type BackendTransport,
} from '@/lib/backendTransport';

type ArtifactPreviewLease = {
  leaseId: string;
  artifactId: string;
  providerId: string;
  loopbackPort: number;
  capabilityToken: string;
  expiresAtUnixMs: number;
  docxFallbackSupported: boolean;
};

function isPreviewLease(value: unknown): value is ArtifactPreviewLease {
  return (
    typeof value === 'object' &&
    value !== null &&
    'leaseId' in value &&
    'loopbackPort' in value &&
    typeof value.leaseId === 'string' &&
    typeof value.loopbackPort === 'number'
  );
}

function fileName(path: string): string {
  return path.split(/[\\/]/).filter(Boolean).at(-1) ?? path;
}

function mediaLabel(mediaType: string): string {
  if (mediaType.endsWith('presentationml.presentation')) return 'PPTX';
  if (mediaType.endsWith('wordprocessingml.document')) return 'DOCX';
  if (mediaType.endsWith('spreadsheetml.sheet')) return 'XLSX';
  return mediaType;
}

export function ArtifactTimelineCard({
  artifact,
  transport = tauriBackendTransport,
}: {
  artifact: ConversationArtifactReference;
  transport?: BackendTransport;
}) {
  const { t } = useTranslation('conversation');
  const [lease, setLease] = useState<ArtifactPreviewLease | null>(null);
  const [isOpening, setIsOpening] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const leaseRef = useRef<ArtifactPreviewLease | null>(null);
  const lifecycleGenerationRef = useRef(0);
  const name = fileName(artifact.relative_path);

  useEffect(() => {
    const generation = lifecycleGenerationRef.current + 1;
    lifecycleGenerationRef.current = generation;
    return () => {
      if (lifecycleGenerationRef.current === generation) {
        lifecycleGenerationRef.current += 1;
      }
      const current = leaseRef.current;
      if (current) {
        leaseRef.current = null;
        void transport
          .call('artifact_close_preview', { leaseId: current.leaseId })
          .catch(() => {});
      }
    };
  }, [transport]);

  const openPreview = async () => {
    if (isOpening || leaseRef.current) return;
    const generation = lifecycleGenerationRef.current;
    setIsOpening(true);
    setError(null);
    try {
      const result = await transport.call('artifact_open_preview', {
        artifactId: artifact.artifact_id,
      });
      if (!isPreviewLease(result)) {
        throw new Error(t('artifact.invalidPreviewLease'));
      }
      if (generation !== lifecycleGenerationRef.current) {
        await transport.call('artifact_close_preview', {
          leaseId: result.leaseId,
        });
        return;
      }
      leaseRef.current = result;
      setLease(result);
    } catch (error) {
      if (generation === lifecycleGenerationRef.current) {
        setError(error instanceof Error ? error.message : String(error));
      }
    } finally {
      if (generation === lifecycleGenerationRef.current) {
        setIsOpening(false);
      }
    }
  };

  const closePreview = async () => {
    const current = leaseRef.current;
    if (!current) return;
    try {
      await transport.call('artifact_close_preview', {
        leaseId: current.leaseId,
      });
      leaseRef.current = null;
      setLease(null);
    } catch (error) {
      setError(error instanceof Error ? error.message : String(error));
    }
  };

  return (
    <article className="rounded-lg border border-border bg-secondary/25 px-3 py-2.5">
      <div className="flex items-center gap-3">
        <span className="flex h-8 w-8 shrink-0 items-center justify-center rounded-md border border-border bg-background">
          <FileOutput className="h-4 w-4 text-muted-foreground" />
        </span>
        <div className="min-w-0 flex-1">
          <p className="truncate text-sm font-medium">{name}</p>
          <p className="mt-0.5 text-[11px] text-muted-foreground">
            {mediaLabel(artifact.media_type)} ·{' '}
            {t('artifact.revision', { revision: artifact.revision.toString() })}
          </p>
        </div>
        <Button
          type="button"
          size="sm"
          variant="outline"
          disabled={isOpening || lease !== null}
          aria-label={t('artifact.openPreviewAria', { name })}
          onClick={() => void openPreview()}
        >
          {isOpening ? (
            <Loader2 className="mr-1 h-3.5 w-3.5 animate-spin" />
          ) : (
            <SquareArrowOutUpRight className="mr-1 h-3.5 w-3.5" />
          )}
          {t('artifact.openPreview')}
        </Button>
      </div>
      {error ? (
        <p role="alert" className="mt-2 text-xs text-destructive">
          {error}
        </p>
      ) : null}
      {lease ? (
        <div className="mt-3 overflow-hidden rounded-md border border-border bg-background">
          <div className="flex items-center justify-between border-b border-border px-3 py-2">
            <span className="text-xs font-medium">{name}</span>
            <Button
              type="button"
              size="icon"
              variant="ghost"
              aria-label={t('artifact.closePreviewAria', { name })}
              onClick={() => void closePreview()}
            >
              <X className="h-3.5 w-3.5" />
            </Button>
          </div>
          <iframe
            title={t('artifact.previewTitle', { name })}
            src={`http://127.0.0.1:${lease.loopbackPort}/`}
            sandbox="allow-scripts allow-same-origin allow-popups allow-forms"
            referrerPolicy="no-referrer"
            className="aspect-video w-full border-0 bg-white"
          />
        </div>
      ) : null}
    </article>
  );
}
