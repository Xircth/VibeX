/** One `blob.append` / `blob.read` payload. It fits in the smallest 1 MiB frame. */
export const BLOB_CHUNK_BYTES = 512 * 1024;
/** A single video or other blob. JSON messages stay capped separately. */
export const BLOB_MAX_BYTES = 4 * 1024 * 1024 * 1024;
export async function writeBlob(host, data, options = {}) {
    const created = await host.call("blob", "create", {
        mediaType: options.mediaType ?? "application/octet-stream",
        name: options.name ?? null,
    });
    for (let offset = 0; offset < data.byteLength; offset += BLOB_CHUNK_BYTES) {
        const slice = data.subarray(offset, offset + BLOB_CHUNK_BYTES);
        await host.call("blob", "append", {
            id: created.id,
            data: Buffer.from(slice).toString("base64"),
        });
    }
    return host.call("blob", "finish", { id: created.id });
}
export async function readBlob(host, id) {
    const parts = [];
    let offset = 0;
    let byteLength = 0;
    do {
        const page = await host.call("blob", "read", { id, offset, length: BLOB_CHUNK_BYTES });
        byteLength = page.byteLength;
        const chunk = Buffer.from(page.data, "base64");
        if (chunk.byteLength === 0)
            break;
        parts.push(chunk);
        offset += chunk.byteLength;
    } while (offset < byteLength);
    return Buffer.concat(parts);
}
