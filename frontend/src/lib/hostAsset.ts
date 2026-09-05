import { backendCall } from '@/lib/backendTransport';

const blobUrls = new Map<string, string>();

export async function hostFileSrc(path: string): Promise<string> {
  const cached = blobUrls.get(path);
  if (cached) {
    return cached;
  }
  const result = await backendCall<{
    data_base64?: string;
    base64?: string;
  }>('read_binary_asset', { path });
  const encoded = result.data_base64 ?? result.base64;
  if (!encoded) {
    throw new Error('Binary asset is missing');
  }
  const binary = atob(encoded);
  const bytes = new Uint8Array(binary.length);
  for (let index = 0; index < binary.length; index += 1) {
    bytes[index] = binary.charCodeAt(index);
  }
  const url = URL.createObjectURL(new Blob([bytes]));
  blobUrls.set(path, url);
  return url;
}
