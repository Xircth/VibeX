import { useEffect, useMemo, useState } from 'react';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import {
  fileTreeApi,
  type BinaryAssetResponse,
} from '@/lib/api';
import { fileTreeKeys } from '@/hooks/useFileTree';

export const fileContentKeys = {
  all: ['fileContent'] as const,
  byPath: (path: string | null) => ['fileContent', path] as const,
  headByPath: (path: string | null) => ['fileContentHead', path] as const,
  binaryAssetByPath: (path: string | null) => ['binaryAsset', path] as const,
};

/**
 * Hook to read file content by path.
 */
export function useFileContent(path: string | null) {
  return useQuery<string>({
    queryKey: fileContentKeys.byPath(path),
    queryFn: () => fileTreeApi.readFile(path!),
    enabled: !!path,
    staleTime: 2_000,
    retry: false,
    meta: {
      suppressGlobalError: true,
    },
  });
}

/**
 * Hook to read file content at HEAD (git).
 */
export function useFileAtHead(path: string | null) {
  return useQuery<string>({
    queryKey: fileContentKeys.headByPath(path),
    queryFn: () => fileTreeApi.getFileAtHead(path!),
    enabled: !!path,
    retry: false,
    meta: {
      suppressGlobalError: true,
    },
  });
}

function decodeBase64ToBlob(base64: string, mimeType: string) {
  const binary = atob(base64);
  const bytes = new Uint8Array(binary.length);

  for (let index = 0; index < binary.length; index += 1) {
    bytes[index] = binary.charCodeAt(index);
  }

  return new Blob([bytes], { type: mimeType });
}

/**
 * Hook to read a binary asset and expose it as a local blob URL for preview.
 */
export function useBinaryAssetPreview(path: string | null) {
  const query = useQuery<BinaryAssetResponse>({
    queryKey: fileContentKeys.binaryAssetByPath(path),
    queryFn: () => fileTreeApi.readBinaryAsset(path!),
    enabled: !!path,
    staleTime: 30_000,
    retry: false,
    meta: {
      suppressGlobalError: true,
    },
  });

  const blob = useMemo(() => {
    if (!query.data) {
      return null;
    }

    return decodeBase64ToBlob(query.data.data_base64, query.data.mime_type);
  }, [query.data]);
  const [objectUrl, setObjectUrl] = useState<string | null>(null);

  useEffect(() => {
    if (!blob) {
      setObjectUrl(null);
      return;
    }

    const nextObjectUrl = URL.createObjectURL(blob);
    setObjectUrl(nextObjectUrl);

    return () => {
      URL.revokeObjectURL(nextObjectUrl);
    };
  }, [blob]);

  return {
    assetUrl: objectUrl,
    mimeType: query.data?.mime_type ?? null,
    isLoading: query.isLoading,
    error: query.error,
  };
}

/**
 * Mutation hook to save file content.
 */
export function useSaveFile() {
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: ({ path, content }: { path: string; content: string }) =>
      fileTreeApi.saveFile(path, content),
    onSuccess: (_data, variables) => {
      // Invalidate the file content cache for the saved file
      queryClient.invalidateQueries({
        queryKey: fileContentKeys.byPath(variables.path),
      });
      // Also invalidate file tree to refresh git status
      queryClient.invalidateQueries({
        queryKey: fileTreeKeys.all,
      });
    },
  });
}

/**
 * Mutation hook to delete a file.
 */
export function useDeleteFile() {
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: (path: string) => fileTreeApi.deleteFile(path),
    onSuccess: () => {
      // Invalidate file tree to refresh
      queryClient.invalidateQueries({
        queryKey: fileTreeKeys.all,
      });
    },
  });
}
