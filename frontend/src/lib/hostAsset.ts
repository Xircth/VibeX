import { backendCall } from '@/lib/backendTransport';
import { fileExtension, mimeForMediaExtension } from '@/utils/mediaAttachments';

type HostFileBlob = {
  url: string;
  refs: number;
};

const blobUrls = new Map<string, HostFileBlob>();
const inflight = new Map<string, Promise<string>>();

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
    cached.refs += 1;
    return cached.url;
  }

  let pending = inflight.get(path);
  if (!pending) {
    pending = createHostFileBlobUrl(path).finally(() => {
      inflight.delete(path);
    });
    inflight.set(path, pending);
  }

  const url = await pending;
  const entry = blobUrls.get(path);
  if (entry) {
    entry.refs += 1;
    return entry.url;
  }
  blobUrls.set(path, { url, refs: 1 });
  return url;
}

/** Drop one retainer. The blob is revoked when the last retainer releases. */
export function releaseHostFileSrc(path: string): void {
  const entry = blobUrls.get(path);
  if (!entry) return;
  entry.refs -= 1;
  if (entry.refs > 0) return;
  blobUrls.delete(path);
  URL.revokeObjectURL(entry.url);
}

/** Test helper: drop every cached blob so cases do not leak across tests. */
export function resetHostFileSrcCache(): void {
  for (const entry of blobUrls.values()) {
    URL.revokeObjectURL(entry.url);
  }
  blobUrls.clear();
  inflight.clear();
}

async function createHostFileBlobUrl(path: string): Promise<string> {
  const existing = blobUrls.get(path);
  if (existing) {
    return existing.url;
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
  // Do not insert into `blobUrls` here. A refs:0 entry lets an unmounting
  // caller revoke the blob before hostFileSrc claims it, which is the
  // blank-thumbnail / dead-click path on user messages.
  return URL.createObjectURL(
    new Blob([bytesToArrayBuffer(decodeBase64Bytes(encoded))], { type: mime })
  );
}
