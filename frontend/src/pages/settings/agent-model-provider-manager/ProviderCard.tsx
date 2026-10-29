import { Check, Copy, Loader2, Pencil, Timer, Trash2 } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import type {
  AgentModelProviderProbeView,
  AgentModelProviderView,
} from 'shared/types';

import { Button } from '@/components/ui/button';
import { cn } from '@/lib/utils';

export function ProviderCard({
  provider,
  busy,
  canDelete,
  probe,
  onEnable,
  onEdit,
  onTest,
  onCopy,
  onDelete,
}: {
  provider: AgentModelProviderView;
  busy: boolean;
  canDelete: boolean;
  probe: AgentModelProviderProbeView | 'loading' | undefined;
  onEnable: () => void;
  onEdit: () => void;
  onTest: () => void;
  onCopy: () => void;
  onDelete: () => void;
}) {
  const { t } = useTranslation('settings');
  const latency =
    probe && probe !== 'loading' ? `${probe.latency_ms} ms` : null;
  return (
    <li data-bound={provider.bound}>
      <div>
        <strong>{provider.name}</strong>
        <p>{provider.api_url || t('agents.providerNativeBadge')}</p>
      </div>
      <div className="agent-model-provider-card-actions">
        {latency ? (
          <span
            className={cn(
              'agent-model-provider-latency',
              probe !== 'loading' && probe?.ok && 'is-ok'
            )}
          >
            {latency}
          </span>
        ) : null}
        <Button
          size="sm"
          variant={provider.bound ? 'outline' : 'default'}
          className={cn(
            'agent-model-provider-enable h-7',
            provider.bound && 'is-enabled'
          )}
          disabled={busy || provider.bound}
          onClick={onEnable}
        >
          {provider.bound ? (
            <Check aria-hidden="true" className="mr-1 h-3.5 w-3.5" />
          ) : null}
          {provider.bound
            ? t('agents.providerEnabled')
            : t('agents.providerEnable')}
        </Button>
        <Button
          size="sm"
          variant="ghost"
          className="h-7 w-7 p-0"
          aria-label={t('agents.providerEditAria', { name: provider.name })}
          disabled={busy}
          onClick={onEdit}
        >
          <Pencil aria-hidden="true" className="h-3.5 w-3.5" />
        </Button>
        <Button
          size="sm"
          variant="ghost"
          className="h-7 w-7 p-0"
          aria-label={t('agents.providerTestAria', { name: provider.name })}
          disabled={busy || probe === 'loading'}
          onClick={onTest}
        >
          {probe === 'loading' ? (
            <Loader2 aria-hidden="true" className="h-3.5 w-3.5 animate-spin" />
          ) : (
            <Timer aria-hidden="true" className="h-3.5 w-3.5" />
          )}
        </Button>
        <Button
          size="sm"
          variant="ghost"
          className="h-7 w-7 p-0"
          aria-label={t('agents.providerCopyAria', { name: provider.name })}
          disabled={busy}
          onClick={onCopy}
        >
          <Copy aria-hidden="true" className="h-3.5 w-3.5" />
        </Button>
        <Button
          size="sm"
          variant="ghost"
          className="h-7 w-7 p-0"
          aria-label={t('agents.providerDeleteAria', { name: provider.name })}
          disabled={busy || !canDelete}
          onClick={onDelete}
        >
          <Trash2 aria-hidden="true" className="h-3.5 w-3.5" />
        </Button>
      </div>
    </li>
  );
}
