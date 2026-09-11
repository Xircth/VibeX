import { toast } from '@/components/ui/toast';
import { conversationApi } from '@/features/conversation/conversationApi';
import i18n from '@/i18n';
import { conversationExportFileStem } from '@/lib/exportConversation';
import { pickHostDirectory } from '@/lib/hostFs';
import { getBackendTransport } from '@/lib/transport';

export type ProjectConversationPackEntry = {
  id: string;
  title: string;
};

async function downloadMarkdown(filename: string, content: string) {
  const blob = new Blob([content], { type: 'text/markdown;charset=utf-8' });
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

export async function exportProjectConversationPack(
  sessions: ProjectConversationPackEntry[]
): Promise<void> {
  if (sessions.length === 0) {
    toast.error(i18n.t('common:contextMenu.packEmpty'));
    return;
  }

  const transport = getBackendTransport();
  const directory =
    transport.environment === 'desktop'
      ? await pickHostDirectory({
          title: i18n.t('common:contextMenu.exportProjectPack'),
        })
      : null;
  if (transport.environment === 'desktop' && !directory) {
    return;
  }

  let failed = 0;
  let written = 0;
  const usedNames = new Set<string>();

  for (const session of sessions) {
    try {
      const content = await conversationApi.exportMarkdown(session.id);
      const stem = conversationExportFileStem(session.title);
      let filename = `${stem}.md`;
      let suffix = 1;
      while (usedNames.has(filename.toLowerCase())) {
        suffix += 1;
        filename = `${stem}_${suffix}.md`;
      }
      usedNames.add(filename.toLowerCase());

      if (directory) {
        const { writeTextFile } = await import('@tauri-apps/plugin-fs');
        const { join } = await import('@tauri-apps/api/path');
        await writeTextFile(await join(directory, filename), content);
      } else {
        downloadMarkdown(filename, content);
      }
      written += 1;
    } catch {
      failed += 1;
    }
  }

  if (written === 0) {
    toast.error(i18n.t('common:contextMenu.packEmpty'));
    return;
  }
  if (failed > 0) {
    toast.error(
      i18n.t('common:contextMenu.packPartial', { ok: written, failed })
    );
    return;
  }
  toast.success(i18n.t('common:contextMenu.packSuccess'));
}
