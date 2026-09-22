import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Download, Upload } from 'lucide-react';
import { toast } from '@/components/ui/toast';
import { TextInput } from '@astryxdesign/core/TextInput';
import { Button } from '@/components/ui/button';
import { Label } from '@/components/ui/label';
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
      toast.error(
        error instanceof Error ? error.message : t('bundle.exportFailed')
      );
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
      const result = await conversationApi.import({
        workspaceId: workspace,
        bundle,
      });
      setConversationId(result.conversationId);
      toast.success(t('bundle.imported'));
    } catch (error) {
      toast.error(
        error instanceof Error ? error.message : t('bundle.importFailed')
      );
    } finally {
      setBusy(false);
    }
  };

  return (
    <section
      className="conversation-bundle-panel"
      aria-labelledby="conversation-bundle-title"
    >
      <div className="space-y-1">
        <div id="conversation-bundle-title" className="text-sm font-semibold">
          {t('bundle.title')}
        </div>
        <p className="settings-row__description">{t('bundle.description')}</p>
      </div>

      <div className="grid gap-4 lg:grid-cols-2">
        <fieldset className="min-w-0 space-y-2 border-0 p-0">
          <legend className="mb-2 text-sm font-medium text-foreground">
            {t('bundle.exportGroupTitle')}
          </legend>
          <TextInput
            label={t('bundle.conversationIdPlaceholder')}
            isLabelHidden
            value={conversationId}
            placeholder={t('bundle.conversationIdPlaceholder')}
            onChange={setConversationId}
            isDisabled={busy}
            width="100%"
            className="[&_input]:text-sm"
          />
          <div className="flex flex-col gap-2 sm:flex-row">
            <TextInput
              label={t('bundle.destinationPathPlaceholder')}
              isLabelHidden
              value={destinationPath}
              placeholder={t('bundle.destinationPathPlaceholder')}
              onChange={setDestinationPath}
              isDisabled={busy}
              width="100%"
              className="[&_input]:text-sm"
            />
            <Button
              className="shrink-0"
              onClick={() => void exportBundle()}
              disabled={busy}
            >
              <Download className="mr-1 h-3.5 w-3.5" />
              {t('bundle.exportButton')}
            </Button>
          </div>
        </fieldset>

        <fieldset className="min-w-0 space-y-2 border-0 p-0">
          <legend className="mb-2 text-sm font-medium text-foreground">
            {t('bundle.importGroupTitle')}
          </legend>
          <div className="flex flex-col gap-2 sm:flex-row">
            <TextInput
              label={t('bundle.workspaceIdPlaceholder')}
              isLabelHidden
              value={workspaceId}
              placeholder={t('bundle.workspaceIdPlaceholder')}
              onChange={setWorkspaceId}
              isDisabled={busy}
              width="100%"
              className="[&_input]:text-sm"
            />
            <Button
              variant="outline"
              className="shrink-0"
              onClick={() => void importBundle()}
              disabled={busy || !bundleText.trim()}
            >
              <Upload className="mr-1 h-3.5 w-3.5" />
              {t('bundle.importButton')}
            </Button>
          </div>
        </fieldset>
      </div>

      <div className="space-y-2">
        <Label htmlFor="conversation-bundle-json">
          {t('bundle.jsonLabel')}
        </Label>
        <Textarea
          id="conversation-bundle-json"
          value={bundleText}
          placeholder={t('bundle.textareaPlaceholder')}
          onChange={(event) => setBundleText(event.target.value)}
          disabled={busy}
          className="min-h-36 w-full font-mono text-xs"
        />
      </div>
    </section>
  );
}
