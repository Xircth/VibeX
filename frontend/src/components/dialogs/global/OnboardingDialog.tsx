import { useState } from 'react';
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
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu';
import { Label } from '@/components/ui/label';
import { Input } from '@/components/ui/input';
import { ChevronDown, ChevronLeft, ChevronRight } from 'lucide-react';
import { Logo } from '@/components/Logo';
import { BaseCodingAgent, EditorType } from 'shared/types';
import type { EditorConfig, ExecutorProfileId } from 'shared/types';
import { useUserSystem } from '@/components/ConfigProvider';
import { useClaudeSettings } from '@/hooks/useClaudeSettings';

import { toPrettyCase } from '@/utils/string';
import {
  getCodexModelOptions,
  getCodexVariantConfig,
  getCodexVariantFromSelection,
  getVariantOptions,
} from '@/utils/executor';
import NiceModal, { useModal } from '@ebay/nice-modal-react';
import { defineModal, type NoProps } from '@/lib/modals';
import { useEditorAvailability } from '@/hooks/useEditorAvailability';
import { EditorAvailabilityIndicator } from '@/components/EditorAvailabilityIndicator';
import { useAgentAvailability } from '@/hooks/useAgentAvailability';
import { AgentAvailabilityIndicator } from '@/components/AgentAvailabilityIndicator';
import { APP_NAME } from '@/lib/branding';
import { cn } from '@/lib/utils';

export type OnboardingResult = {
  profile: ExecutorProfileId;
  editor: EditorConfig;
};

/** Model choices mapped to ~/.claude/settings.json env keys */
const CLAUDE_MODEL_CHOICES = [
  { key: 'default', label: 'Default', envKey: 'ANTHROPIC_MODEL' },
  { key: 'haiku', label: 'Haiku', envKey: 'ANTHROPIC_DEFAULT_HAIKU_MODEL' },
  { key: 'sonnet', label: 'Sonnet', envKey: 'ANTHROPIC_DEFAULT_SONNET_MODEL' },
  { key: 'opus', label: 'Opus', envKey: 'ANTHROPIC_DEFAULT_OPUS_MODEL' },
] as const;

type ClaudeModelKey = (typeof CLAUDE_MODEL_CHOICES)[number]['key'];

function StepIndicator({ current, total }: { current: number; total: number }) {
  return (
    <div className="flex items-center gap-1.5 justify-center">
      {Array.from({ length: total }, (_, i) => (
        <div
          key={i}
          className={cn(
            'h-1.5 rounded-full transition-all',
            i + 1 === current ? 'w-4 bg-foreground' : 'w-1.5 bg-muted-foreground/30'
          )}
        />
      ))}
    </div>
  );
}

const OnboardingDialogImpl = NiceModal.create<NoProps>(() => {
  const modal = useModal();
  const { profiles, config } = useUserSystem();
  const { settings: claudeSettings } = useClaudeSettings();
  const claudeEnv = claudeSettings?.env ?? {};

  const [step, setStep] = useState<1 | 2>(1);

  const [profile, setProfile] = useState<ExecutorProfileId>(
    config?.executor_profile || {
      executor: BaseCodingAgent.CLAUDE_CODE,
      variant: null,
    }
  );
  const [claudeModel, setClaudeModel] = useState<ClaudeModelKey>('default');
  const [editorType, setEditorType] = useState<EditorType>(EditorType.VS_CODE);
  const [customCommand, setCustomCommand] = useState<string>('');

  const editorAvailability = useEditorAvailability(editorType);
  const agentAvailability = useAgentAvailability(profile.executor);

  const isClaudeCode = profile.executor === BaseCodingAgent.CLAUDE_CODE;
  const isCodex = profile.executor === BaseCodingAgent.CODEX;
  const codexModelOptions = isCodex ? getCodexModelOptions(profiles) : [];
  const codexVariantConfig = isCodex
    ? getCodexVariantConfig(profiles, profile.variant ?? null)
    : null;

  const handleComplete = () => {
    modal.resolve({
      profile,
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
            设置编码偏好，稍后可在设置中修改。
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
                默认 Agent
              </Label>
              <Select
                value={profile.executor}
                onValueChange={(v) => {
                  setProfile({ executor: v as BaseCodingAgent, variant: null });
                  setClaudeModel('default');
                }}
              >
                <SelectTrigger id="profile">
                  <SelectValue placeholder="选择编码代理" />
                </SelectTrigger>
                <SelectContent>
                  {profiles &&
                    (Object.keys(profiles) as BaseCodingAgent[])
                      .sort()
                      .map((agent) => (
                        <SelectItem key={agent} value={agent}>
                          {agent}
                        </SelectItem>
                      ))}
                </SelectContent>
              </Select>
              <AgentAvailabilityIndicator availability={agentAvailability} />
            </div>

            {/* Claude Code: show model choices from settings.json */}
            {isClaudeCode && (
              <div className="space-y-2">
                <Label className="text-sm font-medium">模型配置</Label>
                <div className="grid grid-cols-2 gap-1.5">
                  {CLAUDE_MODEL_CHOICES.map((model) => {
                    const modelId = claudeEnv[model.envKey];
                    const isSelected = claudeModel === model.key;
                    return (
                      <button
                        key={model.key}
                        onClick={() => setClaudeModel(model.key)}
                        className={cn(
                          'flex flex-col items-start rounded-md border px-3 py-2 text-left transition-colors',
                          isSelected
                            ? 'border-foreground/40 bg-muted'
                            : 'border-border hover:bg-muted/50'
                        )}
                      >
                        <span className="text-sm font-medium">{model.label}</span>
                        {modelId && (
                          <span className="text-[10px] text-muted-foreground truncate w-full">
                            {modelId}
                          </span>
                        )}
                      </button>
                    );
                  })}
                </div>
                <p className="text-xs text-muted-foreground">
                  读取自 ~/.claude/settings.json
                </p>
              </div>
            )}

            {!isClaudeCode && isCodex && codexModelOptions.length > 0 && (
              <div className="space-y-2">
                <Label className="text-sm font-medium">模型</Label>
                <DropdownMenu>
                  <DropdownMenuTrigger asChild>
                    <Button
                      variant="outline"
                      className="w-full px-3 flex items-center justify-between"
                    >
                      <span className="text-sm truncate">
                        {codexModelOptions.find(
                          (option) => option.value === codexVariantConfig?.model
                        )?.label ?? codexModelOptions[0]?.label ?? 'Default'}
                      </span>
                      <ChevronDown className="h-3.5 w-3.5 ml-1 shrink-0" />
                    </Button>
                  </DropdownMenuTrigger>
                  <DropdownMenuContent className="w-[var(--radix-dropdown-menu-trigger-width)]">
                    {codexModelOptions.map((option) => (
                      <DropdownMenuItem
                        key={option.value ?? 'DEFAULT'}
                        onClick={() =>
                          setProfile({
                            ...profile,
                            variant: getCodexVariantFromSelection(
                              profiles,
                              option.value,
                              codexVariantConfig?.permissionMode ?? 'auto'
                            ),
                          })
                        }
                        className={
                          codexVariantConfig?.model === option.value ? 'bg-muted' : ''
                        }
                      >
                        {option.label}
                      </DropdownMenuItem>
                    ))}
                  </DropdownMenuContent>
                </DropdownMenu>
              </div>
            )}

            {/* Non-Claude agents: show profile variants */}
            {!isClaudeCode && !isCodex && (() => {
              const variantOptions = getVariantOptions(profile.executor, profiles);
              if (variantOptions.length === 0) return null;
              const selectedVariant = profile.variant ?? 'DEFAULT';

              return (
                <div className="space-y-2">
                  <Label className="text-sm font-medium">变体</Label>
                  <DropdownMenu>
                    <DropdownMenuTrigger asChild>
                      <Button
                        variant="outline"
                        className="w-full px-3 flex items-center justify-between"
                      >
                        <span className="text-sm truncate">
                          {selectedVariant}
                        </span>
                        <ChevronDown className="h-3.5 w-3.5 ml-1 shrink-0" />
                      </Button>
                    </DropdownMenuTrigger>
                    <DropdownMenuContent className="w-[var(--radix-dropdown-menu-trigger-width)]">
                      {variantOptions.map((variant) => (
                        <DropdownMenuItem
                          key={variant}
                          onClick={() =>
                            setProfile({
                              ...profile,
                              variant: variant === 'DEFAULT' ? null : variant,
                            })
                          }
                          className={
                            selectedVariant === variant ? 'bg-muted' : ''
                          }
                        >
                          {variant}
                        </DropdownMenuItem>
                      ))}
                    </DropdownMenuContent>
                  </DropdownMenu>
                </div>
              );
            })()}
          </div>
        )}

        {/* Step 2: Code Editor */}
        {step === 2 && (
          <div className="space-y-3 pt-1">
            <div className="space-y-2">
              <Label htmlFor="editor" className="text-sm font-medium">
                首选编辑器
              </Label>
              <Select
                value={editorType}
                onValueChange={(value: EditorType) => setEditorType(value)}
              >
                <SelectTrigger id="editor">
                  <SelectValue placeholder="选择编辑器" />
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
                <EditorAvailabilityIndicator availability={editorAvailability} />
              )}

              <p className="text-xs text-muted-foreground">
                此编辑器用于打开任务和项目文件。
              </p>

              {editorType === EditorType.CUSTOM && (
                <div className="space-y-2">
                  <Label htmlFor="custom-command" className="text-sm font-medium">
                    自定义命令
                  </Label>
                  <Input
                    id="custom-command"
                    placeholder="例如: code, subl, vim"
                    value={customCommand}
                    onChange={(e) => setCustomCommand(e.target.value)}
                  />
                  <p className="text-xs text-muted-foreground">
                    输入编辑器的启动命令，可使用空格添加参数。
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
              上一步
            </Button>
          )}
          {step === 1 && (
            <Button onClick={() => setStep(2)} className="flex-1">
              下一步
              <ChevronRight className="h-4 w-4 ml-1" />
            </Button>
          )}
          {step === 2 && (
            <Button
              onClick={handleComplete}
              disabled={!isStep2Valid}
              className="flex-1"
            >
              完成
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
