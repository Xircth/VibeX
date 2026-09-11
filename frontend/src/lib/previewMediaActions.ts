import { toast } from '@/components/ui/toast';
import i18n from '@/i18n';
import { conversationExportFileStem } from '@/lib/exportConversation';
import { getBackendTransport } from '@/lib/transport';
import { writeClipboardViaBridge } from '@/vscode/bridge';

async function blobFromSrc(src: string): Promise<Blob> {
  const response = await fetch(src);
  if (!response.ok) {
    throw new Error(`HTTP ${response.status}`);
  }
  return response.blob();
}

export async function copyImageFromSrc(src: string, fallbackPath?: string) {
  try {
    const blob = await blobFromSrc(src);
    if (typeof ClipboardItem !== 'undefined' && navigator.clipboard?.write) {
      await navigator.clipboard.write([
        new ClipboardItem({ [blob.type || 'image/png']: blob }),
      ]);
      toast.success(i18n.t('common:contextMenu.copied'));
      return;
    }
  } catch {
    // Fall through to path copy.
  }
  if (fallbackPath) {
    const copied = await writeClipboardViaBridge(fallbackPath);
    if (copied) {
      toast.success(i18n.t('common:contextMenu.copied'));
      return;
    }
  }
  toast.error(i18n.t('common:contextMenu.copyFailed', { error: 'image' }));
}

export async function saveImageFromSrc(src: string, filename: string) {
  try {
    const blob = await blobFromSrc(src);
    const stem = conversationExportFileStem(filename);
    const ext = blob.type.includes('jpeg')
      ? 'jpg'
      : blob.type.includes('webp')
        ? 'webp'
        : blob.type.includes('gif')
          ? 'gif'
          : 'png';
    const transport = getBackendTransport();
    if (transport.environment === 'desktop') {
      const { save } = await import('@tauri-apps/plugin-dialog');
      const { writeFile } = await import('@tauri-apps/plugin-fs');
      const path = await save({
        defaultPath: `${stem}.${ext}`,
        filters: [{ name: 'Image', extensions: [ext] }],
      });
      if (!path) return;
      await writeFile(path, new Uint8Array(await blob.arrayBuffer()));
      toast.success(i18n.t('common:contextMenu.saved'));
      return;
    }
    const url = URL.createObjectURL(blob);
    const anchor = document.createElement('a');
    anchor.href = url;
    anchor.download = `${stem}.${ext}`;
    document.body.append(anchor);
    anchor.click();
    anchor.remove();
    URL.revokeObjectURL(url);
    toast.success(i18n.t('common:contextMenu.saved'));
  } catch (error) {
    toast.error(i18n.t('common:contextMenu.copyFailed', { error }));
  }
}
