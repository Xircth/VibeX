import { ArrowLeft } from 'lucide-react';
import type { Dispatch, SetStateAction } from 'react';
import type { TFunction } from 'i18next';
import type {
  AgentId,
  AgentModelCatalogView,
  CodexModelCatalogConfigView,
} from 'shared/types';

import { AstryxSelect } from '@/components/ui/astryx-select';
import { Button } from '@/components/ui/button';

import {
  CodexModelConfigFields,
  type CustomModelTestState,
} from '../CodexModelCatalogEditor';
import { ProviderCatalogPicker } from '../ProviderCatalogPicker';
import type {
  ProviderCatalogListView,
  ProviderCatalogTemplateView,
} from '../providerCatalogTypes';
import { ClaudeProviderModelEditor } from './ClaudeProviderModelEditor';
import { DefaultProviderModelEditor } from './DefaultProviderModelEditor';
import { GrokProviderModelEditor } from './GrokProviderModelEditor';
import { PiProviderModelEditor } from './PiProviderModelEditor';
import { ProviderModelDetection } from './ProviderModelDetection';
import { ProviderSecretField } from './ProviderSecretField';
import {
  mergeCodexConfigDraft,
  parseCodexModel,
  providerModelChoices,
  selectedDetectedIds,
  serializeCodexModel,
} from './providerModelParse';

export interface ProviderFormProps {
  t: TFunction;
  agentId: AgentId;
  busy: boolean;
  id: string | null;
  name: string;
  setName: (value: string) => void;
  apiUrl: string;
  setApiUrl: (value: string) => void;
  apiKey: string;
  setApiKey: (value: string) => void;
  model: string;
  setModel: (value: string) => void;
  detectedCatalog: AgentModelCatalogView | null;
  setDetectedCatalog: Dispatch<SetStateAction<AgentModelCatalogView | null>>;
  detectionError: string | null;
  setDetectionError: Dispatch<SetStateAction<string | null>>;
  detectingModels: boolean;
  claudeMappingTarget: string;
  setClaudeMappingTarget: Dispatch<SetStateAction<string>>;
  customModelTests: Record<number, CustomModelTestState>;
  setCustomModelTests: Dispatch<
    SetStateAction<Record<number, CustomModelTestState>>
  >;
  endpointCandidates: string[];
  websiteUrl: string | null;
  apiKeyUrl: string | null;
  hasCatalogContributions: boolean;
  catalog: ProviderCatalogListView | null;
  catalogGeneration: number;
  catalogError: string | null;
  codexConfig: CodexModelCatalogConfigView | null;
  resetForm: () => void;
  applyCatalogTemplate: (template: ProviderCatalogTemplateView) => void;
  closeForm: () => Promise<void>;
  detectModels: (
    nextUrl?: string,
    nextKey?: string | null,
    nextId?: string | null
  ) => Promise<void>;
  toggleDetectedModel: (modelId: string, checked: boolean) => void;
  toggleAllDetected: (checked: boolean) => void;
  testCustomModel: (index: number, slug: string) => Promise<void>;
  save: () => Promise<void>;
}

export function ProviderForm({
  t,
  agentId,
  busy,
  id,
  name,
  setName,
  apiUrl,
  setApiUrl,
  apiKey,
  setApiKey,
  model,
  setModel,
  detectedCatalog,
  setDetectedCatalog,
  detectionError,
  setDetectionError,
  detectingModels,
  claudeMappingTarget,
  setClaudeMappingTarget,
  customModelTests,
  setCustomModelTests,
  endpointCandidates,
  websiteUrl,
  apiKeyUrl,
  hasCatalogContributions,
  catalog,
  catalogGeneration,
  catalogError,
  codexConfig,
  resetForm,
  applyCatalogTemplate,
  closeForm,
  detectModels,
  toggleDetectedModel,
  toggleAllDetected,
  testCustomModel,
  save,
}: ProviderFormProps) {
  return (
    <div className="agent-model-provider-form">
      <div className="agent-model-provider-form-heading">
        <Button
          size="sm"
          variant="ghost"
          className="h-8"
          onClick={() => void closeForm()}
        >
          <ArrowLeft aria-hidden="true" className="mr-1.5 h-3.5 w-3.5" />
          {t('settings:agents.providerFormBack')}
        </Button>
        <strong>
          {id
            ? t('settings:agents.providerEdit')
            : t('settings:agents.providerNew')}
        </strong>
      </div>
      {!id && hasCatalogContributions ? (
        <ProviderCatalogPicker
          disabled={busy}
          generation={catalog?.generation ?? catalogGeneration}
          showCustomTile
          templates={catalog?.templates ?? []}
          onSelect={(next) => {
            if (next === 'custom') {
              resetForm();
              return;
            }
            applyCatalogTemplate(next);
          }}
        />
      ) : null}
      {catalogError ? (
        <p className="agent-model-provider-error" role="alert">
          {catalogError}
        </p>
      ) : null}
      <div className="agent-model-provider-form-grid">
        <label>
          <span>{t('settings:agents.name')}</span>
          <input
            aria-label={t('settings:agents.providerNameAria')}
            autoComplete="off"
            disabled={busy}
            name={`${agentId}_model_provider_name`}
            value={name}
            onChange={(event) => setName(event.target.value)}
          />
        </label>
        <label>
          <span>API URL</span>
          <input
            aria-label="Provider API URL"
            autoComplete="off"
            disabled={busy}
            name={`${agentId}_model_provider_url`}
            spellCheck={false}
            type="url"
            value={apiUrl}
            onChange={(event) => {
              setApiUrl(event.target.value);
              setDetectedCatalog(null);
              setDetectionError(null);
            }}
          />
        </label>
        {endpointCandidates.length > 1 ? (
          <AstryxSelect
            disabled={busy}
            options={endpointCandidates.map((candidate) => ({
              value: candidate,
              label: candidate,
            }))}
            value={apiUrl}
            onChange={(value) => {
              setApiUrl(value);
              setDetectedCatalog(null);
              setDetectionError(null);
            }}
          />
        ) : null}
        {websiteUrl || apiKeyUrl ? (
          <div className="agent-model-provider-catalog-links">
            {websiteUrl ? (
              <a href={websiteUrl} rel="noopener noreferrer" target="_blank">
                {t('settings:agents.providerCatalogWebsite')}
              </a>
            ) : null}
            {apiKeyUrl ? (
              <a href={apiKeyUrl} rel="noopener noreferrer" target="_blank">
                {t('settings:agents.providerCatalogGetKey')}
              </a>
            ) : null}
          </div>
        ) : null}
        <ProviderSecretField
          key={id ?? 'create'}
          agentId={agentId}
          disabled={busy}
          value={apiKey}
          onChange={(value) => {
            setApiKey(value);
            setDetectedCatalog(null);
            setDetectionError(null);
          }}
        />
        <ProviderModelDetection
          agentId={agentId}
          catalog={detectedCatalog}
          claudeMappingTarget={claudeMappingTarget}
          disabled={busy || !apiUrl.trim() || (!apiKey.trim() && !id)}
          error={detectionError}
          loading={detectingModels}
          selectedIds={selectedDetectedIds(
            agentId,
            model,
            detectedCatalog,
            codexConfig
          )}
          onDetect={() => void detectModels()}
          onMappingTargetChange={setClaudeMappingTarget}
          onToggleModel={toggleDetectedModel}
          onToggleAll={toggleAllDetected}
        />
        {agentId === 'claude_code' ? (
          <ClaudeProviderModelEditor
            choices={providerModelChoices(model, detectedCatalog)}
            disabled={busy}
            value={model}
            onChange={setModel}
          />
        ) : agentId === 'grok' ? (
          <GrokProviderModelEditor
            choices={providerModelChoices(model, detectedCatalog)}
            disabled={busy}
            value={model}
            onChange={setModel}
          />
        ) : agentId === 'pi' ? (
          <PiProviderModelEditor
            choices={providerModelChoices(model, detectedCatalog)}
            disabled={busy}
            value={model}
            onChange={setModel}
          />
        ) : agentId === 'codex' ? (
          <div className="agent-model-provider-codex">
            <span>{t('settings:agents.modelCatalog')}</span>
            <div className="codex-model-editor-body">
              <CodexModelConfigFields
                catalog={{
                  agent_id: 'codex',
                  source: detectedCatalog?.source ?? 'live',
                  models: detectedCatalog?.models ?? [],
                  default_model: detectedCatalog?.default_model ?? null,
                  error: detectedCatalog?.error ?? null,
                }}
                defaultModelDetecting={detectingModels}
                defaultModels={detectedCatalog?.models ?? []}
                hideCustomSlugs={(detectedCatalog?.models ?? []).map(
                  (item) => item.id
                )}
                disabled={busy}
                draft={mergeCodexConfigDraft(
                  parseCodexModel(model),
                  codexConfig
                )}
                showOfficialModels={false}
                customModelTests={customModelTests}
                onTestCustomModel={(index, slug) =>
                  void testCustomModel(index, slug)
                }
                onCustomModelSlugChange={(index) =>
                  setCustomModelTests((current) => {
                    if (!(index in current)) return current;
                    const next = { ...current };
                    delete next[index];
                    return next;
                  })
                }
                onCustomModelRemove={(index) =>
                  setCustomModelTests((current) => {
                    const next: Record<number, CustomModelTestState> = {};
                    for (const [key, value] of Object.entries(current)) {
                      const currentIndex = Number(key);
                      if (currentIndex < index) next[currentIndex] = value;
                      else if (currentIndex > index)
                        next[currentIndex - 1] = value;
                    }
                    return next;
                  })
                }
                onDefaultModelOpen={() => {
                  if (
                    detectingModels ||
                    detectedCatalog ||
                    !apiUrl.trim() ||
                    (!apiKey.trim() && !id)
                  ) {
                    return;
                  }
                  void detectModels();
                }}
                onChange={(next) => setModel(serializeCodexModel(next))}
              />
            </div>
          </div>
        ) : (
          <DefaultProviderModelEditor
            agentId={agentId}
            choices={providerModelChoices(model, detectedCatalog)}
            disabled={busy}
            value={model}
            onChange={setModel}
          />
        )}
      </div>
      <Button
        size="sm"
        className="h-8 self-end"
        disabled={busy}
        onClick={() => void save()}
      >
        {id
          ? t('settings:agents.saveChanges')
          : t('settings:agents.providerCreate')}
      </Button>
    </div>
  );
}
