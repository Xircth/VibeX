/**
 * Metadata for an image uploaded through the composer (`.vibe-images/` paths),
 * used to render uploaded images before they are saved.
 */
export type LocalImageMetadata = {
  path: string; // ".vibe-images/uuid.png"
  proxy_url: string; // "/api/images/{id}/file"
  file_name: string;
  size_bytes: number;
  format: string;
};
