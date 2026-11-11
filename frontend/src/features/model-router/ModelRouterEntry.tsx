import { useState } from 'react';
import { Waypoints } from 'lucide-react';
import { useTranslation } from 'react-i18next';

import { Button } from '@/components/ui/button';

import type { RouterProvision } from './account';
import { ModelRouterDialog } from './ModelRouterDialog';
import { supportsModelRouter } from './preset';

/**
 * The ModelRouter entry in an agent's provider toolbar. It sits beside the
 * other ways to add a provider and stays a quiet text button: present where a
 * user is already choosing a provider, never a banner.
 */
export function ModelRouterEntry({
  agentId,
  disabled,
  onApply,
}: {
  agentId: string;
  disabled?: boolean;
  onApply: (provision: RouterProvision) => Promise<void>;
}) {
  const { t } = useTranslation('settings');
  const [open, setOpen] = useState(false);
  if (!supportsModelRouter(agentId)) return null;
  return (
    <>
      <Button
        size="sm"
        variant="ghost"
        className="h-8"
        disabled={disabled}
        onClick={() => setOpen(true)}
      >
        <Waypoints aria-hidden="true" className="mr-1.5 h-3.5 w-3.5" />
        {t('settings:agents.modelRouterEntry')}
      </Button>
      {open ? (
        <ModelRouterDialog
          agentId={agentId}
          open
          onOpenChange={setOpen}
          onApply={onApply}
        />
      ) : null}
    </>
  );
}
