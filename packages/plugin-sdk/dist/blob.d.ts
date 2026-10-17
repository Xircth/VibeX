import type { PluginHostClient } from "./worker.js";
/** One `blob.append` / `blob.read` payload. It fits in the smallest 1 MiB frame. */
export declare const BLOB_CHUNK_BYTES: number;
/** A single video or other blob. JSON messages stay capped separately. */
export declare const BLOB_MAX_BYTES: number;
export type BlobRef = {
    id: string;
    byteLength: number;
    mediaType: string;
    name: string | null;
    finished: boolean;
};
export declare function writeBlob(host: PluginHostClient, data: Uint8Array, options?: {
    mediaType?: string;
    name?: string;
}): Promise<BlobRef>;
export declare function readBlob(host: PluginHostClient, id: string): Promise<Uint8Array>;
