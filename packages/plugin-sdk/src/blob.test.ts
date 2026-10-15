import { describe, expect, it } from "vitest";

import { BLOB_CHUNK_BYTES, readBlob, writeBlob } from "./blob.js";
import type { JsonValue } from "./protocol.js";
import type { PluginHostClient } from "./worker.js";

function memoryBlobHost() {
  const blobs = new Map<
    string,
    { mediaType: string; name: string | null; finished: boolean; bytes: Buffer }
  >();
  let sequence = 0;
  const calls: string[] = [];
  const host: PluginHostClient = {
    async call<T extends JsonValue>(
      capability: string,
      operation: string,
      input?: JsonValue,
    ): Promise<T> {
      calls.push(`${capability}.${operation}`);
      const body = (input ?? {}) as {
        id?: string;
        data?: string;
        mediaType?: string;
        name?: string | null;
        offset?: number;
        length?: number;
      };
      if (operation === "create") {
        const id = `abc${String(++sequence).padStart(29, "0")}`;
        blobs.set(id, {
          mediaType: body.mediaType ?? "application/octet-stream",
          name: body.name ?? null,
          finished: false,
          bytes: Buffer.alloc(0),
        });
        return { id } as T;
      }
      const blob = blobs.get(body.id ?? "");
      if (!blob) throw new Error("missing");
      if (operation === "append") {
        const chunk = Buffer.from(body.data ?? "", "base64");
        expect(chunk.byteLength).toBeLessThanOrEqual(BLOB_CHUNK_BYTES);
        blob.bytes = Buffer.concat([blob.bytes, chunk]);
        return { id: body.id, byteLength: blob.bytes.byteLength } as T;
      }
      if (operation === "finish") {
        blob.finished = true;
        return {
          id: body.id,
          byteLength: blob.bytes.byteLength,
          mediaType: blob.mediaType,
          name: blob.name,
          finished: true,
        } as T;
      }
      if (operation === "read") {
        const offset = body.offset ?? 0;
        const length = Math.min(
          body.length ?? BLOB_CHUNK_BYTES,
          blob.bytes.byteLength - offset,
        );
        return {
          id: body.id,
          data: blob.bytes.subarray(offset, offset + length).toString("base64"),
          byteLength: blob.bytes.byteLength,
        } as T;
      }
      throw new Error(operation);
    },
  };
  return { host, calls };
}

describe("blob transfer", () => {
  it("writes a video larger than one chunk and reads it back", async () => {
    const { host, calls } = memoryBlobHost();
    const video = Buffer.alloc(BLOB_CHUNK_BYTES + 2, 7);
    video[video.byteLength - 1] = 9;
    const saved = await writeBlob(host, video, {
      mediaType: "video/mp4",
      name: "clip.mp4",
    });
    expect(saved.byteLength).toBe(video.byteLength);
    expect(saved.mediaType).toBe("video/mp4");
    expect(calls.filter((call) => call === "blob.append")).toHaveLength(2);
    const loaded = await readBlob(host, saved.id);
    expect(Buffer.compare(Buffer.from(loaded), video)).toBe(0);
  });
});
