import { useEffect, useMemo, useState } from 'react';
import { convertFileSrc } from '@tauri-apps/api/core';
import {
  allowPreviewAssetScope,
  isPreviewAssetScopeGranted,
} from '@/lib/previewAssetScope';
import { FilePreviewLoading } from '@/components/panels/FilePreviewLoading';

/**
 * The page runs with scripts enabled but without `allow-same-origin`, so it
 * keeps an opaque origin: it cannot reach the VibeX DOM or its Tauri bridge,
 * while its own scripts, forms and popups behave normally.
 */
const PREVIEW_SANDBOX = 'allow-scripts allow-forms allow-modals allow-popups';

export function HostHtmlPreview({
  filePath,
  assetRoot,
  displayPath,
}: {
  /** Absolute path of the HTML file to render. */
  filePath: string;
  /** Directory whose assets the page may load through the asset protocol. */
  assetRoot: string;
  /** Workspace-relative path, shown while the scope grant is in flight. */
  displayPath: string;
}) {
  const [scopeReady, setScopeReady] = useState(() =>
    isPreviewAssetScopeGranted([assetRoot])
  );

  useEffect(() => {
    if (isPreviewAssetScopeGranted([assetRoot])) {
      setScopeReady(true);
      return;
    }

    let cancelled = false;
    setScopeReady(false);

    void allowPreviewAssetScope([assetRoot])
      .catch((error) => {
        // Losing the grant only costs the page its external assets; the
        // document itself still loads through the asset protocol.
        console.error('Failed to grant the preview asset scope', error);
      })
      .finally(() => {
        if (!cancelled) {
          setScopeReady(true);
        }
      });

    return () => {
      cancelled = true;
    };
  }, [assetRoot]);

  const source = useMemo(() => convertFileSrc(filePath), [filePath]);

  if (!scopeReady) {
    return (
      <FilePreviewLoading
        fileName={displayPath}
        label={`Opening ${displayPath}`}
      />
    );
  }

  return (
    <iframe
      key={source}
      src={source}
      title={displayPath}
      sandbox={PREVIEW_SANDBOX}
      className="h-full w-full border-0 bg-white"
    />
  );
}
