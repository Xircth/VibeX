import { createContext, useContext, useEffect, useId, useState } from 'react';
import type { ReactNode } from 'react';
import { conversationApi } from '@/features/conversation/conversationApi';
import {
  claimTimelineImage,
  decodeBase64,
  objectUrlForBytes,
  releaseTimelineImage,
  releaseTimelineImagePanel,
  subscribeTimelineImages,
  timelineImageHash,
  timelineImageSrc,
} from '@/features/conversation/timelineImageDecode';

const TimelineImagePanelContext = createContext<string>('detached');

export function TimelineImagePanel({ children }: { children: ReactNode }) {
  const panelId = useId();
  useEffect(() => () => releaseTimelineImagePanel(panelId), [panelId]);
  return (
    <TimelineImagePanelContext.Provider value={panelId}>
      {children}
    </TimelineImagePanelContext.Provider>
  );
}

export function useTimelineImagePanelId(): string {
  return useContext(TimelineImagePanelContext);
}

export function useDecodedTimelineImage(input: {
  imageKey: string;
  enabled: boolean;
  data: string;
  mimeType: string;
  uri: string | null;
}): string | null {
  const panelId = useTimelineImagePanelId();
  const [, setTick] = useState(0);
  const { imageKey, enabled, data, mimeType, uri } = input;

  useEffect(
    () => subscribeTimelineImages(() => setTick((tick) => tick + 1)),
    []
  );

  useEffect(() => {
    if (!enabled) return;
    let cancelled = false;
    const hash = timelineImageHash(uri);
    if (hash) {
      void conversationApi
        .timelineImage(hash)
        .then((image) => {
          if (cancelled) return;
          const bytes = decodeBase64(image.data_base64);
          const url = objectUrlForBytes(
            bytes,
            image.mime_type || mimeType || 'application/octet-stream'
          );
          claimTimelineImage(panelId, imageKey, url, url.startsWith('blob:'));
        })
        .catch(() => undefined);
    } else if (/^https?:\/\//i.test(uri ?? '')) {
      claimTimelineImage(panelId, imageKey, uri ?? '', false);
    } else if (data) {
      const url = objectUrlForBytes(
        decodeBase64(data),
        mimeType || 'application/octet-stream'
      );
      claimTimelineImage(panelId, imageKey, url, url.startsWith('blob:'));
    }
    return () => {
      cancelled = true;
      releaseTimelineImage(panelId, imageKey);
    };
  }, [data, enabled, imageKey, mimeType, panelId, uri]);

  if (!enabled) return null;
  return timelineImageSrc(panelId, imageKey);
}

export function CollapsibleTimelineImage({
  imageKey,
  data,
  mimeType,
  uri,
  className,
  alt,
}: {
  imageKey: string;
  data: string;
  mimeType: string;
  uri: string | null;
  className?: string;
  alt: string;
}) {
  const src = useDecodedTimelineImage({
    imageKey,
    enabled: true,
    data,
    mimeType,
    uri,
  });
  return src ? <img className={className} src={src} alt={alt} /> : null;
}
