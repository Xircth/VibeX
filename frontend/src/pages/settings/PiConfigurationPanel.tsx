import {
  CheckCircle2,
  ChevronDown,
  Cpu,
  KeyRound,
  Loader2,
  TerminalSquare,
  XCircle,
} from 'lucide-react';
import { useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import type {
  PiCommandValidationView,
  PiConfigurationView,
} from 'shared/types';

import { AstryxSelect } from '@/components/ui/astryx-select';
import { Button } from '@/components/ui/button';
import { toast } from '@/components/ui/toast';
import {
  agentManagementApi,
  agentManagementErrorMessage as errorMessage,
} from '@/features/agent-management';

const CUSTOM_PROVIDER = '__custom__';

const BUILT_IN_PROVIDERS = [
  ['anthropic', 'Anthropic'],
  ['openai', 'OpenAI'],
  ['google', 'Google Gemini'],
  ['openrouter', 'OpenRouter'],
  ['vercel-ai-gateway', 'Vercel AI Gateway'],
  ['xai', 'xAI'],
  ['deepseek', 'DeepSeek'],
  ['groq', 'Groq'],
  ['cerebras', 'Cerebras'],
  ['mistral', 'Mistral'],
  ['nvidia', 'NVIDIA NIM'],
  ['together', 'Together AI'],
  ['fireworks', 'Fireworks'],
  ['huggingface', 'Hugging Face'],
  ['kimi-coding', 'Kimi For Coding'],
  ['moonshotai', 'Moonshot AI'],
  ['moonshotai-cn', 'Moonshot AI', 'china'],
  ['zai', 'Z.AI Coding Plan', 'global'],
  ['zai-coding-cn', 'Z.AI Coding Plan', 'china'],
  ['minimax', 'MiniMax'],
  ['minimax-cn', 'MiniMax', 'china'],
  ['ant-ling', 'Ant Ling'],
  ['xiaomi', 'Xiaomi MiMo'],
  ['xiaomi-token-plan-cn', 'Xiaomi MiMo Token Plan', 'china'],
  ['xiaomi-token-plan-ams', 'Xiaomi MiMo Token Plan', 'amsterdam'],
  ['xiaomi-token-plan-sgp', 'Xiaomi MiMo Token Plan', 'singapore'],
  ['opencode', 'OpenCode Zen'],
  ['opencode-go', 'OpenCode Go'],
] as const;

const THINKING_LEVELS = ['off', 'minimal', 'low', 'medium', 'high', 'xhigh'];
const CUSTOM_PROTOCOLS = [
  'openai-completions',
  'openai-responses',
  'anthropic-messages',
  'google-generative-ai',
];

export function PiConfigurationPanel({
  disabled,
  onDirtyChange,
}: {
  disabled: boolean;
  onDirtyChange?: (dirty: boolean) => void;
}) {
  const { t } = useTranslation('settings');
  const [view, setView] = useState<PiConfigurationView | null>(null);
  const [loaded, setLoaded] = useState(false);
  const [loading, setLoading] = useState(false);
  const [savingCredentials, setSavingCredentials] = useState(false);
  const [savingRuntime, setSavingRuntime] = useState(false);
  const [validating, setValidating] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [provider, setProvider] = useState('');
  const [model, setModel] = useState('');
  const [thinkingLevel, setThinkingLevel] = useState('');
  const [apiKey, setApiKey] = useState('');
  const [customId, setCustomId] = useState('');
  const [customBaseUrl, setCustomBaseUrl] = useState('');
  const [customApi, setCustomApi] = useState(CUSTOM_PROTOCOLS[0]);
  const [mode, setMode] = useState('default');
  const [command, setCommand] = useState('');
  const [configDir, setConfigDir] = useState('');
  const [sessionDir, setSessionDir] = useState('');
  const [trustWorkspace, setTrustWorkspace] = useState(true);
  const [validation, setValidation] = useState<PiCommandValidationView | null>(
    null
  );
  const [defaultRuntime, setDefaultRuntime] =
    useState<PiCommandValidationView | null>(null);

  const hydrate = (next: PiConfigurationView) => {
    setView(next);
    setModel(next.default_model);
    setThinkingLevel(next.thinking_level);
    const custom = next.custom_providers.find(
      (entry) => entry.id === next.default_provider
    );
    if (custom) {
      setProvider(CUSTOM_PROVIDER);
      setCustomId(custom.id);
      setCustomBaseUrl(custom.base_url);
      setCustomApi(custom.api || CUSTOM_PROTOCOLS[0]);
    } else {
      setProvider(next.default_provider);
    }
    setMode(next.runtime.mode);
    setCommand(next.runtime.command);
    setConfigDir(next.runtime.config_dir);
    setSessionDir(next.runtime.session_dir);
    setTrustWorkspace(next.runtime.trust_workspace);
  };

  const load = async () => {
    if (loading || loaded) return;
    setLoading(true);
    setError(null);
    try {
      const [configuration, runtime] = await Promise.all([
        agentManagementApi.piConfiguration(),
        agentManagementApi.validatePiCommand('pi'),
      ]);
      hydrate(configuration);
      setDefaultRuntime(runtime);
      setLoaded(true);
    } catch (cause) {
      setError(errorMessage(cause, t('agents.piLoadFailed')));
    } finally {
      setLoading(false);
    }
  };

  const selectProvider = (value: string) => {
    setProvider(value);
    setApiKey('');
    if (value !== CUSTOM_PROVIDER || customId) return;
    const first = view?.custom_providers[0];
    if (first) selectCustomProvider(first.id);
  };

  const selectCustomProvider = (id: string) => {
    const existing = view?.custom_providers.find((entry) => entry.id === id);
    setCustomId(existing?.id ?? '');
    setCustomBaseUrl(existing?.base_url ?? '');
    setCustomApi(existing?.api || CUSTOM_PROTOCOLS[0]);
    setApiKey('');
  };

  const saveCredentials = async () => {
    const effectiveProvider =
      provider === CUSTOM_PROVIDER ? customId.trim() : provider.trim();
    if (
      !effectiveProvider ||
      !model.trim() ||
      (provider === CUSTOM_PROVIDER && !customBaseUrl.trim())
    ) {
      toast.warning(t('agents.piProviderRequired'));
      return;
    }
    setSavingCredentials(true);
    setError(null);
    try {
      const next = await agentManagementApi.savePiCredentials({
        provider: effectiveProvider,
        model: model.trim(),
        thinking_level: thinkingLevel || null,
        api_key: apiKey.trim() || null,
        custom_base_url:
          provider === CUSTOM_PROVIDER ? customBaseUrl.trim() : null,
        custom_api: provider === CUSTOM_PROVIDER ? customApi : null,
      });
      hydrate(next);
      setApiKey('');
      toast.success(t('agents.piProviderSaved'));
    } catch (cause) {
      const message = errorMessage(cause, t('agents.piProviderSaveFailed'));
      setError(message);
      toast.error(message);
    } finally {
      setSavingCredentials(false);
    }
  };

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
        trust_workspace: trustWorkspace,
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

  const effectiveProvider =
    provider === CUSTOM_PROVIDER ? customId.trim() : provider;
  const originalCustom = view?.custom_providers.find(
    (entry) => entry.id === view.default_provider
  );
  const dirty = Boolean(
    view &&
      (effectiveProvider !== view.default_provider ||
        model !== view.default_model ||
        thinkingLevel !== view.thinking_level ||
        apiKey.length > 0 ||
        (provider === CUSTOM_PROVIDER &&
          (customBaseUrl !== (originalCustom?.base_url ?? '') ||
            customApi !== (originalCustom?.api || CUSTOM_PROTOCOLS[0]))) ||
        mode !== view.runtime.mode ||
        command !== view.runtime.command ||
        configDir !== view.runtime.config_dir ||
        sessionDir !== view.runtime.session_dir ||
        trustWorkspace !== view.runtime.trust_workspace)
  );
  useEffect(() => {
    onDirtyChange?.(dirty);
    return () => onDirtyChange?.(false);
  }, [dirty, onDirtyChange]);
  const credentialPresent =
    effectiveProvider.length > 0 &&
    (view?.auth_providers.includes(effectiveProvider) ?? false);
  const providerOptions =
    provider &&
    provider !== CUSTOM_PROVIDER &&
    !BUILT_IN_PROVIDERS.some(([id]) => id === provider)
      ? [...BUILT_IN_PROVIDERS, [provider, provider] as const]
      : BUILT_IN_PROVIDERS;
  const busy = disabled || savingCredentials || savingRuntime;

  return (
    <details
      className="pi-configuration-panel"
      onToggle={(event) => {
        if (event.currentTarget.open) void load();
      }}
    >
      <summary>
        <strong>{t('agents.piTitle')}</strong>
        <ChevronDown aria-hidden="true" className="h-4 w-4" />
      </summary>

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
          <section aria-labelledby="pi-provider-heading">
            <div className="pi-configuration-heading">
              <KeyRound aria-hidden="true" className="h-4 w-4" />
              <span>
                <strong id="pi-provider-heading">
                  {t('agents.piProviderHeading')}
                </strong>
              </span>
            </div>
            <div className="pi-configuration-grid">
              <label>
                Provider
                <AstryxSelect
                  ariaLabel={t('agents.piProviderHeading')}
                  disabled={busy}
                  hasClear
                  placeholder={t('agents.selectPlaceholder')}
                  value={provider}
                  options={[
                    ...providerOptions.map(([id, label, region]) => ({
                      value: id,
                      label: region
                        ? `${label} (${t(`agents.region${capitalize(region)}`)})`
                        : label,
                    })),
                    {
                      value: CUSTOM_PROVIDER,
                      label: t('agents.customProviderOption'),
                    },
                  ]}
                  onChange={(next) => selectProvider(next)}
                />
              </label>
              <label>
                {t('agents.modelId')}
                <input
                  autoComplete="off"
                  disabled={busy}
                  name="pi_model"
                  spellCheck={false}
                  value={model}
                  onChange={(event) => setModel(event.target.value)}
                />
              </label>
              <label>
                {t('agents.reasoningEffort')}
                <AstryxSelect
                  ariaLabel={t('agents.reasoningEffort')}
                  disabled={busy}
                  hasClear
                  placeholder={t('agents.useModelDefault')}
                  value={thinkingLevel}
                  options={THINKING_LEVELS.map((level) => ({
                    value: level,
                    label: level,
                  }))}
                  onChange={setThinkingLevel}
                />
              </label>
              <label>
                API Key
                <input
                  autoComplete="new-password"
                  disabled={busy}
                  name="pi_api_key"
                  placeholder={
                    credentialPresent
                      ? t('agents.credentialSavedPlaceholder')
                      : t('agents.apiKeyPlaceholder')
                  }
                  type="password"
                  value={apiKey}
                  onChange={(event) => setApiKey(event.target.value)}
                />
              </label>
            </div>

            {provider === CUSTOM_PROVIDER ? (
              <fieldset className="pi-custom-provider-fields">
                <legend>{t('agents.customProvider')}</legend>
                {view.custom_providers.length > 0 ? (
                  <label>
                    {t('agents.loadExistingConfig')}
                    <AstryxSelect
                      ariaLabel={t('agents.loadExistingConfig')}
                      disabled={busy}
                      hasClear
                      placeholder={t('agents.newCustomProvider')}
                      value={
                        view.custom_providers.some(
                          (entry) => entry.id === customId
                        )
                          ? customId
                          : ''
                      }
                      options={view.custom_providers.map((entry) => ({
                        value: entry.id,
                        label: entry.id,
                      }))}
                      onChange={(next) => selectCustomProvider(next)}
                    />
                  </label>
                ) : null}
                <label>
                  Provider ID
                  <input
                    autoComplete="off"
                    disabled={busy}
                    name="pi_custom_provider_id"
                    spellCheck={false}
                    value={customId}
                    onChange={(event) => setCustomId(event.target.value)}
                  />
                </label>
                <label>
                  API URL
                  <input
                    autoCapitalize="none"
                    autoComplete="url"
                    disabled={busy}
                    inputMode="url"
                    name="pi_custom_provider_url"
                    placeholder="https://api.example.com/v1"
                    spellCheck={false}
                    type="url"
                    value={customBaseUrl}
                    onChange={(event) => setCustomBaseUrl(event.target.value)}
                  />
                </label>
                <label>
                  Wire protocol
                  <AstryxSelect
                    ariaLabel={t('agents.customProviderProtocol')}
                    disabled={busy}
                    value={customApi}
                    options={CUSTOM_PROTOCOLS.map((protocol) => ({
                      value: protocol,
                      label: protocol,
                    }))}
                    onChange={setCustomApi}
                  />
                </label>
              </fieldset>
            ) : null}

            <div className="pi-configuration-actions">
              <span aria-live="polite">
                {credentialPresent ? t('agents.piCredentialPresent') : ''}
              </span>
              <Button
                size="sm"
                disabled={busy}
                onClick={() => void saveCredentials()}
              >
                {savingCredentials ? (
                  <Loader2
                    aria-hidden="true"
                    className="mr-2 h-3.5 w-3.5 animate-spin"
                  />
                ) : null}
                {t('agents.saveProvider')}
              </Button>
            </div>
          </section>

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

            <label className="pi-workspace-trust">
              <input
                aria-label={t('agents.piTrustWorkspace')}
                checked={trustWorkspace}
                disabled={busy}
                name="pi_trust_workspace"
                type="checkbox"
                onChange={(event) => setTrustWorkspace(event.target.checked)}
              />
              <span>
                <strong>{t('agents.piTrustWorkspace')}</strong>
              </span>
            </label>
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
          {error ? (
            <p className="pi-configuration-error" role="alert">
              {error}
            </p>
          ) : null}
        </div>
      ) : null}
    </details>
  );
}

function capitalize(value: string) {
  return value.charAt(0).toUpperCase() + value.slice(1);
}
