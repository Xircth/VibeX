import { useMemo } from 'react';
import { useQuery } from '@tanstack/react-query';
import { convertFileSrc } from '@tauri-apps/api/core';
import type { ImageMetadata } from 'shared/types';
import type { LocalImageMetadata } from '@/types/local-image-metadata';
import { backendCall } from '@/lib/backendTransport';

export function useImageMetadata(
  taskAttemptId: string | undefined,
  src: string,
  taskId?: string | undefined,
  localImages?: LocalImageMetadata[]
) {
  const isVibeImage = src.startsWith('.vibe-images/');

  // Synchronous lookup for local images
  const localImage = useMemo(
    () => localImages?.find((img) => img.path === src),
    [localImages, src]
  );

  // Convert to ImageMetadata format
  const localImageMetadata: ImageMetadata | null = useMemo(
    () =>
      localImage
        ? {
            exists: true,
            file_name: localImage.file_name,
            path: localImage.path,
            size_bytes: BigInt(localImage.size_bytes),
            format: localImage.format,
            proxy_url: localImage.proxy_url,
          }
        : null,
    [localImage]
  );

  const hasContext = !!taskAttemptId || !!taskId;
  // Only fetch from API if: vibe image, has context, and NO local image
  const shouldFetch = isVibeImage && hasContext && !localImage;

  const query = useQuery({
    queryKey: ['imageMetadata', taskAttemptId, taskId, src],
    queryFn: async (): Promise<ImageMetadata | null> => {
      if (taskAttemptId) {
        const data = await backendCall<ImageMetadata>(
          'get_workspace_image_metadata',
          {
            workspaceId: taskAttemptId,
            path: src,
          }
        );
        return data.proxy_url
          ? { ...data, proxy_url: convertFileSrc(data.proxy_url) }
          : data;
      }
      if (taskId) {
        const data = await backendCall<ImageMetadata>(
          'get_task_image_metadata',
          {
            taskId,
            path: src,
          }
        );
        return data.proxy_url
          ? { ...data, proxy_url: convertFileSrc(data.proxy_url) }
          : data;
      }
      return null;
    },
    enabled: shouldFetch,
    staleTime: Infinity,
  });

  // Return local data if available, otherwise query result
  return {
    data: localImageMetadata ?? query.data,
    isLoading: localImage ? false : query.isLoading,
  };
}
