import { useEffect, useState } from 'react';
import { createPortal } from 'react-dom';
import { useTranslation } from 'react-i18next';
import {
  SegmentedControl,
  SegmentedControlItem,
} from '@astryxdesign/core/SegmentedControl';
import { TextInput } from '@astryxdesign/core/TextInput';
import { Download, Upload, X } from 'lucide-react';
import { toast } from '@/components/ui/toast';
import { Button } from '@/components/ui/button';
import { Label } from '@/components/ui/label';
import { Textarea } from '@/components/ui/textarea';
import { conversationApi } from './conversationApi';
import type { ConversationBundlePayload } from 'shared/types';

export interface ConversationBundlePanelProps {
  /** When true, renders the controls directly inline without a modal wrapper. */
  inlineMode?: boolean;
}

export function ConversationBundlePanel({
  inlineMode = false,
}: ConversationBundlePanelProps = {}) {
  const { t, i18n } = useTranslation(['conversation', 'common']);
  const [conversationId, setConversationId] = useState('');
  const [workspaceId, setWorkspaceId] = useState('');
  const [destinationPath, setDestinationPath] = useState('');
  const [bundleText, setBundleText] = useState('');
  const [busy, setBusy] = useState(false);
  const [dialogOpen, setDialogOpen] = useState(false);
  const [activeTab, setActiveTab] = useState<'export' | 'import'>('export');
  const [dialogLeft, setDialogLeft] = useState(0);
  const [portalContainer, setPortalContainer] = useState<HTMLElement | null>(
    null
  );

  useEffect(() => {
    if (!dialogOpen || typeof document === 'undefined') return;
    const settingsPage = document.querySelector<HTMLElement>('.settings-page');
    setPortalContainer(settingsPage ?? document.body);
    const updateLeft = () => {
      const mainRegion = document.querySelector<HTMLElement>('.settings-main');
      const leftOffset = mainRegion
        ? Math.max(0, Math.round(mainRegion.getBoundingClientRect().left))
        : 0;
      setDialogLeft(leftOffset);
    };
    updateLeft();
    window.addEventListener('resize', updateLeft);
    return () => window.removeEventListener('resize', updateLeft);
  }, [dialogOpen]);

  const openModal = (tab: 'export' | 'import') => {
    setActiveTab(tab);
    setDialogOpen(true);
  };

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

  if (inlineMode) {
    return (
      <section
        className="conversation-bundle-panel"
        aria-labelledby="conversation-bundle-title"
      >
        <div className="flex flex-wrap items-baseline justify-between gap-2">
          <div id="conversation-bundle-title" className="text-xs font-semibold">
            {t('bundle.title')}
          </div>
          <p className="settings-row__description !mt-0">
            {t('bundle.description')}
          </p>
        </div>

        <div className="space-y-2">
          <fieldset
            aria-label={t('bundle.exportGroupTitle')}
            className="settings-row min-w-0 border-0 p-0"
          >
            <Label className="shrink-0 text-sm">
              {t('bundle.exportGroupTitle')}
            </Label>
            <div className="flex min-w-0 flex-wrap items-center justify-end gap-2">
              <TextInput
                label={t('bundle.conversationIdPlaceholder')}
                isLabelHidden
                value={conversationId}
                placeholder={t('bundle.conversationIdPlaceholder')}
                onChange={setConversationId}
                isDisabled={busy}
                width="152px"
                className="w-[152px] [&_input]:text-xs"
              />
              <TextInput
                label={t('bundle.destinationPathPlaceholder')}
                isLabelHidden
                value={destinationPath}
                placeholder={t('bundle.destinationPathPlaceholder')}
                onChange={setDestinationPath}
                isDisabled={busy}
                width="184px"
                className="w-[184px] [&_input]:text-xs"
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

          <fieldset
            aria-label={t('bundle.importGroupTitle')}
            className="settings-row min-w-0 border-0 p-0"
          >
            <Label className="shrink-0 text-sm">
              {t('bundle.importGroupTitle')}
            </Label>
            <div className="flex min-w-0 flex-wrap items-center justify-end gap-2">
              <TextInput
                label={t('bundle.workspaceIdPlaceholder')}
                isLabelHidden
                value={workspaceId}
                placeholder={t('bundle.workspaceIdPlaceholder')}
                onChange={setWorkspaceId}
                isDisabled={busy}
                width="376px"
                className="w-[376px] max-w-full [&_input]:text-xs"
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

          <div className="settings-row">
            <Label
              htmlFor="conversation-bundle-json"
              className="shrink-0 text-sm"
            >
              {t('bundle.jsonLabel')}
            </Label>
            <Textarea
              id="conversation-bundle-json"
              rows={1}
              value={bundleText}
              placeholder={t('bundle.textareaPlaceholder')}
              onChange={(event) => setBundleText(event.target.value)}
              disabled={busy}
              className="conversation-bundle-textarea w-[452px] max-w-full font-mono text-xs"
            />
          </div>
        </div>
      </section>
    );
  }

  return (
    <section
      className="conversation-bundle-panel"
      aria-labelledby="conversation-bundle-title"
    >
      <div className="settings-row">
        <div>
          <Label id="conversation-bundle-title" className="text-sm">
            {t('bundle.title')}
          </Label>
          <p className="settings-row__description">{t('bundle.description')}</p>
        </div>
        <div className="flex shrink-0 items-center gap-2">
          <Button
            type="button"
            variant="outline"
            onClick={() => openModal('export')}
          >
            <Download className="mr-1 h-3.5 w-3.5" />
            {t('bundle.exportGroupTitle')}
          </Button>
          <Button
            type="button"
            variant="outline"
            onClick={() => openModal('import')}
          >
            <Upload className="mr-1 h-3.5 w-3.5" />
            {t('bundle.importGroupTitle')}
          </Button>
        </div>
      </div>

      {dialogOpen
        ? createPortal(
            <div
              data-testid="conversation-bundle-modal-overlay"
              className="collaboration-thread-overlay collaboration-settings-modal-overlay fixed inset-y-0 right-0 z-[9999] flex items-center justify-center p-6"
              style={{
                left: dialogLeft,
                backdropFilter: 'blur(16px)',
                WebkitBackdropFilter: 'blur(16px)',
              }}
              onMouseDown={(event) => {
                if (event.target === event.currentTarget) {
                  setDialogOpen(false);
                }
              }}
            >
              <div
                role="dialog"
                aria-modal="true"
                aria-label={t('bundle.title')}
                className="dialog-surface relative flex max-h-[calc(100dvh-3rem)] w-full max-w-[460px] flex-col overflow-y-auto rounded-xl border border-border/70 p-4 shadow-xl"
              >
                <div className="mb-3 flex items-center justify-between gap-2">
                  <h3 className="text-[14px] font-semibold text-foreground">
                    {t('bundle.title')}
                  </h3>
                  <Button
                    type="button"
                    variant="icon"
                    size="icon"
                    className="collaboration-expand h-7 w-7"
                    aria-label={i18n.t('panels:tabCreation.close', '关闭')}
                    onClick={() => setDialogOpen(false)}
                  >
                    <X className="h-4 w-4" aria-hidden="true" />
                  </Button>
                </div>

                <div className="flex flex-col gap-3.5">
                  <SegmentedControl
                    value={activeTab}
                    onChange={(val) =>
                      setActiveTab(val === 'import' ? 'import' : 'export')
                    }
                    label={t('bundle.title')}
                    size="sm"
                    layout="fill"
                  >
                    <SegmentedControlItem
                      value="export"
                      label={t('bundle.exportGroupTitle')}
                    />
                    <SegmentedControlItem
                      value="import"
                      label={t('bundle.importGroupTitle')}
                    />
                  </SegmentedControl>

                  {activeTab === 'export' ? (
                    <fieldset
                      aria-label={t('bundle.exportGroupTitle')}
                      className="flex flex-col gap-3 border-0 p-0"
                    >
                      <div className="space-y-1.5">
                        <Label>{t('bundle.conversationIdPlaceholder')}</Label>
                        <TextInput
                          label={t('bundle.conversationIdPlaceholder')}
                          isLabelHidden
                          value={conversationId}
                          placeholder={t('bundle.conversationIdPlaceholder')}
                          onChange={setConversationId}
                          isDisabled={busy}
                          width="100%"
                          className="[&_input]:text-xs"
                        />
                      </div>
                      <div className="space-y-1.5">
                        <Label>{t('bundle.destinationPathPlaceholder')}</Label>
                        <TextInput
                          label={t('bundle.destinationPathPlaceholder')}
                          isLabelHidden
                          value={destinationPath}
                          placeholder={t('bundle.destinationPathPlaceholder')}
                          onChange={setDestinationPath}
                          isDisabled={busy}
                          width="100%"
                          className="[&_input]:text-xs"
                        />
                      </div>
                      <div className="flex justify-end">
                        <Button
                          type="button"
                          variant="primary"
                          onClick={() => void exportBundle()}
                          disabled={busy}
                        >
                          <Download className="mr-1 h-3.5 w-3.5" />
                          {t('bundle.exportButton')}
                        </Button>
                      </div>
                    </fieldset>
                  ) : (
                    <fieldset
                      aria-label={t('bundle.importGroupTitle')}
                      className="flex flex-col gap-3 border-0 p-0"
                    >
                      <div className="space-y-1.5">
                        <Label>{t('bundle.workspaceIdPlaceholder')}</Label>
                        <TextInput
                          label={t('bundle.workspaceIdPlaceholder')}
                          isLabelHidden
                          value={workspaceId}
                          placeholder={t('bundle.workspaceIdPlaceholder')}
                          onChange={setWorkspaceId}
                          isDisabled={busy}
                          width="100%"
                          className="[&_input]:text-xs"
                        />
                      </div>
                      <div className="flex justify-end">
                        <Button
                          type="button"
                          variant="primary"
                          onClick={() => void importBundle()}
                          disabled={busy || !bundleText.trim()}
                        >
                          <Upload className="mr-1 h-3.5 w-3.5" />
                          {t('bundle.importButton')}
                        </Button>
                      </div>
                    </fieldset>
                  )}

                  <div className="space-y-1.5">
                    <Label htmlFor="conversation-bundle-json">
                      {t('bundle.jsonLabel')}
                    </Label>
                    <Textarea
                      id="conversation-bundle-json"
                      rows={5}
                      value={bundleText}
                      placeholder={t('bundle.textareaPlaceholder')}
                      onChange={(event) => setBundleText(event.target.value)}
                      disabled={busy}
                      className="conversation-bundle-textarea min-h-28 w-full font-mono text-xs"
                    />
                  </div>
                </div>
              </div>
            </div>,
            portalContainer ?? document.body
          )
        : null}
    </section>
  );
}
