import { save } from '@tauri-apps/plugin-dialog';
import { writeTextFile } from '@tauri-apps/plugin-fs';
import { toast } from 'sonner';

import { conversationApi } from '@/features/conversation/conversationApi';
import i18n from '@/i18n';

/** Sanitize a conversation title into a safe file stem. */
function fileStem(name: string): string {
  const cleaned = name
    .trim()
    .replace(/[/\\:*?"<>|]+/g, '_')
    .replace(/\s+/g, '_')
    .slice(0, 80);
  return cleaned || 'conversation';
}

/**
 * Render a conversation to Markdown/HTML on the backend, then prompt for a save
 * location and write the file. Surfaces success/failure via toast.
 */
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
    const path = await save({
      defaultPath: `${fileStem(title)}.${ext}`,
      filters: [{ name: format === 'markdown' ? 'Markdown' : 'HTML', extensions: [ext] }],
    });
    if (!path) return;
    await writeTextFile(path, content);
    toast.success(i18n.t('app:exportConversation.success'));
  } catch (error) {
    toast.error(i18n.t('app:exportConversation.failed', { error }));
  }
}
