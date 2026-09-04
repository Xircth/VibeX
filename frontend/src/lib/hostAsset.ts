import { getBackendTransport } from '@/lib/transport';
import { backendCall } from '@/lib/backendTransport';

const blobUrls = new Map<string, string>();

export async function hostFileSrc(path: string): Promise<string> {
  const transport = getBackendTransport();
  if (transport.environment === 'desktop') {
    const { convertFileSrc } = await import('@tauri-apps/api/core');
    return convertFileSrc(path);
  }
  const cached = blobUrls.get(path);
  if (cached) {
    return cached;
  }
  const result = await backendCall<{ base64: string }>('read_binary_asset', {
    path,
  });
  const binary = atob(result.base64);
  const bytes = new Uint8Array(binary.length);
  for (let index = 0; index < binary.length; index += 1) {
    bytes[index] = binary.charCodeAt(index);
  }
  const url = URL.createObjectURL(new Blob([bytes]));
  blobUrls.set(path, url);
  return url;
}
