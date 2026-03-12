import { Check, Loader2 } from 'lucide-react';import type { AgentAvailabilityState } from '@/hooks/useAgentAvailability';

interface AgentAvailabilityIndicatorProps {
  availability: AgentAvailabilityState;
}

export function AgentAvailabilityIndicator({
  availability,
}: AgentAvailabilityIndicatorProps) {  if (!availability) return null;

  return (
    <div className="flex flex-col gap-1 text-sm">
      {availability.status === 'checking' && (
        <div className="flex items-center gap-2">
          <Loader2 className="h-4 w-4 animate-spin text-muted-foreground" />
          <span className="text-muted-foreground">
            {'检查中...'}
          </span>
        </div>
      )}
      {availability.status === 'login_detected' && (
        <>
          <div className="flex items-center gap-2">
            <Check className="h-4 w-4 text-success" />
            <span className="text-success">
              {'检测到最近使用'}
            </span>
          </div>
          <p className="text-xs text-muted-foreground pl-6">
            {'找到此代理的最近身份验证凭据'}
          </p>
        </>
      )}
      {availability.status === 'installation_found' && (
        <>
          <div className="flex items-center gap-2">
            <Check className="h-4 w-4 text-success" />
            <span className="text-success">
              {'检测到以前使用'}
            </span>
          </div>
          <p className="text-xs text-muted-foreground pl-6">
            {'找到代理配置。您可能需要登录才能使用它。'}
          </p>
        </>
      )}
    </div>
  );
}
