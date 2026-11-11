import { getBackendTransport } from '@/lib/transport';

export interface SaveTextFileOptions {
  readonly filename: string;
  readonly content: string;
  readonly mime: string;
  readonly filterName: string;
  readonly extension: string;
}

function downloadTextFile({ filename, content, mime }: SaveTextFileOptions) {
  const blob = new Blob([content], { type: `${mime};charset=utf-8` });
  const url = URL.createObjectURL(blob);
  const anchor = document.createElement('a');
  anchor.href = url;
  anchor.download = filename;
  anchor.rel = 'noopener';
  document.body.append(anchor);
  anchor.click();
  anchor.remove();
  URL.revokeObjectURL(url);
}

/** Native save dialog on desktop, a download in the browser. Resolves false
 * when the user cancels the dialog. */
export async function saveTextFile(
  options: SaveTextFileOptions
): Promise<boolean> {
  if (getBackendTransport().environment !== 'desktop') {
    downloadTextFile(options);
    return true;
  }
  const { save } = await import('@tauri-apps/plugin-dialog');
  const { writeTextFile } = await import('@tauri-apps/plugin-fs');
  const path = await save({
    defaultPath: options.filename,
    filters: [{ name: options.filterName, extensions: [options.extension] }],
  });
  if (!path) return false;
  await writeTextFile(path, options.content);
  return true;
}
