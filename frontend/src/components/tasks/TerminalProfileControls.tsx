import type { ExecutorConfigs, ExecutorProfileId } from 'shared/types';

import { AgentSelector } from '@/components/tasks/AgentSelector';
import { getDefaultProfileForExecutor } from '@/utils/executor';

interface TerminalProfileControlsProps {
  profiles: ExecutorConfigs['executors'] | null;
  selectedProfile: ExecutorProfileId | null;
  onChange: (profile: ExecutorProfileId) => void;
  disabled?: boolean;
  className?: string;
  lockExecutor?: boolean;
  showLabel?: boolean;
  iconOnly?: boolean;
  dropdownSide?: 'top' | 'bottom';
  /**
   * Kept for call-site compatibility while ACP controls are rolled out. Static
   * profile-derived model, permission, and mode selectors no longer exist.
   */
  suppressAcpManagedControls?: boolean;
}

export function TerminalProfileControls({
  profiles,
  selectedProfile,
  onChange,
  disabled,
  className = '',
  lockExecutor = false,
  iconOnly = false,
  dropdownSide = 'bottom',
}: TerminalProfileControlsProps) {
  if (!profiles || !selectedProfile?.executor || lockExecutor) {
    return null;
  }

  return (
    <AgentSelector
      profiles={profiles}
      selectedExecutorProfile={selectedProfile}
      onChange={(profile) => {
        const nextProfile = getDefaultProfileForExecutor(
          profile.executor,
          profiles
        ) ?? {
          executor: profile.executor,
          variant: null,
        };
        onChange(nextProfile);
      }}
      disabled={disabled}
      className={className}
      iconOnly={iconOnly}
      dropdownSide={dropdownSide}
    />
  );
}
