import { toast } from '@/components/ui/toast';

import { conversationApi } from '@/features/conversation/conversationApi';
import i18n from '@/i18n';
import { getBackendTransport } from '@/lib/transport';

function fileStem(name: string): string {
  const cleaned = name
    .trim()
    .replace(/[/\\:*?"<>|]+/g, '_')
    .replace(/\s+/g, '_')
    .slice(0, 80);
  return cleaned || 'conversation';
}

function downloadTextFile(
  filename: string,
  content: string,
  mime: string
): void {
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

export async function exportConversation(
  conversationId: string,
  format: 'markdown' | 'html',
  title = 'conversation'
): Promise<void> {
  try {
    const content =
      format === 'markdown'
        ? await conversationApi.exportMarkdown(conversationId)
        : await conversationApi.exportHtml(conversationId);
    const ext = format === 'markdown' ? 'md' : 'html';
    const filename = `${fileStem(title)}.${ext}`;
    const mime = format === 'markdown' ? 'text/markdown' : 'text/html';
    const transport = getBackendTransport();
    if (transport.environment === 'desktop') {
      const { save } = await import('@tauri-apps/plugin-dialog');
      const { writeTextFile } = await import('@tauri-apps/plugin-fs');
      const path = await save({
        defaultPath: filename,
        filters: [
          {
            name: format === 'markdown' ? 'Markdown' : 'HTML',
            extensions: [ext],
          },
        ],
      });
      if (!path) return;
      await writeTextFile(path, content);
    } else {
      downloadTextFile(filename, content, mime);
    }
    toast.success(i18n.t('app:exportConversation.success'));
  } catch (error) {
    toast.error(i18n.t('app:exportConversation.failed', { error }));
  }
}
