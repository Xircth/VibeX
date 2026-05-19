import { useCallback, useEffect, useMemo, useState } from 'react';
import { AlertTriangle, CheckCircle2, Loader2, RotateCw } from 'lucide-react';
import type {
  CapabilityStatus,
  ProviderId,
  ProviderRuntimeDependency,
  ProviderRuntimeStatus,
} from 'shared/types';
import { Button } from '@/components/ui/button';
import { providerRuntimeApi } from '@/lib/providerRuntime';

function providerIdFromAgentType(agentType: string): ProviderId | null {
  switch (agentType) {
    case 'claude_code':
      return 'claude';
    case 'codex':
      return 'codex';
    case 'open_code':
      return 'opencode';
    default:
      return null;
  }
}

function statusTone(status: CapabilityStatus): string {
  switch (status.state) {
    case 'available':
      return 'text-green-500';
    case 'partial':
      return 'text-yellow-500';
    case 'unavailable':
      return 'text-red-500';
    case 'unknown':
      return 'text-muted-foreground';
  }
}

function StatusLine({
  label,
  status,
}: {
  label: string;
  status: CapabilityStatus;
}) {
  const Icon = status.state === 'available' ? CheckCircle2 : AlertTriangle;
  return (
    <div className="flex items-start gap-2 text-[11px]">
      <Icon className={`mt-0.5 h-3.5 w-3.5 shrink-0 ${statusTone(status)}`} />
      <div className="min-w-0">
        <div className="font-medium text-foreground">
          {label}: {status.state} / {status.source}
        </div>
        {status.detail ? (
          <div className="mt-0.5 break-words text-muted-foreground">
            {status.detail}
          </div>
        ) : null}
      </div>
    </div>
  );
}

function DependencyLine({
  dependency,
}: {
  dependency: ProviderRuntimeDependency;
}) {
  return (
    <div className="flex items-start justify-between gap-3 text-[11px]">
      <div className="min-w-0">
        <div className="font-medium text-foreground">{dependency.label}</div>
        <div className="break-words text-muted-foreground">
          {dependency.detail}
        </div>
      </div>
      <div className="shrink-0 text-right text-muted-foreground">
        <div>{dependency.source}</div>
        <div>{dependency.required ? 'required' : 'optional'}</div>
      </div>
    </div>
  );
}

export function ProviderRuntimePanel({ agentType }: { agentType: string }) {
  const provider = useMemo(
    () => providerIdFromAgentType(agentType),
    [agentType]
  );
  const [status, setStatus] = useState<ProviderRuntimeStatus | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);

  const loadStatus = useCallback(async () => {
    if (!provider) return;
    setLoading(true);
    setError(null);
    try {
      setStatus(await providerRuntimeApi.getStatus(provider));
    } catch (err) {
      setStatus(null);
      setError(
        err instanceof Error ? err.message : 'Failed to load runtime status'
      );
    } finally {
      setLoading(false);
    }
  }, [provider]);

  useEffect(() => {
    void loadStatus();
  }, [loadStatus]);

  if (!provider) return null;

  return (
    <div className="space-y-2 rounded-md border bg-muted/10 p-3">
      <div className="flex items-center justify-between gap-2">
        <div>
          <div className="text-xs font-medium text-foreground">
            Provider runtime
          </div>
          <div className="text-[11px] text-muted-foreground">
            Native runtime and provider-scoped fallback status.
          </div>
        </div>
        <Button
          size="sm"
          variant="outline"
          className="h-7 text-xs"
          onClick={() => void loadStatus()}
          disabled={loading}
        >
          {loading ? (
            <Loader2 className="mr-1 h-3 w-3 animate-spin" />
          ) : (
            <RotateCw className="mr-1 h-3 w-3" />
          )}
          Check
        </Button>
      </div>

      {loading && !status ? (
        <div className="flex items-center gap-2 text-[11px] text-muted-foreground">
          <Loader2 className="h-3.5 w-3.5 animate-spin" />
          Loading runtime status...
        </div>
      ) : null}

      {status ? (
        <div className="space-y-2">
          <div className="rounded-sm bg-background/50 px-2 py-1.5 text-[11px]">
            <div className="font-medium text-foreground">
              Primary: {status.contract.primary_label}
            </div>
            <div className="mt-0.5 text-muted-foreground">
              {status.contract.primary_runtime} /{' '}
              {status.contract.primary_source}
            </div>
          </div>
          <StatusLine label="Native" status={status.native} />
          <StatusLine label="Fallback" status={status.fallback} />
          <div className="space-y-1.5 border-t pt-2">
            {status.contract.dependencies.map((dependency) => (
              <DependencyLine key={dependency.id} dependency={dependency} />
            ))}
          </div>
          <div className="border-t pt-2 text-[11px] text-muted-foreground">
            Fallback env: {status.contract.fallback_env}
          </div>
        </div>
      ) : null}

      {error ? (
        <div className="text-[11px] text-destructive">{error}</div>
      ) : null}
    </div>
  );
}
