import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { fileTreeApi } from '@/lib/api';
import { fileTreeKeys } from '@/hooks/useFileTree';

export const fileContentKeys = {
  all: ['fileContent'] as const,
  byPath: (path: string | null) => ['fileContent', path] as const,
  headByPath: (path: string | null) => ['fileContentHead', path] as const,
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
  });
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
