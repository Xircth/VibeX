import { toast } from '@/components/ui/toast';
import { conversationApi } from '@/features/conversation/conversationApi';
import i18n from '@/i18n';
import { writeClipboardViaBridge } from '@/vscode/bridge';

export async function copyConversationMarkdown(
  conversationId: string
): Promise<void> {
  try {
    const content = await conversationApi.exportMarkdown(conversationId);
    const copied = await writeClipboardViaBridge(content);
    if (!copied) {
      throw new Error('clipboard unavailable');
    }
    toast.success(i18n.t('common:contextMenu.copied'));
  } catch (error) {
    toast.error(i18n.t('common:contextMenu.copyFailed', { error }));
  }
}
