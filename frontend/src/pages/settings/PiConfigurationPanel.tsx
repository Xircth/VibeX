import {
  CheckCircle2,
  Cpu,
  Loader2,
  TerminalSquare,
  XCircle,
} from 'lucide-react';
import { useCallback, useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import type {
  PiCommandValidationView,
  PiConfigurationView,
  PiTrustEntryView,
} from 'shared/types';

import { Button } from '@/components/ui/button';
import { toast } from '@/components/ui/toast';
import {
  agentManagementApi,
  agentManagementErrorMessage as errorMessage,
} from '@/features/agent-management';

export function PiConfigurationPanel({
  disabled,
  onDirtyChange,
}: {
  disabled: boolean;
  onDirtyChange?: (dirty: boolean) => void;
}) {
  const { t } = useTranslation('settings');
  const [view, setView] = useState<PiConfigurationView | null>(null);
  const [loading, setLoading] = useState(false);
  const [savingRuntime, setSavingRuntime] = useState(false);
  const [validating, setValidating] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [mode, setMode] = useState('default');
  const [command, setCommand] = useState('');
  const [configDir, setConfigDir] = useState('');
  const [sessionDir, setSessionDir] = useState('');
  const [trustEntries, setTrustEntries] = useState<PiTrustEntryView[]>([]);
  const [validation, setValidation] = useState<PiCommandValidationView | null>(
    null
  );
  const [defaultRuntime, setDefaultRuntime] =
    useState<PiCommandValidationView | null>(null);

  const hydrate = (next: PiConfigurationView) => {
    setView(next);
    setMode(next.runtime.mode);
    setCommand(next.runtime.command);
    setConfigDir(next.runtime.config_dir);
    setSessionDir(next.runtime.session_dir);
  };

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const [configuration, runtime, entries] = await Promise.all([
        agentManagementApi.piConfiguration(),
        agentManagementApi.validatePiCommand('pi'),
        agentManagementApi.piTrustEntries(),
      ]);
      hydrate(configuration);
      setDefaultRuntime(runtime);
      setTrustEntries(entries);
    } catch (cause) {
      setError(errorMessage(cause, t('agents.piLoadFailed')));
    } finally {
      setLoading(false);
    }
  }, [t]);

  useEffect(() => {
    void load();
  }, [load]);

  const validateRuntime = async () => {
    if (!command.trim()) return;
    setValidating(true);
    setValidation(null);
    try {
      setValidation(await agentManagementApi.validatePiCommand(command.trim()));
    } catch (cause) {
      setError(errorMessage(cause, t('agents.piRuntimeValidateFailed')));
    } finally {
      setValidating(false);
    }
  };

  const saveRuntime = async () => {
    if (mode === 'custom' && !command.trim()) {
      toast.warning(t('agents.piRuntimeCommandRequired'));
      return;
    }
    setSavingRuntime(true);
    setError(null);
    try {
      await agentManagementApi.savePiRuntime({
        mode,
        command: command.trim(),
        config_dir: configDir.trim(),
        session_dir: sessionDir.trim(),
        trust_workspace: true,
      });
      const next = await agentManagementApi.piConfiguration();
      hydrate(next);
      toast.success(t('agents.piRuntimeSaved'));
    } catch (cause) {
      const message = errorMessage(cause, t('agents.piRuntimeSaveFailed'));
      setError(message);
      toast.error(message);
    } finally {
      setSavingRuntime(false);
    }
  };

  const revokeTrust = async (workspace: string) => {
    setSavingRuntime(true);
    setError(null);
    try {
      await agentManagementApi.setPiProjectTrust(workspace, null);
      setTrustEntries(await agentManagementApi.piTrustEntries());
      toast.success(t('agents.piProjectTrustRevoked'));
    } catch (cause) {
      const message = errorMessage(cause, t('agents.piProjectTrustLoadFailed'));
      setError(message);
      toast.error(message);
    } finally {
      setSavingRuntime(false);
    }
  };

  const runtimeDirty = Boolean(
    view &&
      (mode !== view.runtime.mode ||
        command !== view.runtime.command ||
        configDir !== view.runtime.config_dir ||
        sessionDir !== view.runtime.session_dir)
  );
  useEffect(() => {
    onDirtyChange?.(runtimeDirty);
    return () => onDirtyChange?.(false);
  }, [onDirtyChange, runtimeDirty]);
  const busy = disabled || savingRuntime;

  return (
    <div className="pi-configuration-panel">
      {loading ? (
        <p className="pi-configuration-state" aria-live="polite">
          <Loader2 aria-hidden="true" className="h-3.5 w-3.5 animate-spin" />
          {t('agents.piLoading')}
        </p>
      ) : error && !view ? (
        <p className="pi-configuration-error" role="alert">
          {error}
        </p>
      ) : view ? (
        <div className="pi-configuration-body">
          <section aria-labelledby="pi-runtime-heading">
            <div className="pi-configuration-heading">
              <Cpu aria-hidden="true" className="h-4 w-4" />
              <span>
                <strong id="pi-runtime-heading">Pi Runtime</strong>
              </span>
            </div>
            <fieldset className="pi-runtime-modes">
              <legend className="sr-only">{t('agents.piRuntimeMode')}</legend>
              <label data-selected={mode === 'default'}>
                <input
                  checked={mode === 'default'}
                  disabled={busy}
                  name="pi_runtime_mode"
                  type="radio"
                  value="default"
                  onChange={() => setMode('default')}
                />
                <span>
                  <strong>{t('agents.piDefaultRuntime')}</strong>
                  <small>
                    {defaultRuntime?.found
                      ? `${defaultRuntime.version ?? t('agents.installed')} · ${defaultRuntime.resolved_path ?? 'PATH'}`
                      : t('agents.piDefaultRuntimeMissing')}
                  </small>
                </span>
              </label>
              <label data-selected={mode === 'custom'}>
                <input
                  checked={mode === 'custom'}
                  disabled={busy}
                  name="pi_runtime_mode"
                  type="radio"
                  value="custom"
                  onChange={() => setMode('custom')}
                />
                <span>
                  <strong>{t('agents.piCustomRuntime')}</strong>
                </span>
              </label>
            </fieldset>

            {mode === 'custom' ? (
              <div className="pi-runtime-fields">
                <label className="pi-runtime-command">
                  {t('agents.executable')}
                  <span>
                    <input
                      autoComplete="off"
                      disabled={busy}
                      name="pi_runtime_command"
                      placeholder={t('agents.piCommandPlaceholder')}
                      spellCheck={false}
                      value={command}
                      onChange={(event) => {
                        setCommand(event.target.value);
                        setValidation(null);
                      }}
                    />
                    <Button
                      size="sm"
                      variant="outline"
                      disabled={busy || validating || !command.trim()}
                      onClick={() => void validateRuntime()}
                    >
                      {validating ? (
                        <Loader2
                          aria-hidden="true"
                          className="mr-2 h-3.5 w-3.5 animate-spin"
                        />
                      ) : (
                        <TerminalSquare
                          aria-hidden="true"
                          className="mr-2 h-3.5 w-3.5"
                        />
                      )}
                      {t('agents.validate')}
                    </Button>
                  </span>
                </label>
                {validation ? (
                  <p
                    className={
                      validation.found
                        ? 'pi-runtime-validation is-valid'
                        : 'pi-runtime-validation is-invalid'
                    }
                    role="status"
                  >
                    {validation.found ? (
                      <CheckCircle2
                        aria-hidden="true"
                        className="h-3.5 w-3.5"
                      />
                    ) : (
                      <XCircle aria-hidden="true" className="h-3.5 w-3.5" />
                    )}
                    {validation.found
                      ? `${validation.resolved_path}${validation.version ? ` · ${validation.version}` : ''}`
                      : t('agents.executableNotFound')}
                  </p>
                ) : null}
                <label>
                  {t('agents.piConfigDirectory')}
                  <input
                    autoComplete="off"
                    disabled={busy}
                    name="pi_config_directory"
                    placeholder="~/.pi/agent"
                    spellCheck={false}
                    value={configDir}
                    onChange={(event) => setConfigDir(event.target.value)}
                  />
                </label>
                <label>
                  {t('agents.piSessionDirectory')}
                  <input
                    autoComplete="off"
                    disabled={busy}
                    name="pi_session_directory"
                    spellCheck={false}
                    value={sessionDir}
                    onChange={(event) => setSessionDir(event.target.value)}
                  />
                </label>
              </div>
            ) : null}

            <div className="pi-configuration-actions">
              <Button
                size="sm"
                disabled={busy}
                onClick={() => void saveRuntime()}
              >
                {savingRuntime ? (
                  <Loader2
                    aria-hidden="true"
                    className="mr-2 h-3.5 w-3.5 animate-spin"
                  />
                ) : null}
                {t('agents.saveRuntime')}
              </Button>
            </div>
          </section>

          <section aria-labelledby="pi-trust-heading">
            <div className="pi-configuration-heading">
              <span>
                <strong id="pi-trust-heading">
                  {t('agents.piProjectTrustHeading')}
                </strong>
              </span>
            </div>
            {trustEntries.length === 0 ? (
              <p className="pi-configuration-state">
                {t('agents.piProjectTrustEmpty')}
              </p>
            ) : (
              <ul
                className="agent-model-provider-list pi-trust-entries"
                role="list"
              >
                {trustEntries.map((entry) => (
                  <li key={entry.path}>
                    <div>
                      <span className="pi-trust-path">{entry.path}</span>
                      {entry.trusted ? null : (
                        <span className="pi-trust-status">
                          {t('agents.piProjectTrustDenied')}
                        </span>
                      )}
                    </div>
                    <div>
                      <Button
                        size="sm"
                        variant="outline"
                        disabled={busy}
                        onClick={() => void revokeTrust(entry.path)}
                      >
                        {t('agents.piProjectTrustRevoke')}
                      </Button>
                    </div>
                  </li>
                ))}
              </ul>
            )}
          </section>
          {error ? (
            <p className="pi-configuration-error" role="alert">
              {error}
            </p>
          ) : null}
        </div>
      ) : null}
    </div>
  );
}
