import { useCallback, useState } from 'react';
import { useTranslation } from 'react-i18next';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import { Button } from '@/components/ui/button';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';
import { Label } from '@/components/ui/label';
import { Input } from '@/components/ui/input';
import { ChevronLeft, ChevronRight } from 'lucide-react';
import { Logo } from '@/components/Logo';
import { AgentKind, EditorType } from 'shared/types';
import type { EditorConfig, ExecutorProfileId } from 'shared/types';
import { useUserSystem } from '@/components/ConfigProvider';

import { toPrettyCase } from '@/utils/string';
import NiceModal, { useModal } from '@ebay/nice-modal-react';
import { defineModal, type NoProps } from '@/lib/modals';
import { useEditorAvailability } from '@/hooks/useEditorAvailability';
import { EditorAvailabilityIndicator } from '@/components/EditorAvailabilityIndicator';
import { useAgentAvailability } from '@/hooks/useAgentAvailability';
import { AgentAvailabilityIndicator } from '@/components/AgentAvailabilityIndicator';
import { applyAgentQuickFix } from '@/lib/agentQuickFix';
import { APP_NAME } from '@/lib/branding';
import { cn } from '@/lib/utils';
import { getOnboardingDefaultProfile } from './onboardingProfile';

export type OnboardingResult = {
  profile: ExecutorProfileId;
  editor: EditorConfig;
};

function StepIndicator({ current, total }: { current: number; total: number }) {
  return (
    <div className="flex items-center gap-1.5 justify-center">
      {Array.from({ length: total }, (_, i) => (
        <div
          key={i}
          className={cn(
            'h-1.5 rounded-full transition-all',
            i + 1 === current
              ? 'w-4 bg-foreground'
              : 'w-1.5 bg-muted-foreground/30'
          )}
        />
      ))}
    </div>
  );
}

const OnboardingDialogImpl = NiceModal.create<NoProps>(() => {
  const { t } = useTranslation(['dialogs', 'common']);
  const modal = useModal();
  const { profiles, config } = useUserSystem();

  const [step, setStep] = useState<1 | 2>(1);

  const [profile, setProfile] = useState<ExecutorProfileId>(() =>
    getOnboardingDefaultProfile(config?.executor_profile)
  );
  const [editorType, setEditorType] = useState<EditorType>(EditorType.VS_CODE);
  const [customCommand, setCustomCommand] = useState<string>('');

  const editorAvailability = useEditorAvailability(editorType);
  const { availability: agentAvailability, recheck: recheckAgentAvailability } =
    useAgentAvailability(profile.executor);
  const [agentFixing, setAgentFixing] = useState(false);
  const [agentFixError, setAgentFixError] = useState<string | null>(null);

  const handleAgentQuickFix = useCallback(async () => {
    if (!profile.executor) return;
    setAgentFixing(true);
    setAgentFixError(null);
    try {
      await applyAgentQuickFix(profile.executor);
    } catch (error) {
      setAgentFixError(error instanceof Error ? error.message : String(error));
    } finally {
      setAgentFixing(false);
      recheckAgentAvailability();
    }
  }, [profile.executor, recheckAgentAvailability]);

  const handleComplete = () => {
    modal.resolve({
      // Do not carry legacy model/permission/reasoning selections through
      // onboarding. The session creation form is the sole ACP selector and
      // reads those choices from the persisted capability catalog.
      profile: getOnboardingDefaultProfile(profile),
      editor: {
        editor_type: editorType,
        custom_command:
          editorType === EditorType.CUSTOM ? customCommand || null : null,
        remote_ssh_host: null,
        remote_ssh_user: null,
      },
    } as OnboardingResult);
  };

  const isStep2Valid =
    editorType !== EditorType.CUSTOM ||
    (editorType === EditorType.CUSTOM && customCommand.trim() !== '');

  return (
    <Dialog open={modal.visible} uncloseable={true}>
      <DialogContent className="sm:max-w-[440px]">
        <DialogHeader>
          <div className="flex items-center gap-2.5">
            <Logo showText={false} />
            <DialogTitle className="text-lg">{`Welcome to ${APP_NAME}`}</DialogTitle>
          </div>
          <DialogDescription className="text-left pt-1 text-xs">
            {t('onboarding.description')}
          </DialogDescription>
          <div className="pt-2">
            <StepIndicator current={step} total={2} />
          </div>
        </DialogHeader>

        {/* Step 1: Coding Agent */}
        {step === 1 && (
          <div className="space-y-3 pt-1">
            <div className="space-y-2">
              <Label htmlFor="profile" className="text-sm font-medium">
                {t('onboarding.defaultAgent')}
              </Label>
              <Select
                value={profile.executor}
                onValueChange={(v) => {
                  setProfile(
                    getOnboardingDefaultProfile({
                      executor: v as AgentKind,
                      variant: null,
                    })
                  );
                }}
              >
                <SelectTrigger id="profile">
                  <SelectValue
                    placeholder={t('onboarding.selectAgentPlaceholder')}
                  />
                </SelectTrigger>
                <SelectContent>
                  {profiles &&
                    (Object.keys(profiles) as AgentKind[])
                      .sort()
                      .map((agent) => (
                        <SelectItem key={agent} value={agent}>
                          {agent}
                        </SelectItem>
                      ))}
                </SelectContent>
              </Select>
              <AgentAvailabilityIndicator
                availability={agentAvailability}
                onQuickFix={() => void handleAgentQuickFix()}
                fixing={agentFixing}
                fixError={agentFixError}
              />
            </div>
            <p className="text-xs text-muted-foreground">
              {t('onboarding.sessionConfigHint')}
            </p>
          </div>
        )}

        {/* Step 2: Code Editor */}
        {step === 2 && (
          <div className="space-y-3 pt-1">
            <div className="space-y-2">
              <Label htmlFor="editor" className="text-sm font-medium">
                {t('onboarding.preferredEditor')}
              </Label>
              <Select
                value={editorType}
                onValueChange={(value: EditorType) => setEditorType(value)}
              >
                <SelectTrigger id="editor">
                  <SelectValue
                    placeholder={t('onboarding.selectEditorPlaceholder')}
                  />
                </SelectTrigger>
                <SelectContent>
                  {Object.values(EditorType).map((type) => (
                    <SelectItem key={type} value={type}>
                      {toPrettyCase(type)}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>

              {editorType !== EditorType.CUSTOM && (
                <EditorAvailabilityIndicator
                  availability={editorAvailability}
                />
              )}

              <p className="text-xs text-muted-foreground">
                {t('onboarding.editorUsageHint')}
              </p>

              {editorType === EditorType.CUSTOM && (
                <div className="space-y-2">
                  <Label
                    htmlFor="custom-command"
                    className="text-sm font-medium"
                  >
                    {t('onboarding.customCommand')}
                  </Label>
                  <Input
                    id="custom-command"
                    placeholder={t('onboarding.customCommandPlaceholder')}
                    value={customCommand}
                    onChange={(e) => setCustomCommand(e.target.value)}
                  />
                  <p className="text-xs text-muted-foreground">
                    {t('onboarding.customCommandHint')}
                  </p>
                </div>
              )}
            </div>
          </div>
        )}

        <DialogFooter className="flex-row gap-2 pt-2">
          {step === 2 && (
            <Button
              variant="ghost"
              size="sm"
              onClick={() => setStep(1)}
              className="mr-auto"
            >
              <ChevronLeft className="h-4 w-4 mr-1" />
              {t('onboarding.back')}
            </Button>
          )}
          {step === 1 && (
            <Button onClick={() => setStep(2)} className="flex-1">
              {t('onboarding.next')}
              <ChevronRight className="h-4 w-4 ml-1" />
            </Button>
          )}
          {step === 2 && (
            <Button
              onClick={handleComplete}
              disabled={!isStep2Valid}
              className="flex-1"
            >
              {t('onboarding.complete')}
            </Button>
          )}
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
});

export const OnboardingDialog = defineModal<void, OnboardingResult>(
  OnboardingDialogImpl
);
