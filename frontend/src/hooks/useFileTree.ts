import { useQuery } from '@tanstack/react-query';
import { fileTreeApi } from '@/lib/api';
import type { FileTreeEntry } from '@/lib/api';

export const fileTreeKeys = {
  all: ['fileTree'] as const,
  byRoot: (rootPath: string | null, depth?: number) =>
    ['fileTree', rootPath, depth] as const,
};

export function useFileTree(rootPath: string | null, depth?: number) {
  return useQuery<FileTreeEntry[]>({
    queryKey: fileTreeKeys.byRoot(rootPath, depth),
    queryFn: () => fileTreeApi.getTree(rootPath!, depth),
    enabled: !!rootPath,
    staleTime: 5_000,
    refetchInterval: 10_000,
  });
}
