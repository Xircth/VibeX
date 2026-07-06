import { useTranslation } from 'react-i18next';
import { Label } from '@/components/ui/label';
import BranchSelector from './BranchSelector';
import type { RepoBranchConfig } from '@/hooks';

type Props = {
  configs: RepoBranchConfig[];
  onBranchChange: (repoId: string, branch: string) => void;
  isLoading?: boolean;
  showLabel?: boolean;
  className?: string;
  dropdownSide?: 'top' | 'bottom';
};

export function RepoBranchSelector({
  configs,
  onBranchChange,
  isLoading,
  showLabel = true,
  className,
  dropdownSide = 'bottom',
}: Props) {
  const { t } = useTranslation(['tasks', 'common']);

  if (configs.length === 0) {
    return null;
  }

  if (configs.length === 1) {
    const config = configs[0];
    return (
      <div className={className}>
        {showLabel && (
          <Label className="text-sm font-medium">
            {t('repoBranchSelector.baseBranch')}{' '}
            <span className="text-destructive">*</span>
          </Label>
        )}
        <BranchSelector
          branches={config.branches}
          selectedBranch={config.targetBranch}
          onBranchSelect={(branch) => onBranchChange(config.repoId, branch)}
          placeholder={
            isLoading
              ? t('repoBranchSelector.loadingBranches')
              : t('repoBranchSelector.selectBranch')
          }
          dropdownSide={dropdownSide}
        />
      </div>
    );
  }

  return (
    <div className={className}>
      <div className="space-y-3">
        {configs.map((config) => (
          <div key={config.repoId} className="space-y-1">
            <Label className="text-sm font-medium">
              {config.repoDisplayName}{' '}
              <span className="text-destructive">*</span>
            </Label>
            <BranchSelector
              branches={config.branches}
              selectedBranch={config.targetBranch}
              onBranchSelect={(branch) => onBranchChange(config.repoId, branch)}
              placeholder={
                isLoading
                  ? t('repoBranchSelector.loadingBranches')
                  : t('repoBranchSelector.selectBranch')
              }
              dropdownSide={dropdownSide}
            />
          </div>
        ))}
      </div>
    </div>
  );
}

export default RepoBranchSelector;
