import { Button } from '@/components/ui/button';

import { ProviderForm } from './ProviderForm';
import { ProviderList, ProviderToolbar } from './ProviderList';
import type { AgentModelProviderManagerProps } from './types';
import { useAgentModelProviderManager } from './useAgentModelProviderManager';

export function AgentModelProviderManager({
  agentId,
  disabled,
  onDirtyChange,
  onChanged,
  embedded = false,
  signedIn = false,
  active = true,
}: AgentModelProviderManagerProps) {
  const vm = useAgentModelProviderManager({
    agentId,
    disabled,
    onDirtyChange,
    onChanged,
    embedded,
    signedIn,
    active,
  });

  const content = (
    <>
      {vm.surface === 'form' ? (
        <ProviderForm
          t={vm.t}
          agentId={agentId}
          busy={vm.busy}
          id={vm.id}
          name={vm.name}
          setName={vm.setName}
          apiUrl={vm.apiUrl}
          setApiUrl={vm.setApiUrl}
          apiKey={vm.apiKey}
          setApiKey={vm.setApiKey}
          model={vm.model}
          setModel={vm.setModel}
          detectedCatalog={vm.detectedCatalog}
          setDetectedCatalog={vm.setDetectedCatalog}
          detectionError={vm.detectionError}
          setDetectionError={vm.setDetectionError}
          detectingModels={vm.detectingModels}
          claudeMappingTarget={vm.claudeMappingTarget}
          setClaudeMappingTarget={vm.setClaudeMappingTarget}
          customModelTests={vm.customModelTests}
          setCustomModelTests={vm.setCustomModelTests}
          endpointCandidates={vm.endpointCandidates}
          websiteUrl={vm.websiteUrl}
          apiKeyUrl={vm.apiKeyUrl}
          hasCatalogContributions={vm.hasCatalogContributions}
          catalog={vm.catalog}
          catalogGeneration={vm.catalogGeneration}
          catalogError={vm.catalogError}
          codexConfig={vm.codexConfig}
          resetForm={vm.resetForm}
          applyCatalogTemplate={vm.applyCatalogTemplate}
          closeForm={vm.closeForm}
          detectModels={vm.detectModels}
          toggleDetectedModel={vm.toggleDetectedModel}
          toggleAllDetected={vm.toggleAllDetected}
          testCustomModel={vm.testCustomModel}
          save={vm.save}
        />
      ) : (
        <ProviderList
          t={vm.t}
          busy={vm.busy}
          loading={vm.loading}
          providers={vm.providers}
          probes={vm.probes}
          importPreview={vm.importPreview}
          importSelected={vm.importSelected}
          setImportSelected={vm.setImportSelected}
          setImportPreview={vm.setImportPreview}
          openCreate={vm.openCreate}
          bind={vm.bind}
          openEdit={vm.openEdit}
          testConnection={vm.testConnection}
          copyConfig={vm.copyConfig}
          remove={vm.remove}
          applyImport={vm.applyImport}
        />
      )}
      {vm.error ? (
        <p className="agent-model-provider-error" role="alert">
          {vm.error}
        </p>
      ) : null}
    </>
  );

  if (embedded) {
    return (
      <section
        aria-labelledby={`${agentId}-model-provider-heading`}
        className="agent-model-provider-manager is-embedded"
      >
        <div className="agent-model-provider-heading">
          <h4 id={`${agentId}-model-provider-heading`}>
            {vm.t('settings:agents.providerTitle')}
          </h4>
          {vm.surface === 'list' ? (
            <ProviderToolbar
              t={vm.t}
              busy={vm.busy}
              importOpen={vm.importOpen}
              setImportOpen={vm.setImportOpen}
              pluginImportSources={vm.pluginImportSources}
              openCreate={vm.openCreate}
              loadImport={vm.loadImport}
              loadPluginImport={vm.loadPluginImport}
            />
          ) : null}
        </div>
        {content}
      </section>
    );
  }

  return (
    <section className="agent-model-provider-manager is-embedded">
      {vm.loaded ? (
        content
      ) : (
        <Button size="sm" variant="outline" onClick={() => void vm.load()}>
          {vm.t('settings:agents.providerTitle')}
        </Button>
      )}
    </section>
  );
}
