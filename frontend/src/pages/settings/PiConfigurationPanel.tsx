import {
  CheckCircle2,
  Cpu,
  Eye,
  EyeOff,
  KeyRound,
  Loader2,
  TerminalSquare,
  XCircle,
} from 'lucide-react';
import { useCallback, useEffect, useMemo, useState } from 'react';
import { useTranslation } from 'react-i18next';
import type {
  PiCommandValidationView,
  PiConfigurationView,
  PiCustomProviderView,
  PiTrustEntryView,
} from 'shared/types';

import { Button } from '@/components/ui/button';
import { toast } from '@/components/ui/toast';
import {
  agentManagementApi,
  agentManagementErrorMessage as errorMessage,
} from '@/features/agent-management';
import {
  NO_PI_REASONING,
  PI_THINKING_LEVELS,
  isPiThinkingLevel,
  implicitWireValue,
  reasoningFromModel,
  reasoningToMap,
  toggleThinkingLevel,
  type PiModelReasoning,
  type PiThinkingLevel,
} from '@/lib/piThinking';
import { cn } from '@/lib/utils';

const PI_CUSTOM_SENTINEL = '__custom__';
const PI_BUILTIN_PROVIDERS: { id: string; label: string }[] = [
  { id: 'anthropic', label: 'Anthropic' },
  { id: 'openai', label: 'OpenAI' },
  { id: 'google', label: 'Google Gemini' },
  { id: 'openrouter', label: 'OpenRouter' },
  { id: 'vercel-ai-gateway', label: 'Vercel AI Gateway' },
  { id: 'xai', label: 'xAI' },
  { id: 'deepseek', label: 'DeepSeek' },
  { id: 'groq', label: 'Groq' },
  { id: 'cerebras', label: 'Cerebras' },
  { id: 'mistral', label: 'Mistral' },
  { id: 'nvidia', label: 'NVIDIA NIM' },
  { id: 'together', label: 'Together AI' },
  { id: 'fireworks', label: 'Fireworks' },
  { id: 'huggingface', label: 'Hugging Face' },
  { id: 'kimi-coding', label: 'Kimi For Coding' },
  { id: 'moonshotai', label: 'Moonshot AI' },
  { id: 'moonshotai-cn', label: 'Moonshot AI (China)' },
  { id: 'zai', label: 'Z.AI Coding Plan (Global)' },
  { id: 'zai-coding-cn', label: 'Z.AI Coding Plan (China)' },
  { id: 'minimax', label: 'MiniMax' },
  { id: 'minimax-cn', label: 'MiniMax (China)' },
  { id: 'ant-ling', label: 'Ant Ling' },
  { id: 'xiaomi', label: 'Xiaomi MiMo' },
  { id: 'xiaomi-token-plan-cn', label: 'Xiaomi MiMo Token Plan (China)' },
  { id: 'xiaomi-token-plan-ams', label: 'Xiaomi MiMo Token Plan (Amsterdam)' },
  { id: 'xiaomi-token-plan-sgp', label: 'Xiaomi MiMo Token Plan (Singapore)' },
  { id: 'opencode', label: 'OpenCode Zen' },
  { id: 'opencode-go', label: 'OpenCode Go' },
];
const PI_CUSTOM_API_PROTOCOLS = [
  'openai-completions',
  'openai-responses',
  'anthropic-messages',
  'google-generative-ai',
];

function storedReasoning(
  providers: PiCustomProviderView[],
  providerId: string,
  modelId: string
): PiModelReasoning {
  const stored = providers
    .find((provider) => provider.id === providerId)
    ?.models.find((entry) => entry.id === modelId);
  return reasoningFromModel(
    stored?.reasoning,
    stored?.thinking_level_map as
      | Partial<Record<PiThinkingLevel, string | null>>
      | undefined
  );
}

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
  const [savingCreds, setSavingCreds] = useState(false);
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
  const [selectedProvider, setSelectedProvider] = useState('');
  const [customId, setCustomId] = useState('');
  const [customBaseUrl, setCustomBaseUrl] = useState('');
  const [customApi, setCustomApi] = useState(PI_CUSTOM_API_PROTOCOLS[0]);
  const [model, setModel] = useState('');
  const [thinkingLevel, setThinkingLevel] = useState('');
  const [apiKey, setApiKey] = useState('');
  const [showKey, setShowKey] = useState(false);
  const [reasoning, setReasoning] = useState<PiModelReasoning>(NO_PI_REASONING);

  const isCustom = selectedProvider === PI_CUSTOM_SENTINEL;
  const effectiveProvider = (isCustom ? customId : selectedProvider).trim();

  const hydrate = (next: PiConfigurationView) => {
    setView(next);
    setMode(next.runtime.mode);
    setCommand(next.runtime.command);
    setConfigDir(next.runtime.config_dir);
    setSessionDir(next.runtime.session_dir);
    setModel(next.default_model);
    setThinkingLevel(next.thinking_level);
    setApiKey('');
    const matched = next.custom_providers.find(
      (provider) => provider.id === next.default_provider
    );
    if (matched) {
      setSelectedProvider(PI_CUSTOM_SENTINEL);
      setCustomId(matched.id);
      setCustomBaseUrl(matched.base_url);
      setCustomApi(matched.api || PI_CUSTOM_API_PROTOCOLS[0]);
      setReasoning(
        storedReasoning(next.custom_providers, matched.id, next.default_model)
      );
    } else {
      setSelectedProvider(next.default_provider);
      setCustomId('');
      setCustomBaseUrl('');
      setCustomApi(PI_CUSTOM_API_PROTOCOLS[0]);
      setReasoning(NO_PI_REASONING);
    }
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

  const customModelKey = isCustom
    ? `${effectiveProvider}\n${model.trim()}`
    : '';
  useEffect(() => {
    if (!view || !isCustom) return;
    setReasoning(
      storedReasoning(view.custom_providers, effectiveProvider, model.trim())
    );
  }, [customModelKey, effectiveProvider, isCustom, model, view]);

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

  const availableLevels: readonly PiThinkingLevel[] =
    isCustom && reasoning.enabled ? reasoning.levels : PI_THINKING_LEVELS;
  const defaultLevelUnlisted =
    isCustom &&
    reasoning.enabled &&
    thinkingLevel !== '' &&
    !reasoning.levels.includes(thinkingLevel as PiThinkingLevel);
  const effectiveThinkingLevel =
    isCustom && !reasoning.enabled ? 'off' : thinkingLevel;

  const saveCredentials = async () => {
    const trimmedModel = model.trim();
    if (
      !effectiveProvider ||
      !trimmedModel ||
      (isCustom && !customBaseUrl.trim())
    ) {
      toast.warning(t('agents.piProviderRequired'));
      return;
    }
    if (isCustom && reasoning.enabled && reasoning.levels.length === 0) {
      toast.warning(t('agents.piThinkingLevelsEmpty'));
      return;
    }
    if (defaultLevelUnlisted) {
      toast.warning(t('agents.piDefaultLevelUnlisted'));
      return;
    }
    setSavingCreds(true);
    setError(null);
    try {
      const next = await agentManagementApi.savePiCredentials({
        provider: effectiveProvider,
        model: trimmedModel,
        thinking_level: effectiveThinkingLevel || null,
        api_key: apiKey.trim() || null,
        custom_base_url: isCustom ? customBaseUrl.trim() : null,
        custom_api: isCustom ? customApi : null,
        model_reasoning: isCustom
          ? {
              reasoning: reasoning.enabled,
              thinking_level_map: reasoningToMap(reasoning),
            }
          : null,
      });
      hydrate(next);
      toast.success(t('agents.piProviderSaved'));
    } catch (cause) {
      const message = errorMessage(cause, t('agents.piProviderSaveFailed'));
      setError(message);
      toast.error(message);
    } finally {
      setSavingCreds(false);
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
  const savedReasoning = useMemo(() => {
    if (!view || !isCustom) return NO_PI_REASONING;
    return storedReasoning(
      view.custom_providers,
      effectiveProvider,
      model.trim()
    );
  }, [effectiveProvider, isCustom, model, view]);
  const credsDirty = Boolean(
    view &&
      (effectiveProvider !== view.default_provider ||
        model !== view.default_model ||
        effectiveThinkingLevel !== view.thinking_level ||
        apiKey.trim() !== '' ||
        (isCustom &&
          (customBaseUrl !==
            (view.custom_providers.find(
              (provider) => provider.id === effectiveProvider
            )?.base_url ?? '') ||
            customApi !==
              (view.custom_providers.find(
                (provider) => provider.id === effectiveProvider
              )?.api || PI_CUSTOM_API_PROTOCOLS[0]) ||
            JSON.stringify(reasoning) !== JSON.stringify(savedReasoning))))
  );
  useEffect(() => {
    onDirtyChange?.(runtimeDirty || credsDirty);
    return () => onDirtyChange?.(false);
  }, [credsDirty, onDirtyChange, runtimeDirty]);
  const busy = disabled || savingRuntime || savingCreds;

  const providerOptions =
    selectedProvider &&
    selectedProvider !== PI_CUSTOM_SENTINEL &&
    !PI_BUILTIN_PROVIDERS.some((provider) => provider.id === selectedProvider)
      ? [
          ...PI_BUILTIN_PROVIDERS,
          { id: selectedProvider, label: selectedProvider },
        ]
      : PI_BUILTIN_PROVIDERS;
  const providerHasKey =
    effectiveProvider !== '' &&
    Boolean(view?.auth_providers.includes(effectiveProvider));

  const handleProviderChange = (value: string) => {
    setSelectedProvider(value);
    if (value === PI_CUSTOM_SENTINEL && !customId.trim() && view) {
      const first = view.custom_providers[0];
      if (first) {
        setCustomId(first.id);
        setCustomBaseUrl(first.base_url);
        setCustomApi(first.api || PI_CUSTOM_API_PROTOCOLS[0]);
      }
    }
  };

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
              <span />
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

          <section aria-labelledby="pi-credentials-heading">
            <div className="pi-configuration-heading">
              <KeyRound aria-hidden="true" className="h-4 w-4" />
              <span>
                <strong id="pi-credentials-heading">
                  {t('agents.piProviderHeading')}
                </strong>
              </span>
            </div>
            <div className="pi-configuration-grid">
              <label>
                {t('agents.piProviderLabel')}
                <select
                  className="raised-control"
                  disabled={busy}
                  name="pi_provider"
                  value={selectedProvider}
                  onChange={(event) => handleProviderChange(event.target.value)}
                >
                  <option value="">{t('agents.selectPlaceholder')}</option>
                  <option value={PI_CUSTOM_SENTINEL}>
                    {t('agents.piCustomProvider')}
                  </option>
                  {providerOptions.map((provider) => (
                    <option key={provider.id} value={provider.id}>
                      {provider.label}
                    </option>
                  ))}
                </select>
              </label>
              <label>
                {t('agents.model')}
                <input
                  autoComplete="off"
                  disabled={busy}
                  name="pi_model"
                  placeholder="claude-sonnet-5"
                  spellCheck={false}
                  value={model}
                  onChange={(event) => setModel(event.target.value)}
                />
              </label>
            </div>
            {isCustom ? (
              <fieldset className="pi-custom-provider-fields">
                <legend>{t('agents.piCustomProvider')}</legend>
                <label>
                  {t('agents.piProviderId')}
                  <input
                    autoComplete="off"
                    disabled={busy}
                    name="pi_custom_provider_id"
                    placeholder="my-provider"
                    spellCheck={false}
                    value={customId}
                    onChange={(event) => setCustomId(event.target.value)}
                  />
                </label>
                <label>
                  {t('agents.customProviderProtocol')}
                  <select
                    className="raised-control"
                    disabled={busy}
                    name="pi_custom_api"
                    value={customApi}
                    onChange={(event) => setCustomApi(event.target.value)}
                  >
                    {PI_CUSTOM_API_PROTOCOLS.map((protocol) => (
                      <option key={protocol} value={protocol}>
                        {protocol}
                      </option>
                    ))}
                  </select>
                </label>
                <label className="pi-runtime-command">
                  {t('agents.piApiUrl')}
                  <input
                    autoComplete="off"
                    disabled={busy}
                    name="pi_custom_base_url"
                    placeholder="https://api.example.com/v1"
                    spellCheck={false}
                    type="url"
                    value={customBaseUrl}
                    onChange={(event) => setCustomBaseUrl(event.target.value)}
                  />
                </label>
              </fieldset>
            ) : null}
            {isCustom ? (
              <div className="pi-reasoning-card">
                <label className="pi-reasoning-enable">
                  <input
                    aria-label={t('agents.piReasoningEnable')}
                    checked={reasoning.enabled}
                    disabled={busy}
                    name="pi_reasoning_enabled"
                    type="checkbox"
                    onChange={(event) => {
                      const enabled = event.target.checked;
                      setReasoning((current) => ({
                        ...current,
                        enabled,
                        levels:
                          enabled && current.levels.length === 0
                            ? PI_THINKING_LEVELS.filter(
                                (level) => level !== 'xhigh'
                              )
                            : current.levels,
                      }));
                    }}
                  />
                  <span>{t('agents.piReasoningEnable')}</span>
                </label>
                {reasoning.enabled ? (
                  <>
                    <div
                      className="pi-thinking-levels"
                      role="group"
                      aria-label={t('agents.piThinkingLevels')}
                    >
                      {PI_THINKING_LEVELS.map((level) => {
                        const active = reasoning.levels.includes(level);
                        return (
                          <button
                            key={level}
                            type="button"
                            aria-pressed={active}
                            className={cn(
                              'pi-thinking-chip',
                              active && 'is-active'
                            )}
                            disabled={busy}
                            onClick={() =>
                              setReasoning((current) => ({
                                ...current,
                                levels: toggleThinkingLevel(
                                  current.levels,
                                  level
                                ),
                              }))
                            }
                          >
                            {level}
                          </button>
                        );
                      })}
                    </div>
                    {reasoning.levels.length === 0 ? (
                      <p className="pi-configuration-error" role="alert">
                        {t('agents.piThinkingLevelsEmpty')}
                      </p>
                    ) : (
                      <details className="pi-wire-values">
                        <summary>{t('agents.piWireValues')}</summary>
                        {reasoning.levels.map((level) => (
                          <label key={level}>
                            {level}
                            <input
                              autoComplete="off"
                              disabled={busy}
                              name={`pi_wire_${level}`}
                              placeholder={implicitWireValue(level)}
                              spellCheck={false}
                              value={reasoning.wireValues[level] ?? ''}
                              onChange={(event) =>
                                setReasoning((current) => ({
                                  ...current,
                                  wireValues: {
                                    ...current.wireValues,
                                    [level]: event.target.value,
                                  },
                                }))
                              }
                            />
                          </label>
                        ))}
                      </details>
                    )}
                  </>
                ) : null}
              </div>
            ) : null}
            <div className="pi-configuration-grid">
              <label>
                {t('agents.piThinkingLevel')}
                <select
                  className="raised-control"
                  disabled={busy || (isCustom && !reasoning.enabled)}
                  name="pi_thinking_level"
                  value={
                    isPiThinkingLevel(effectiveThinkingLevel)
                      ? effectiveThinkingLevel
                      : effectiveThinkingLevel || 'off'
                  }
                  onChange={(event) => setThinkingLevel(event.target.value)}
                >
                  {availableLevels.map((level) => (
                    <option key={level} value={level}>
                      {t(`agents.piThinking.${level}`)}
                    </option>
                  ))}
                </select>
              </label>
              <label className="pi-runtime-command">
                {t('agents.piApiKey')}
                <span>
                  <input
                    autoComplete="new-password"
                    disabled={busy}
                    name="pi_api_key"
                    placeholder={
                      providerHasKey ? t('agents.piApiKeySet') : 'sk-…'
                    }
                    spellCheck={false}
                    type={showKey ? 'text' : 'password'}
                    value={apiKey}
                    onChange={(event) => setApiKey(event.target.value)}
                  />
                  <Button
                    size="sm"
                    variant="outline"
                    type="button"
                    aria-label={
                      showKey
                        ? t('agents.providerHideKey')
                        : t('agents.providerShowKey')
                    }
                    disabled={busy}
                    onClick={() => setShowKey((current) => !current)}
                  >
                    {showKey ? (
                      <EyeOff aria-hidden="true" className="h-3.5 w-3.5" />
                    ) : (
                      <Eye aria-hidden="true" className="h-3.5 w-3.5" />
                    )}
                  </Button>
                </span>
              </label>
            </div>
            {defaultLevelUnlisted ? (
              <p className="pi-configuration-error" role="alert">
                {t('agents.piDefaultLevelUnlisted')}
              </p>
            ) : providerHasKey ? (
              <p className="pi-configuration-state">
                {t('agents.piCredentialPresent')}
              </p>
            ) : null}
            <div className="pi-configuration-actions">
              <span />
              <Button
                size="sm"
                disabled={busy}
                onClick={() => void saveCredentials()}
              >
                {savingCreds ? (
                  <Loader2
                    aria-hidden="true"
                    className="mr-2 h-3.5 w-3.5 animate-spin"
                  />
                ) : null}
                {t('agents.saveProvider')}
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
              <ul className="pi-trust-entries">
                {trustEntries.map((entry) => (
                  <li key={entry.path} className="flex items-center gap-2 py-1">
                    <span className="min-w-0 flex-1 break-all font-mono text-xs">
                      {entry.path}
                    </span>
                    <span>
                      {entry.trusted
                        ? t('agents.piProjectTrustTrusted')
                        : t('agents.piProjectTrustDenied')}
                    </span>
                    <Button
                      size="sm"
                      variant="outline"
                      disabled={busy}
                      onClick={() => void revokeTrust(entry.path)}
                    >
                      {t('agents.piProjectTrustRevoke')}
                    </Button>
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
