import { backendCall } from '@/lib/backendTransport';
import { fileExtension, mimeForMediaExtension } from '@/utils/mediaAttachments';

const blobUrls = new Map<string, string>();

export function isDirectBrowserDisplayUrl(
  url: string | null | undefined
): boolean {
  if (!url) return false;
  return /^(blob:|asset:|https?:|tauri:)/i.test(url);
}

export function isBrowserDisplayUrl(url: string | null | undefined): boolean {
  if (!url) return false;
  return isDirectBrowserDisplayUrl(url) || /^data:/i.test(url);
}

export function blobSrcFromDataUrl(dataUrl: string): string | null {
  const match = /^data:([^;,]+)?(;base64)?,(.*)$/s.exec(dataUrl);
  if (!match) return null;

  const mime = match[1] || 'application/octet-stream';
  const isBase64 = Boolean(match[2]);
  const payload = match[3] ?? '';

  try {
    const bytes = isBase64
      ? decodeBase64Bytes(payload)
      : new TextEncoder().encode(decodeURIComponent(payload));
    return URL.createObjectURL(
      new Blob([bytesToArrayBuffer(bytes)], { type: mime })
    );
  } catch {
    return null;
  }
}

function decodeBase64Bytes(encoded: string): Uint8Array {
  const binary = atob(encoded);
  const bytes = new Uint8Array(binary.length);
  for (let index = 0; index < binary.length; index += 1) {
    bytes[index] = binary.charCodeAt(index);
  }
  return bytes;
}

function bytesToArrayBuffer(bytes: Uint8Array): ArrayBuffer {
  const copy = new ArrayBuffer(bytes.byteLength);
  new Uint8Array(copy).set(bytes);
  return copy;
}

export async function hostFileSrc(path: string): Promise<string> {
  const cached = blobUrls.get(path);
  if (cached) {
    return cached;
  }
  const result = await backendCall<{
    data_base64?: string;
    base64?: string;
    mime_type?: string;
  }>('read_binary_asset', { path });
  const encoded = result.data_base64 ?? result.base64;
  if (!encoded) {
    throw new Error('Binary asset is missing');
  }
  const mime =
    result.mime_type ||
    mimeForMediaExtension(fileExtension(path)) ||
    'application/octet-stream';
  const url = URL.createObjectURL(
    new Blob([bytesToArrayBuffer(decodeBase64Bytes(encoded))], { type: mime })
  );
  blobUrls.set(path, url);
  return url;
}
