import { useEffect, useState } from 'react';
import {
  Bot,
  Cpu,
  Eraser,
  ExternalLink,
  Lock,
  Plus,
  Shield,
  Trash2,
  User,
} from 'lucide-react';
import { useTranslation } from 'react-i18next';

import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';
import { Switch } from '@/components/ui/switch';
import { toast } from '@/components/ui/toast';
import { getInvokeErrorMessage } from '@/lib/errors';
import { cn } from '@/lib/utils';
import { SettingsSection } from '@/pages/settings/SettingsUi';

import {
  clearBrowserProfile,
  clearOriginGrants,
  createBrowserProfile,
  loadBrowserPrefs,
  removeBrowserProfile,
  updateBrowserSettings,
  useBrowserPrefs,
  validateHostRulePattern,
  type BrowserGrantLevel,
  type BrowserHostRule,
  type BrowserRuleAction,
  type EvalApprovalMode,
  type LinkOpenSource,
  type LinkOpenTarget,
} from './browserPrefsStore';

const LINK_SOURCES: readonly LinkOpenSource[] = [
  'transcript',
  'toolCard',
  'terminal',
  'editor',
  'notification',
];

const LINK_TARGETS: readonly LinkOpenTarget[] = ['builtin', 'system', 'ask'];

const RULE_ACTIONS: readonly BrowserRuleAction[] = [
  'builtin',
  'system',
  'block',
];

const GRANT_LEVELS: readonly BrowserGrantLevel[] = ['control', 'read', 'none'];

const EVAL_APPROVAL_MODES: readonly EvalApprovalMode[] = ['ask', 'silent'];

function ruleActionKey(action: BrowserRuleAction): string {
  switch (action) {
    case 'builtin':
      return 'browser.rules.actionBuiltin';
    case 'system':
      return 'browser.rules.actionSystem';
    case 'block':
      return 'browser.rules.actionBlock';
  }
}

export function HostBrowserSettingsPage({ pluginId }: { pluginId?: string }) {
  const { t } = useTranslation('settings');
  const { settings, capabilities } = useBrowserPrefs();
  const [rulePattern, setRulePattern] = useState('');
  const [ruleAction, setRuleAction] = useState<BrowserRuleAction>('system');
  const [ruleError, setRuleError] = useState<string | null>(null);
  const [profileDraft, setProfileDraft] = useState('');
  const [profileError, setProfileError] = useState<string | null>(null);
  const [busyProfile, setBusyProfile] = useState<string | null>(null);
  const [confirmClearProfile, setConfirmClearProfile] = useState<string | null>(
    null
  );

  useEffect(() => {
    void loadBrowserPrefs(pluginId);
  }, [pluginId]);

  const setLinkTarget = (source: LinkOpenSource, target: LinkOpenTarget) => {
    void updateBrowserSettings(
      {
        defaultTarget: {
          ...settings.defaultTarget,
          [source]: target,
        },
      },
      pluginId
    );
  };

  const addRule = () => {
    const code = validateHostRulePattern(rulePattern);
    if (code) {
      setRuleError(t(`browser.rules.errors.${code}`));
      return;
    }
    const pattern = rulePattern.trim();
    const duplicate = settings.hostRules.some(
      (rule) =>
        rule.pattern.toLowerCase() === pattern.toLowerCase() &&
        rule.action === ruleAction
    );
    if (duplicate) {
      setRuleError(t('browser.rules.errors.duplicate'));
      return;
    }
    const next: BrowserHostRule[] = [
      ...settings.hostRules,
      { pattern, action: ruleAction },
    ];
    setRulePattern('');
    setRuleError(null);
    void updateBrowserSettings({ hostRules: next }, pluginId);
  };

  const removeRule = (index: number) => {
    const next = settings.hostRules.filter((_, idx) => idx !== index);
    void updateBrowserSettings({ hostRules: next }, pluginId);
  };

  const handleCreateProfile = async () => {
    const trimmed = profileDraft.trim();
    if (!trimmed || trimmed.length > 36) {
      setProfileError(t('browser.profiles.invalidName'));
      return;
    }
    setProfileError(null);
    setBusyProfile(trimmed);
    try {
      await createBrowserProfile(trimmed, pluginId);
      setProfileDraft('');
      toast.success(t('browser.profiles.created', { name: trimmed }));
    } catch (error) {
      toast.error(t('browser.profiles.actionFailed'), {
        description: getInvokeErrorMessage(error),
      });
    } finally {
      setBusyProfile(null);
    }
  };

  const handleClearProfile = async (id: string) => {
    setBusyProfile(id);
    try {
      await clearBrowserProfile(id, pluginId);
      setConfirmClearProfile(null);
      toast.success(t('browser.profiles.cleared', { name: id }));
    } catch (error) {
      toast.error(t('browser.profiles.actionFailed'), {
        description: getInvokeErrorMessage(error),
      });
    } finally {
      setBusyProfile(null);
    }
  };

  const handleRemoveProfile = async (id: string) => {
    setBusyProfile(id);
    try {
      await removeBrowserProfile(id, pluginId);
      toast.success(t('browser.profiles.removed', { name: id }));
    } catch (error) {
      toast.error(t('browser.profiles.actionFailed'), {
        description: getInvokeErrorMessage(error),
      });
    } finally {
      setBusyProfile(null);
    }
  };

  const policyRules = capabilities?.policy?.managedRules ?? [];
  const profileCards = (() => {
    const seen = new Set<string>();
    const list: Array<{ id: string; label: string }> = [];
    for (const item of settings.profiles) {
      if (item.id === 'ephemeral') continue;
      if (!seen.has(item.id)) {
        seen.add(item.id);
        list.push({
          id: item.id,
          label:
            item.id === 'default' &&
            (!item.label || item.label.toLowerCase() === 'default')
              ? '默认'
              : item.label || item.id,
        });
      }
    }
    if (!seen.has('default')) {
      list.unshift({ id: 'default', label: '默认' });
    }
    return list;
  })();

  const newTabProfileOptions = [
    ...profileCards,
    { id: 'ephemeral', label: t('browser.profiles.ephemeralName') },
  ];

  const rememberedOriginCount = Object.keys(settings.originGrants).length;
  const proxyNote =
    capabilities?.proxy?.note || capabilities?.proxy?.active || null;

  return (
    <div className="settings-content">
      <div className="settings-sections">
        <SettingsSection
          icon={ExternalLink}
          title={t('browser.links.title')}
          description={t('browser.links.description')}
        >
          <div className="space-y-3">
            {LINK_SOURCES.map((source) => (
              <div key={source} className="settings-row">
                <Label>{t(`browser.links.${source}`)}</Label>
                <Select
                  value={settings.defaultTarget[source]}
                  onValueChange={(value) =>
                    setLinkTarget(source, value as LinkOpenTarget)
                  }
                >
                  <SelectTrigger className="!w-48">
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent align="end">
                    {LINK_TARGETS.map((target) => (
                      <SelectItem key={target} value={target}>
                        {t(
                          target === 'builtin'
                            ? 'browser.links.targetBuiltin'
                            : target === 'system'
                              ? 'browser.links.targetSystem'
                              : 'browser.links.targetAsk'
                        )}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </div>
            ))}
          </div>
        </SettingsSection>

        <SettingsSection
          icon={Shield}
          title="配置与站点规则"
          description="管理多套独立的浏览器配置文件（Cookie、LocalStorage 与登录态互不干扰），并按域名定制打开方式或拦截策略。"
        >
          <div className="space-y-5">
            <div className="space-y-2.5">
              <div>
                <div className="text-sm font-medium">配置文件</div>
                <p className="settings-row__description">
                  每个配置文件维护独立的登录状态与站点存储。清除数据会关闭该配置文件下已打开的标签页。
                </p>
              </div>

              <div className="space-y-1.5">
                {profileCards.map((profile) => {
                  const isDefault = profile.id === 'default';
                  const isBusy = busyProfile === profile.id;
                  const confirmingClear = confirmClearProfile === profile.id;
                  return (
                    <div
                      key={profile.id}
                      className="flex min-h-10 items-center justify-between gap-2.5 rounded-md border border-border/60 bg-muted/20 px-3 py-1.5 text-xs"
                    >
                      <div className="flex min-w-0 items-center gap-2">
                        <User className="h-3.5 w-3.5 shrink-0 text-muted-foreground" />
                        <span className="truncate font-medium text-foreground">
                          {profile.label}
                        </span>
                      </div>
                      <div className="flex shrink-0 items-center gap-1">
                        {confirmingClear ? (
                          <>
                            <Button
                              type="button"
                              size="sm"
                              variant="destructive"
                              className="h-7 px-2.5 text-xs"
                              disabled={isBusy}
                              onClick={() =>
                                void handleClearProfile(profile.id)
                              }
                            >
                              {t('browser.profiles.confirmClear')}
                            </Button>
                            <Button
                              type="button"
                              size="sm"
                              variant="ghost"
                              className="h-7 px-2 text-xs"
                              disabled={isBusy}
                              onClick={() => setConfirmClearProfile(null)}
                            >
                              {t('browser.profiles.cancel')}
                            </Button>
                          </>
                        ) : (
                          <>
                            <Button
                              type="button"
                              size="sm"
                              variant="ghost"
                              className="h-7 w-7 p-0 text-muted-foreground hover:text-foreground"
                              title={t('browser.profiles.clearData')}
                              aria-label={t('browser.profiles.clearData')}
                              disabled={isBusy}
                              onClick={() => setConfirmClearProfile(profile.id)}
                            >
                              <Eraser className="h-3.5 w-3.5" />
                            </Button>
                            {!isDefault ? (
                              <Button
                                type="button"
                                size="sm"
                                variant="ghost"
                                className="h-7 w-7 p-0 text-muted-foreground hover:text-destructive"
                                title={t('browser.profiles.deleteProfile')}
                                aria-label={t('browser.profiles.deleteProfile')}
                                disabled={isBusy}
                                onClick={() =>
                                  void handleRemoveProfile(profile.id)
                                }
                              >
                                <Trash2 className="h-3.5 w-3.5" />
                              </Button>
                            ) : null}
                          </>
                        )}
                      </div>
                    </div>
                  );
                })}
              </div>

              <div className="space-y-1.5">
                <div className="flex items-center gap-2">
                  <Input
                    value={profileDraft}
                    onChange={(event) => {
                      setProfileDraft(event.target.value);
                      if (profileError) setProfileError(null);
                    }}
                    onKeyDown={(event) => {
                      if (event.key === 'Enter') {
                        event.preventDefault();
                        void handleCreateProfile();
                      }
                    }}
                    placeholder="配置文件名称，例如「工作」"
                    aria-invalid={Boolean(profileError)}
                    className="flex-1 text-xs"
                  />
                  <Button
                    type="button"
                    size="sm"
                    variant="outline"
                    className="rounded-full"
                    disabled={!profileDraft.trim() || busyProfile !== null}
                    onClick={() => void handleCreateProfile()}
                  >
                    <Plus className="mr-1.5 h-3.5 w-3.5" />
                    添加配置文件
                  </Button>
                </div>
                {profileError ? (
                  <p className="text-xs text-destructive" role="alert">
                    {profileError}
                  </p>
                ) : null}
              </div>

              <div className="settings-row pt-1">
                <div>
                  <Label>新标签页使用</Label>
                  <p className="settings-row__description">
                    未显式指定配置文件时，新建内置浏览器标签页默认挂载的配置文件。
                  </p>
                </div>
                <Select
                  value={settings.newTabProfile}
                  onValueChange={(value) =>
                    void updateBrowserSettings(
                      { newTabProfile: value },
                      pluginId
                    )
                  }
                >
                  <SelectTrigger className="!w-44">
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent align="end">
                    {newTabProfileOptions.map((item) => (
                      <SelectItem key={item.id} value={item.id}>
                        {item.label}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </div>
            </div>

            <div className="space-y-3 border-t border-border/60 pt-4">
              <div>
                <div className="text-sm font-medium">
                  {t('browser.rules.title')}
                </div>
                <p className="settings-row__description">
                  {t('browser.rules.description')}
                </p>
              </div>

              {capabilities?.policy?.path ||
              capabilities?.policy?.source === 'file' ? (
                <div className="flex items-start gap-2 rounded-md border border-border/60 bg-muted/30 px-3 py-2 text-xs text-muted-foreground">
                  <Lock className="mt-0.5 h-3.5 w-3.5 shrink-0" />
                  <div className="min-w-0 flex-1">
                    <p className="font-medium text-foreground">
                      {t('browser.rules.policyManaged')}
                    </p>
                    {capabilities.policy.path ? (
                      <p className="truncate font-mono text-[11px]">
                        {capabilities.policy.path}
                      </p>
                    ) : null}
                  </div>
                </div>
              ) : null}

              {policyRules.length > 0 ? (
                <div className="divide-y divide-border/50 rounded-md border border-border/60">
                  {policyRules.map((rule, index) => (
                    <div
                      key={`policy-${rule.pattern}-${rule.action}-${index}`}
                      className="flex items-center justify-between gap-2 px-3 py-2 text-xs"
                    >
                      <div className="flex min-w-0 items-center gap-2">
                        <Lock className="h-3 w-3 shrink-0 text-muted-foreground" />
                        <code className="truncate font-mono">
                          {rule.pattern}
                        </code>
                      </div>
                      <div className="flex shrink-0 items-center gap-2 text-muted-foreground">
                        <span>{t(ruleActionKey(rule.action))}</span>
                        <span className="rounded bg-muted px-1.5 py-0.5 text-[10px]">
                          {t('browser.rules.policyRule')}
                        </span>
                      </div>
                    </div>
                  ))}
                </div>
              ) : null}

              <div className="space-y-1.5">
                <div className="flex flex-wrap items-center gap-2">
                  <Input
                    value={rulePattern}
                    onChange={(event) => {
                      setRulePattern(event.target.value);
                      if (ruleError) setRuleError(null);
                    }}
                    onKeyDown={(event) => {
                      if (event.key === 'Enter') {
                        event.preventDefault();
                        addRule();
                      }
                    }}
                    placeholder={t('browser.rules.patternPlaceholder')}
                    aria-invalid={Boolean(ruleError)}
                    className="min-w-[14rem] flex-1 font-mono text-xs"
                  />
                  <Select
                    value={ruleAction}
                    onValueChange={(value) =>
                      setRuleAction(value as BrowserRuleAction)
                    }
                  >
                    <SelectTrigger className="!w-44">
                      <SelectValue />
                    </SelectTrigger>
                    <SelectContent align="end">
                      {RULE_ACTIONS.map((action) => (
                        <SelectItem key={action} value={action}>
                          {t(ruleActionKey(action))}
                        </SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                  <Button
                    type="button"
                    size="sm"
                    variant="outline"
                    disabled={!rulePattern.trim()}
                    onClick={addRule}
                  >
                    <Plus className="mr-1.5 h-3.5 w-3.5" />
                    {t('browser.rules.addRule')}
                  </Button>
                </div>
                {ruleError ? (
                  <p className="text-xs text-destructive" role="alert">
                    {ruleError}
                  </p>
                ) : null}
              </div>

              {settings.hostRules.length === 0 ? (
                <p className="text-xs text-muted-foreground">
                  {t('browser.rules.empty')}
                </p>
              ) : (
                <div className="divide-y divide-border/50 rounded-md border border-border/60">
                  {settings.hostRules.map((rule, index) => (
                    <div
                      key={`${rule.pattern}-${rule.action}-${index}`}
                      className="flex items-center justify-between gap-2 px-3 py-2 text-xs"
                    >
                      <code className="min-w-0 flex-1 truncate font-mono">
                        {rule.pattern}
                      </code>
                      <span
                        className={cn(
                          'shrink-0 rounded px-1.5 py-0.5 text-[11px]',
                          rule.action === 'block'
                            ? 'bg-destructive/10 text-destructive'
                            : 'bg-muted text-muted-foreground'
                        )}
                      >
                        {t(ruleActionKey(rule.action))}
                      </span>
                      <Button
                        type="button"
                        variant="ghost"
                        size="sm"
                        className="h-7 w-7 p-0 text-muted-foreground hover:text-destructive"
                        aria-label={t('browser.rules.removeRule')}
                        onClick={() => removeRule(index)}
                      >
                        <Trash2 className="h-3.5 w-3.5" />
                      </Button>
                    </div>
                  ))}
                </div>
              )}
            </div>
          </div>
        </SettingsSection>

        <SettingsSection
          icon={Bot}
          title={t('browser.agent.title')}
          description={t('browser.agent.description')}
        >
          <div className="space-y-4">
            <div className="settings-row">
              <div>
                <Label
                  htmlFor="browser-agent-tools-enabled"
                  className="cursor-pointer"
                >
                  {t('browser.agent.toolsEnabled')}
                </Label>
                <p className="settings-row__description">
                  {t('browser.agent.toolsEnabledHint')}
                </p>
              </div>
              <Switch
                id="browser-agent-tools-enabled"
                className="settings-switch"
                checked={settings.toolsEnabled}
                onCheckedChange={(checked) =>
                  void updateBrowserSettings(
                    { toolsEnabled: checked },
                    pluginId
                  )
                }
              />
            </div>

            <div className="settings-row">
              <div>
                <Label>{t('browser.agent.defaultGrant')}</Label>
                <p className="settings-row__description">
                  {t('browser.agent.defaultGrantHint')}
                </p>
              </div>
              <Select
                value={settings.defaultGrant}
                disabled={!settings.toolsEnabled}
                onValueChange={(value) =>
                  void updateBrowserSettings(
                    {
                      defaultGrant: value as BrowserGrantLevel,
                    },
                    pluginId
                  )
                }
              >
                <SelectTrigger className="!w-56">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent align="end">
                  {GRANT_LEVELS.map((level) => (
                    <SelectItem key={level} value={level}>
                      {t(
                        level === 'control'
                          ? 'browser.agent.grantControl'
                          : level === 'read'
                            ? 'browser.agent.grantRead'
                            : 'browser.agent.grantNone'
                      )}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>

            <div className="settings-row">
              <div>
                <Label
                  htmlFor="browser-agent-eval-enabled"
                  className="cursor-pointer"
                >
                  {t('browser.agent.evalEnabled')}
                </Label>
                <p className="settings-row__description">
                  {t('browser.agent.evalEnabledHint')}
                </p>
              </div>
              <Switch
                id="browser-agent-eval-enabled"
                className="settings-switch"
                checked={settings.evalEnabled}
                disabled={!settings.toolsEnabled}
                onCheckedChange={(checked) =>
                  void updateBrowserSettings({ evalEnabled: checked }, pluginId)
                }
              />
            </div>

            {settings.toolsEnabled && settings.evalEnabled ? (
              <div className="settings-row">
                <Label>{t('browser.agent.evalApproval')}</Label>
                <Select
                  value={settings.evalApproval}
                  onValueChange={(value) =>
                    void updateBrowserSettings(
                      {
                        evalApproval: value as EvalApprovalMode,
                      },
                      pluginId
                    )
                  }
                >
                  <SelectTrigger className="!w-56">
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent align="end">
                    {EVAL_APPROVAL_MODES.map((mode) => (
                      <SelectItem key={mode} value={mode}>
                        {t(
                          mode === 'ask'
                            ? 'browser.agent.evalApprovalAsk'
                            : 'browser.agent.evalApprovalSilent'
                        )}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </div>
            ) : null}

            {rememberedOriginCount > 0 ? (
              <div className="settings-row">
                <div>
                  <Label>{t('browser.agent.rememberedOrigins')}</Label>
                  <p className="settings-row__description">
                    {t('browser.agent.rememberedOriginsCount', {
                      count: rememberedOriginCount,
                    })}
                  </p>
                </div>
                <Button
                  type="button"
                  size="sm"
                  variant="outline"
                  onClick={() => {
                    void clearOriginGrants(pluginId).then(() => {
                      toast.success(t('browser.agent.originsCleared'));
                    });
                  }}
                >
                  {t('browser.agent.clearOrigins')}
                </Button>
              </div>
            ) : null}
          </div>
        </SettingsSection>

        <SettingsSection icon={Cpu} title={t('browser.runtime.title')}>
          <div className="space-y-4">
            <div className="settings-row">
              <Label htmlFor="browser-devtools" className="cursor-pointer">
                {t('browser.runtime.devtools')}
              </Label>
              <Switch
                id="browser-devtools"
                className="settings-switch"
                checked={settings.devtools}
                onCheckedChange={(checked) =>
                  void updateBrowserSettings({ devtools: checked }, pluginId)
                }
              />
            </div>

            <div className="settings-row">
              <div>
                <Label
                  htmlFor="browser-suspend-background"
                  className="cursor-pointer"
                >
                  {t('browser.runtime.suspendBackgroundTabs')}
                </Label>
                <p className="settings-row__description">
                  {t('browser.runtime.suspendBackgroundTabsHint')}
                </p>
              </div>
              <Switch
                id="browser-suspend-background"
                className="settings-switch"
                checked={settings.suspendBackgroundTabs}
                onCheckedChange={(checked) =>
                  void updateBrowserSettings(
                    {
                      suspendBackgroundTabs: checked,
                    },
                    pluginId
                  )
                }
              />
            </div>

            <div className="settings-row">
              <div>
                <Label htmlFor="browser-signin-ua" className="cursor-pointer">
                  {t('browser.runtime.signInUserAgent')}
                </Label>
                <p className="settings-row__description">
                  {t('browser.runtime.signInUserAgentHint')}
                </p>
              </div>
              <Switch
                id="browser-signin-ua"
                className="settings-switch"
                checked={settings.signInUserAgent}
                onCheckedChange={(checked) =>
                  void updateBrowserSettings(
                    { signInUserAgent: checked },
                    pluginId
                  )
                }
              />
            </div>

            {proxyNote ? (
              <div className="settings-row">
                <div>
                  <Label>{t('browser.runtime.proxyNote')}</Label>
                  <p className="settings-row__description">{proxyNote}</p>
                </div>
              </div>
            ) : null}

            {capabilities?.downloadsDir ? (
              <div className="settings-row">
                <Label>{t('browser.runtime.downloadsDir')}</Label>
                <span className="max-w-xs truncate font-mono text-xs text-muted-foreground">
                  {capabilities.downloadsDir}
                </span>
              </div>
            ) : null}
          </div>
        </SettingsSection>
      </div>
    </div>
  );
}
