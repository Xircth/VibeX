import { useState } from 'react';
import {
  Bot,
  MessageSquare,
  UserPlus,
} from 'lucide-react';

import { Button } from '@/components/ui/button';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';

import { Textarea } from '@/components/ui/textarea';
import { AgentIcon, getAgentName } from '@/components/agents/AgentIcon';
import {
  SegmentedControl,
  SegmentedControlItem,
} from '@astryxdesign/core/SegmentedControl';
import type { ExecutorProfileId } from 'shared/types';

import {
  MemberBotAvatarPicker,
  randomMemberBotAvatar,
  type MemberBotAvatarConfig,
} from './MemberBotAvatar';
import {
  CollaborationOptionSelect,
  CustomAgentControls,
  type CollaborationSelectOption,
} from './memberFormControls';
import { COPY as SPACE_COPY } from './spaceModel';
import {
  type PresenceView,
} from './threadModel';

export const DIALOG_COPY = {
  groupTitle: '新建群聊',
  groupDescription:
    '选择要拉进群的成员。每个成员在群里有独立会话，忙碌或休眠的成员也可以选。',
  groupName: '群聊名称',
  groupNamePlaceholder: '例如：登录重构',
  groupMembers: '成员',
  groupNoMembers: '还没有成员，先新建一个。',
  groupCreate: '创建群聊',
  newMemberInline: '新建成员…',
  memberTitle: '新建成员',
  memberDescription: '从模板开始，之后可以在资料里调整记忆与写入方式。',
  memberTemplate: '模板',
  memberNickname: '昵称',
  memberAgent: 'Agent',
  memberCreate: '创建并私聊',
  cancel: '取消',
} as const;

export type PickerMember = {
  memberId: string;
  nickname: string;
  avatar: MemberBotAvatarConfig;
  presence: PresenceView;
};

export type RoleTemplate = {
  id: string;
  name: string;
  summary?: string;
  agent_id: string;
};

export type AgentOption = { agent_id: string; name: string };

export type NewMemberSource = 'role' | 'custom';

export type NewMemberInput = {
  nickname: string;
  avatar: MemberBotAvatarConfig;
  source: NewMemberSource;
  roleId?: string;
  agentId?: string;
  modeId?: string;
  configValues?: Record<string, string>;
  personaPrompt?: string;
};

/**
 * Pre-redesign member form (from CollaborationSpacePage): name, bot avatar,
 * creation source (role or custom agent). No template is mandatory ? the
 * custom source works without any role.
 */
export function NewMemberDialog({
  open,
  roles,
  agents,
  busy,
  onOpenChange,
  onCreate,
}: {
  open: boolean;
  roles: readonly RoleTemplate[];
  agents: readonly AgentOption[];
  busy?: boolean;
  onOpenChange: (open: boolean) => void;
  onCreate: (input: NewMemberInput) => void;
}) {
  const [nickname, setNickname] = useState('');
  const [avatar, setAvatar] = useState<MemberBotAvatarConfig>(() =>
    randomMemberBotAvatar()
  );
  const [source, setSource] = useState<NewMemberSource>(
    roles.length > 0 ? 'role' : 'custom'
  );
  const [roleId, setRoleId] = useState(roles[0]?.id ?? '');
  const [agentId, setAgentId] = useState(agents[0]?.agent_id ?? '');
  const [modeId, setModeId] = useState('');
  const [configValues, setConfigValues] = useState<Record<string, string>>({});
  const [personaPrompt, setPersonaPrompt] = useState('');

  const roleOptions: CollaborationSelectOption[] = [
    { value: '', label: SPACE_COPY.chooseRole },
    ...roles.map((role) => ({
      value: role.id,
      label: `${role.name} (${getAgentName(role.agent_id) || role.agent_id})`,
      icon: role.agent_id ? (
        <AgentIcon
          agent={role.agent_id as ExecutorProfileId['executor']}
          className="h-3.5 w-3.5 shrink-0"
        />
      ) : undefined,
    })),
  ];
  const agentOptions: CollaborationSelectOption[] = [
    { value: '', label: SPACE_COPY.chooseAgent },
    ...agents.map((agent) => ({
      value: agent.agent_id,
      label: getAgentName(agent.agent_id) || agent.name || agent.agent_id,
      icon: (
        <AgentIcon
          agent={agent.agent_id as ExecutorProfileId['executor']}
          className="h-3.5 w-3.5 shrink-0"
        />
      ),
    })),
  ];
  const trimmed = nickname.trim();
  const canSubmit =
    !busy && !!trimmed && (source === 'role' ? !!roleId : !!agentId);

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent data-testid="collab-new-member-dialog">
        <DialogHeader>
          <DialogTitle>{DIALOG_COPY.memberTitle}</DialogTitle>
          <DialogDescription>{DIALOG_COPY.memberDescription}</DialogDescription>
        </DialogHeader>
        <form
          className="collab-form"
          onSubmit={(event) => {
            event.preventDefault();
            if (!canSubmit) return;
            onCreate(
              source === 'role'
                ? { nickname: trimmed, avatar, source, roleId }
                : {
                    nickname: trimmed,
                    avatar,
                    source,
                    agentId,
                    modeId: modeId || undefined,
                    configValues,
                    personaPrompt: personaPrompt.trim() || undefined,
                  }
            );
          }}
        >
          <div className="collab-form-field">
            <Label htmlFor="collab-member-nickname">
              {SPACE_COPY.memberNameLabel}
            </Label>
            <Input
              id="collab-member-nickname"
              aria-label={SPACE_COPY.memberNameLabel}
              placeholder={SPACE_COPY.memberNameLabel}
              value={nickname}
              onChange={(event) => setNickname(event.target.value)}
            />
          </div>
          <MemberBotAvatarPicker value={avatar} onChange={setAvatar} compact />
          <div className="collab-form-field">
            <Label>{SPACE_COPY.memberSourceLabel}</Label>
            <SegmentedControl
              label={SPACE_COPY.memberSourceLabel}
              size="sm"
              layout="hug"
              className="collaboration-compact-segmented"
              value={source}
              onChange={(next) => setSource(next as NewMemberSource)}
            >
              <SegmentedControlItem
                value="role"
                label={SPACE_COPY.memberSourceRole}
                icon={<Bot className="h-3 w-3 shrink-0" aria-hidden="true" />}
              />
              <SegmentedControlItem
                value="custom"
                label={SPACE_COPY.memberSourceCustom}
                icon={
                  <UserPlus className="h-3 w-3 shrink-0" aria-hidden="true" />
                }
              />
            </SegmentedControl>
          </div>
          {source === 'role' ? (
            <CollaborationOptionSelect
              ariaLabel={SPACE_COPY.chooseRole}
              value={roleId}
              placeholder={SPACE_COPY.chooseRole}
              options={roleOptions}
              onChange={setRoleId}
            />
          ) : (
            <>
              <CollaborationOptionSelect
                ariaLabel={SPACE_COPY.chooseAgent}
                value={agentId}
                placeholder={SPACE_COPY.chooseAgent}
                options={agentOptions}
                onChange={(next) => {
                  setAgentId(next);
                  setModeId('');
                  setConfigValues({});
                }}
              />
              <CustomAgentControls
                agentId={agentId}
                modeId={modeId}
                values={configValues}
                onModeId={setModeId}
                onValues={setConfigValues}
              />
              <div className="collab-form-field">
                <Label htmlFor="collab-member-persona">
                  {SPACE_COPY.personaPromptLabel}
                </Label>
                <Textarea
                  id="collab-member-persona"
                  value={personaPrompt}
                  onChange={(event) => setPersonaPrompt(event.target.value)}
                />
              </div>
            </>
          )}
          <DialogFooter>
            <Button
              type="button"
              variant="secondary"
              onClick={() => onOpenChange(false)}
            >
              {DIALOG_COPY.cancel}
            </Button>
            <Button type="submit" disabled={!canSubmit}>
              <MessageSquare className="h-3.5 w-3.5" aria-hidden="true" />
              {DIALOG_COPY.memberCreate}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}
