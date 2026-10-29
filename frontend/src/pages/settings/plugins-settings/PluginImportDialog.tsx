import {
  AlertTriangle,
  Archive,
  CheckCircle2,
  Command,
  Loader2,
} from 'lucide-react';
import { useTranslation } from 'react-i18next';

import { Button } from '@/components/ui/button';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import type {
  PluginCliImportResult,
  PluginImportPackageKind,
  PluginImportPreview,
} from '@/lib/api/plugins';
import { cn } from '@/lib/utils';
import { PLUGIN_TABS, type PluginEcosystem } from './pluginConstants';

export function PluginImportDialog({
  ecosystem,
  importChooserOpen,
  setImportChooserOpen,
  importEcosystem,
  selectImportEcosystem,
  chooseZipImport,
  busy,
  canUseCliImport,
  cliCommand,
  setCliCommand,
  cliImportStatus,
  runCliImport,
  cliLogs,
  cliImportResult,
  cliImportError,
  importPreview,
  setImportPreview,
  applyImport,
}: {
  ecosystem?: PluginEcosystem;
  importChooserOpen: boolean;
  setImportChooserOpen: (open: boolean) => void;
  importEcosystem: PluginEcosystem;
  selectImportEcosystem: (ecosystem: PluginEcosystem) => void;
  chooseZipImport: (packageKind: PluginImportPackageKind) => Promise<void>;
  busy: boolean;
  canUseCliImport: boolean;
  cliCommand: string;
  setCliCommand: (value: string) => void;
  cliImportStatus: 'idle' | 'running' | 'succeeded' | 'failed';
  runCliImport: () => Promise<void>;
  cliLogs: string[];
  cliImportResult: PluginCliImportResult | null;
  cliImportError: string | null;
  importPreview: PluginImportPreview | null;
  setImportPreview: (preview: PluginImportPreview | null) => void;
  applyImport: (decision: 'reject' | 'keep' | 'replace') => Promise<void>;
}) {
  const { t } = useTranslation(['settings', 'common']);

  return (
    <>
      <Dialog
        open={importChooserOpen}
        onOpenChange={(open) => {
          if (!open && cliImportStatus === 'running') return;
          setImportChooserOpen(open);
        }}
        aria-labelledby="plugin-import-ecosystem-title"
      >
        <DialogContent className="max-w-xl">
          <DialogHeader>
            <DialogTitle id="plugin-import-ecosystem-title">
              {t('plugins.importEcosystemTitle')}
            </DialogTitle>
            <DialogDescription>
              {t('plugins.importEcosystemDescription')}
            </DialogDescription>
          </DialogHeader>
          {!ecosystem ? (
            <div
              className="plugin-import-ecosystem-tabs"
              aria-label={t('plugins.importEcosystemAria')}
            >
              {PLUGIN_TABS.map((candidate) => (
                <button
                  key={candidate.id}
                  type="button"
                  aria-pressed={importEcosystem === candidate.id}
                  className={cn(
                    importEcosystem === candidate.id && 'is-active'
                  )}
                  onClick={() => selectImportEcosystem(candidate.id)}
                >
                  {candidate.label}
                </button>
              ))}
            </div>
          ) : null}

          <div className="plugin-import-methods">
            {importEcosystem === 'codex' ? (
              <div className="plugin-import-method-row">
                <Archive aria-hidden="true" />
                <div>
                  <strong>{t('plugins.codexSkillsZipTitle')}</strong>
                  <p>{t('plugins.codexZipDescription')}</p>
                </div>
                <Button
                  size="sm"
                  onClick={() => void chooseZipImport('codex')}
                  disabled={busy}
                >
                  {t('plugins.chooseZip')}
                </Button>
              </div>
            ) : null}

            {importEcosystem !== 'vibex' && canUseCliImport ? (
              <div className="plugin-cli-import">
                <div className="plugin-cli-import-heading">
                  <Command aria-hidden="true" />
                  <div>
                    <strong>{t('plugins.marketplaceMethod')}</strong>
                    <p>
                      {t(
                        importEcosystem === 'codex'
                          ? 'plugins.codexCliDescription'
                          : 'plugins.claudeCliDescription'
                      )}
                    </p>
                  </div>
                </div>
                <label className="plugin-cli-command-field">
                  <span>
                    {t('plugins.cliCommandLabel', {
                      ecosystem:
                        importEcosystem === 'codex' ? 'Codex' : 'Claude Code',
                    })}
                  </span>
                  <textarea
                    value={cliCommand}
                    disabled={cliImportStatus === 'running'}
                    onChange={(event) => setCliCommand(event.target.value)}
                    placeholder={t(
                      importEcosystem === 'codex'
                        ? 'plugins.codexCliPlaceholder'
                        : 'plugins.claudeCliPlaceholder'
                    )}
                    aria-label={t('plugins.cliCommandLabel', {
                      ecosystem:
                        importEcosystem === 'codex' ? 'Codex' : 'Claude Code',
                    })}
                  />
                </label>
                <div className="plugin-cli-import-actions">
                  <Button
                    size="sm"
                    disabled={
                      cliImportStatus === 'running' || !cliCommand.trim()
                    }
                    onClick={() => void runCliImport()}
                  >
                    {cliImportStatus === 'running' ? (
                      <Loader2 className="mr-1.5 h-3.5 w-3.5 animate-spin" />
                    ) : null}
                    {cliImportStatus === 'running'
                      ? t('plugins.cliImportRunning')
                      : t('plugins.runCliImport')}
                  </Button>
                </div>

                {cliImportStatus !== 'idle' ? (
                  <div className="plugin-cli-output">
                    <strong>{t('plugins.cliLogTitle')}</strong>
                    <pre role="log" aria-live="polite">
                      {cliLogs.join('\n')}
                    </pre>
                  </div>
                ) : null}

                {cliImportStatus === 'succeeded' && cliImportResult ? (
                  <div className="plugin-cli-result is-success" role="status">
                    <CheckCircle2 aria-hidden="true" />
                    <div>
                      <strong>{t('plugins.cliImportSuccess')}</strong>
                      {cliImportResult.importedPluginIds.length ? (
                        <ul>
                          {cliImportResult.importedPluginIds.map((pluginId) => (
                            <li key={pluginId}>{pluginId}</li>
                          ))}
                        </ul>
                      ) : (
                        <p>{t('plugins.cliImportNoNewPlugins')}</p>
                      )}
                    </div>
                  </div>
                ) : null}

                {cliImportStatus === 'failed' && cliImportError ? (
                  <div className="plugin-cli-result is-error" role="alert">
                    <AlertTriangle aria-hidden="true" />
                    <div>
                      <strong>{t('plugins.cliImportFailed')}</strong>
                      <p>{cliImportError}</p>
                    </div>
                  </div>
                ) : null}
              </div>
            ) : null}

            {importEcosystem === 'vibex' ? (
              <div className="plugin-import-method-row">
                <Archive aria-hidden="true" />
                <div>
                  <strong>{t('plugins.vibexZipTitle')}</strong>
                  <p>{t('plugins.vibexZipDescription')}</p>
                </div>
                <Button
                  size="sm"
                  onClick={() => void chooseZipImport('vibex')}
                  disabled={busy}
                >
                  {t('plugins.chooseZip')}
                </Button>
              </div>
            ) : null}
          </div>
        </DialogContent>
      </Dialog>

      <Dialog
        open={Boolean(importPreview)}
        onOpenChange={(open) => !open && setImportPreview(null)}
        aria-labelledby="plugin-import-title"
      >
        <DialogContent className="max-w-lg">
          <DialogHeader>
            <DialogTitle id="plugin-import-title">
              {t('plugins.importTitle', {
                name: importPreview?.plugin.name ?? '',
              })}
            </DialogTitle>
            <DialogDescription>
              {t('plugins.importDescription')}
            </DialogDescription>
          </DialogHeader>
          {importPreview ? (
            <div className="space-y-3 text-xs">
              <div className="plugin-import-summary">
                <strong>{importPreview.plugin.id}</strong>
                <span>v{importPreview.plugin.version}</span>
                <span>{importPreview.plugin.skills.length} Skills</span>
              </div>
              {importPreview.conflict ? (
                <div className="plugin-import-conflict" role="alert">
                  <AlertTriangle aria-hidden="true" />
                  <div>
                    <strong>{t('plugins.sameIdConflict')}</strong>
                    <p>{t('plugins.sameIdConflictDescription')}</p>
                    <code>{importPreview.conflict.installedSource}</code>
                  </div>
                </div>
              ) : null}
            </div>
          ) : null}
          <DialogFooter>
            <Button
              variant="outline"
              onClick={() => setImportPreview(null)}
              disabled={busy}
            >
              {t('common:cancel')}
            </Button>
            {importPreview?.conflict ? (
              <>
                <Button
                  variant="outline"
                  onClick={() => void applyImport('keep')}
                  disabled={busy}
                >
                  {t('plugins.keepInstalled')}
                </Button>
                <Button
                  onClick={() => void applyImport('replace')}
                  disabled={busy}
                >
                  {t('plugins.replaceInstall')}
                </Button>
              </>
            ) : (
              <Button
                onClick={() => void applyImport('reject')}
                disabled={busy}
              >
                {t('plugins.import')}
              </Button>
            )}
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </>
  );
}
