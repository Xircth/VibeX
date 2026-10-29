import { Copy, Eye, EyeOff } from 'lucide-react';
import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import type { AgentId } from 'shared/types';

import { Button } from '@/components/ui/button';
import { toast } from '@/components/ui/toast';

export function ProviderSecretField({
  agentId,
  value,
  disabled,
  onChange,
}: {
  agentId: AgentId;
  value: string;
  disabled: boolean;
  onChange: (value: string) => void;
}) {
  const { t } = useTranslation('settings');
  const [revealed, setRevealed] = useState(false);
  const copyKey = async () => {
    if (!value) return;
    try {
      await navigator.clipboard.writeText(value);
      toast.success(t('agents.providerKeyCopied'));
    } catch {
      toast.error(t('agents.providerCopyFailed'));
    }
  };
  return (
    <label>
      <span>API Key</span>
      <div className="agent-model-provider-secret">
        <input
          aria-label="Provider API Key"
          autoComplete="new-password"
          disabled={disabled}
          name={`${agentId}_model_provider_api_key`}
          placeholder={t('settings:agents.providerKeyPlaceholder')}
          spellCheck={false}
          type={revealed ? 'text' : 'password'}
          value={value}
          onChange={(event) => onChange(event.target.value)}
        />
        <Button
          size="sm"
          type="button"
          variant="ghost"
          className="h-8 w-8 p-0"
          aria-label={
            revealed ? t('agents.providerHideKey') : t('agents.providerShowKey')
          }
          disabled={disabled || !value}
          onClick={() => setRevealed((current) => !current)}
        >
          {revealed ? (
            <EyeOff aria-hidden="true" className="h-3.5 w-3.5" />
          ) : (
            <Eye aria-hidden="true" className="h-3.5 w-3.5" />
          )}
        </Button>
        <Button
          size="sm"
          type="button"
          variant="ghost"
          className="h-8 w-8 p-0"
          aria-label={t('agents.providerCopyKey')}
          disabled={disabled || !value}
          onClick={() => void copyKey()}
        >
          <Copy aria-hidden="true" className="h-3.5 w-3.5" />
        </Button>
      </div>
    </label>
  );
}
