import { useEffect, useState } from 'react';

import { AgentIcon, getAgentName } from '@/components/agents/AgentIcon';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Textarea } from '@/components/ui/textarea';
import { cn } from '@/lib/utils';

import { collaborationCall } from './collaborationApi';
import { MemberSessionConfigControls } from './MemberSessionConfigControls';
import {
  MemberBotAvatarPicker,
  readMemberBotAvatars,
  writeMemberBotAvatars,
  type MemberBotAvatarConfig,
} from './MemberBotAvatar';
import { COPY, surfaceErrorCopy } from './spaceModel';

function stringRecord(value: unknown): Record<string, string> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return {};
  return Object.fromEntries(
    Object.entries(value as Record<string, unknown>).filter(
      (entry): entry is [string, string] => typeof entry[1] === 'string'
    )
  );
}

function configField(
  config: Record<string, unknown> | null,
  ...keys: string[]
): string {
  if (!config) return '';
  for (const key of keys) {
    const value = config[key];
    if (typeof value === 'string' && value.trim()) return value;
  }
  return '';
}

export function AssistantDetailsCustomizeTab({
  memberId,
  conversationId,
  initialName,
  initialAvatar,
  onSaved,
}: {
  memberId: string;
  conversationId?: string | null;
  initialName: string;
  initialAvatar: MemberBotAvatarConfig;
  onSaved?: (next: { name: string; avatar: MemberBotAvatarConfig }) => void;
}) {
  const [name, setName] = useState(initialName);
  const [avatar, setAvatar] = useState(initialAvatar);
  const [agentId, setAgentId] = useState('');
  const [modeId, setModeId] = useState('');
  const [configValues, setConfigValues] = useState<Record<string, string>>({});
  const [personaPrompt, setPersonaPrompt] = useState('');
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState('');
  const [agentShaking, setAgentShaking] = useState(false);

  useEffect(() => {
    setName(initialName);
  }, [initialName]);

  useEffect(() => {
    setAvatar(initialAvatar);
  }, [initialAvatar]);

  useEffect(() => {
    if (!memberId) return;
    let active = true;
    setLoading(true);
    setError('');
    void collaborationCall<{
      config?: Record<string, unknown> | null;
    }>('collaboration', 'member.config.get', { memberId })
      .then((page) => {
        if (!active) return;
        const config = page.config ?? null;
        setAgentId(configField(config, 'agent_id', 'agentId'));
        setModeId(configField(config, 'mode_id', 'modeId'));
        setConfigValues(
          stringRecord(config?.config_values ?? config?.configValues)
        );
        setPersonaPrompt(
          configField(config, 'persona_prompt', 'personaPrompt')
        );
      })
      .catch((cause: unknown) => {
        if (active) setError(surfaceErrorCopy(cause));
      })
      .finally(() => {
        if (active) setLoading(false);
      });
    return () => {
      active = false;
    };
  }, [memberId]);

  const save = async () => {
    const trimmed = name.trim();
    if (!trimmed || !memberId || saving) return;
    setSaving(true);
    setError('');
    try {
      await collaborationCall('collaboration', 'member.update', {
        memberId,
        name: trimmed,
        avatar,
        color: avatar.color,
      });
      await collaborationCall('collaboration', 'member.config.update', {
        memberId,
        modeId,
        configValues,
        personaPrompt,
      });
      const stored = readMemberBotAvatars();
      writeMemberBotAvatars({
        ...stored,
        ...(memberId ? { [memberId]: avatar } : {}),
        ...(trimmed ? { [trimmed]: avatar } : {}),
        ...(conversationId ? { [conversationId]: avatar } : {}),
      });
      onSaved?.({ name: trimmed, avatar });
    } catch (cause) {
      setError(surfaceErrorCopy(cause));
    } finally {
      setSaving(false);
    }
  };

  const agentName = agentId ? getAgentName(agentId) : '';

  return (
    <form
      className="collaboration-assistant-details-customize"
      data-testid="collaboration-assistant-customize-form"
      onSubmit={(event) => {
        event.preventDefault();
        void save();
      }}
    >
      <div className="space-y-1.5">
        <Label>{COPY.memberNameLabel}</Label>
        <Input
          aria-label={COPY.memberNameLabel}
          value={name}
          onChange={(event) => setName(event.target.value)}
          placeholder={COPY.memberNameLabel}
          className="h-8 px-2.5 text-[13px]"
        />
      </div>

      <MemberBotAvatarPicker value={avatar} onChange={setAvatar} />

      {agentName ? (
        <div className="flex items-center gap-2">
          <Label>Agent</Label>
          <button
            type="button"
            className={cn(
              'collaboration-assistant-agent-readonly',
              agentShaking && 'is-shaking'
            )}
            data-testid="collaboration-assistant-agent-readonly"
            onClick={() => setAgentShaking(true)}
            onAnimationEnd={() => setAgentShaking(false)}
          >
            <AgentIcon agent={agentId} className="h-4 w-4" />
            <span>{agentName}</span>
          </button>
        </div>
      ) : null}

      {agentId ? (
        <MemberSessionConfigControls
          agentId={agentId}
          modeId={modeId}
          values={configValues}
          onModeId={setModeId}
          onValues={setConfigValues}
        />
      ) : null}

      <div className="space-y-1.5">
        <Label>{COPY.personaPromptLabel}</Label>
        <Textarea
          aria-label={COPY.personaPromptLabel}
          placeholder={COPY.personaPromptLabel}
          value={personaPrompt}
          onChange={(event) => setPersonaPrompt(event.target.value)}
          className="min-h-[64px] px-2.5 py-1.5 text-[13px]"
        />
      </div>

      {error ? <p className="collaboration-error">{error}</p> : null}

      <div className="flex justify-end pt-1">
        <Button
          type="submit"
          variant="primary"
          data-dialog-primary="true"
          disabled={saving || loading || !name.trim()}
        >
          {COPY.saveAssistant}
        </Button>
      </div>
    </form>
  );
}
