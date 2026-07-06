import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Download, Upload } from 'lucide-react';
import { toast } from 'sonner';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Textarea } from '@/components/ui/textarea';
import { conversationApi } from './conversationApi';
import type { ConversationBundlePayload } from 'shared/types';

export function ConversationBundlePanel() {
  const { t } = useTranslation(['conversation', 'common']);
  const [conversationId, setConversationId] = useState('');
  const [workspaceId, setWorkspaceId] = useState('');
  const [destinationPath, setDestinationPath] = useState('');
  const [bundleText, setBundleText] = useState('');
  const [busy, setBusy] = useState(false);

  const exportBundle = async () => {
    const id = conversationId.trim();
    if (!id) {
      toast.error(t('bundle.fillConversationId'));
      return;
    }
    setBusy(true);
    try {
      const result = await conversationApi.export({
        conversationId: id,
        destinationPath: destinationPath.trim() || null,
      });
      setBundleText(JSON.stringify(result.bundle, null, 2));
      toast.success(t('bundle.exported'));
    } catch (error) {
      toast.error(error instanceof Error ? error.message : t('bundle.exportFailed'));
    } finally {
      setBusy(false);
    }
  };

  const importBundle = async () => {
    const workspace = workspaceId.trim();
    if (!workspace) {
      toast.error(t('bundle.fillWorkspaceId'));
      return;
    }
    setBusy(true);
    try {
      const bundle = JSON.parse(bundleText) as ConversationBundlePayload;
      const result = await conversationApi.import({ workspaceId: workspace, bundle });
      setConversationId(result.conversationId);
      toast.success(t('bundle.imported'));
    } catch (error) {
      toast.error(error instanceof Error ? error.message : t('bundle.importFailed'));
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="settings-inline-group space-y-3 p-3">
      <div>
        <div className="text-xs font-semibold">{t('bundle.title')}</div>
        <div className="mt-1 text-[11px] text-muted-foreground">
          {t('bundle.description')}
        </div>
      </div>
      <div className="grid gap-2 md:grid-cols-2">
        <Input
          value={conversationId}
          placeholder={t('bundle.conversationIdPlaceholder')}
          onChange={(event) => setConversationId(event.target.value)}
          disabled={busy}
        />
        <Input
          value={destinationPath}
          placeholder={t('bundle.destinationPathPlaceholder')}
          onChange={(event) => setDestinationPath(event.target.value)}
          disabled={busy}
        />
      </div>
      <div className="flex gap-2">
        <Button
          size="sm"
          className="h-8 text-xs"
          onClick={() => void exportBundle()}
          disabled={busy}
        >
          <Download className="mr-1 h-3.5 w-3.5" />
          {t('bundle.exportButton')}
        </Button>
        <Input
          value={workspaceId}
          placeholder={t('bundle.workspaceIdPlaceholder')}
          onChange={(event) => setWorkspaceId(event.target.value)}
          disabled={busy}
        />
        <Button
          variant="outline"
          size="sm"
          className="h-8 shrink-0 text-xs"
          onClick={() => void importBundle()}
          disabled={busy || !bundleText.trim()}
        >
          <Upload className="mr-1 h-3.5 w-3.5" />
          {t('bundle.importButton')}
        </Button>
      </div>
      <Textarea
        value={bundleText}
        placeholder={t('bundle.textareaPlaceholder')}
        onChange={(event) => setBundleText(event.target.value)}
        disabled={busy}
        className="min-h-28 text-xs"
      />
    </div>
  );
}
