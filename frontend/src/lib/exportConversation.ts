import { toast } from '@/components/ui/toast';

import { conversationApi } from '@/features/conversation/conversationApi';
import i18n from '@/i18n';
import { saveTextFile } from '@/lib/saveTextFile';

export function conversationExportFileStem(name: string): string {
  const cleaned = name
    .trim()
    .replace(/[/\\:*?"<>|]+/g, '_')
    .replace(/\s+/g, '_')
    .slice(0, 80);
  return cleaned || 'conversation';
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
    const filename = `${conversationExportFileStem(title)}.${ext}`;
    const saved = await saveTextFile({
      filename,
      content,
      mime: format === 'markdown' ? 'text/markdown' : 'text/html',
      filterName: format === 'markdown' ? 'Markdown' : 'HTML',
      extension: ext,
    });
    if (!saved) return;
    toast.success(i18n.t('app:exportConversation.success'));
  } catch (error) {
    toast.error(i18n.t('app:exportConversation.failed', { error }));
  }
}
