import { useState } from 'react';
import {
  ArrowRight,
  Check,
  MessageSquare,
  UserPlus,
  UserRound,
  Users,
} from 'lucide-react';

import { Button } from '@/components/ui/button';
import { Checkbox } from '@/components/ui/checkbox';
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
import { cn } from '@/lib/utils';

import { MemberBotAvatar, type MemberBotAvatarConfig } from './MemberBotAvatar';
import {
  TEAM_TEMPLATES,
  THREAD_COPY,
  type PresenceView,
  type TeamTemplate,
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
  migrationTitle: '协作已升级为「成员 + 群聊」',
  migrationDescription: '你的数据都在，只是换了组织方式：',
  migrationSpaces: '原来的协作空间 → 群聊（名称、成员、消息、收藏都保留）',
  migrationMembers: '空间里的成员 → 成员（同一身份去重，带着自己的记忆）',
  migrationUndecided: '未归类的成员会话 → 与该成员的私聊',
  migrationOk: '知道了',
  teamTitle: '一键建队',
  teamDescription: '还没有成员。选一个模板，马上拥有一支小队和一个群聊。',
  teamCreate: '创建小队',
  bannerText: '协作已升级为成员 + 群聊。',
  bannerMore: '了解变化',
  bannerDismiss: '关闭',
} as const;

export type PickerMember = {
  memberId: string;
  nickname: string;
  avatar: MemberBotAvatarConfig;
  presence: PresenceView;
};

export function NewGroupDialog({
  open,
  members,
  initialSelected = [],
  busy,
  onOpenChange,
  onCreate,
  onNewMember,
}: {
  open: boolean;
  members: readonly PickerMember[];
  initialSelected?: readonly string[];
  busy?: boolean;
  onOpenChange: (open: boolean) => void;
  onCreate: (name: string, memberIds: string[]) => void;
  onNewMember: () => void;
}) {
  const [name, setName] = useState('');
  const [selected, setSelected] = useState<ReadonlySet<string>>(
    new Set(initialSelected)
  );
  const toggle = (id: string) =>
    setSelected((current) => {
      const next = new Set(current);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent data-testid="collab-new-group-dialog">
        <DialogHeader>
          <DialogTitle>{DIALOG_COPY.groupTitle}</DialogTitle>
          <DialogDescription>{DIALOG_COPY.groupDescription}</DialogDescription>
        </DialogHeader>
        <form
          className="collab-form"
          onSubmit={(event) => {
            event.preventDefault();
            if (name.trim() && selected.size > 0)
              onCreate(name.trim(), Array.from(selected));
          }}
        >
          <div className="collab-form-field">
            <Label htmlFor="collab-group-name">{DIALOG_COPY.groupName}</Label>
            <Input
              id="collab-group-name"
              value={name}
              placeholder={DIALOG_COPY.groupNamePlaceholder}
              onChange={(event) => setName(event.target.value)}
            />
          </div>
          <div className="collab-form-field">
            <Label>{DIALOG_COPY.groupMembers}</Label>
            <div
              className="collaboration-dialog-member-picker collab-group-picker"
              role="group"
            >
              {members.length === 0 ? (
                <p className="collab-empty-hint">
                  {DIALOG_COPY.groupNoMembers}
                </p>
              ) : (
                members.map((member) => {
                  const checked = selected.has(member.memberId);
                  return (
                    <div
                      key={member.memberId}
                      className="collaboration-picker-row flex items-center gap-2"
                    >
                      <Checkbox
                        className="collab-picker-checkbox"
                        aria-label={member.nickname}
                        checked={checked}
                        onCheckedChange={() => toggle(member.memberId)}
                      />
                      <div
                        className={cn(
                          'workspace-session-row collaboration-member-row flex-1 min-w-0',
                          checked && 'is-selected'
                        )}
                      >
                        <button
                          type="button"
                          className="workspace-session-row-main"
                          onClick={() => toggle(member.memberId)}
                        >
                          <span
                            className="workspace-session-icon"
                            aria-hidden="true"
                          >
                            <MemberBotAvatar
                              config={member.avatar}
                              animated={false}
                              className="h-7 w-7"
                            />
                            <span
                              className={cn(
                                'workspace-session-status',
                                `workspace-session-status--${member.presence.state}`
                              )}
                            />
                          </span>
                          <span className="collaboration-member-title-group">
                            <span className="collaboration-member-name">
                              {member.nickname}
                            </span>
                            <span className="collaboration-member-subtitle collaboration-member-last-message">
                              {member.presence.line ?? THREAD_COPY.idle}
                            </span>
                          </span>
                        </button>
                      </div>
                    </div>
                  );
                })
              )}
            </div>
            <Button
              type="button"
              variant="ghost"
              size="sm"
              className="self-start"
              onClick={onNewMember}
            >
              <UserPlus className="h-3.5 w-3.5" aria-hidden="true" />
              {DIALOG_COPY.newMemberInline}
            </Button>
          </div>
          <DialogFooter>
            <Button
              type="button"
              variant="secondary"
              onClick={() => onOpenChange(false)}
            >
              {DIALOG_COPY.cancel}
            </Button>
            <Button
              type="submit"
              disabled={busy || !name.trim() || selected.size === 0}
            >
              {DIALOG_COPY.groupCreate}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}

export type RoleTemplate = {
  id: string;
  name: string;
  summary?: string;
  agent_id: string;
};

export function NewMemberDialog({
  open,
  roles,
  busy,
  onOpenChange,
  onCreate,
}: {
  open: boolean;
  roles: readonly RoleTemplate[];
  busy?: boolean;
  onOpenChange: (open: boolean) => void;
  onCreate: (input: { roleId: string; nickname: string }) => void;
}) {
  const [roleId, setRoleId] = useState(roles[0]?.id ?? '');
  const [nickname, setNickname] = useState('');
  const role = roles.find((r) => r.id === roleId);
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
            if (roleId && nickname.trim())
              onCreate({ roleId, nickname: nickname.trim() });
          }}
        >
          <div className="collab-form-field">
            <Label>{DIALOG_COPY.memberTemplate}</Label>
            <div className="collab-template-grid" role="group">
              {roles.slice(0, 6).map((option) => (
                <button
                  key={option.id}
                  type="button"
                  className="collab-template"
                  aria-pressed={option.id === roleId}
                  onClick={() => {
                    setRoleId(option.id);
                    if (!nickname) setNickname(option.name);
                  }}
                >
                  {option.id === roleId ? (
                    <Check
                      className="collab-template-check"
                      aria-hidden="true"
                    />
                  ) : null}
                  <span className="collab-template-name">{option.name}</span>
                  {option.summary ? (
                    <span className="collab-template-desc">
                      {option.summary}
                    </span>
                  ) : null}
                </button>
              ))}
            </div>
          </div>
          <div className="collab-form-field">
            <Label htmlFor="collab-member-nickname">
              {DIALOG_COPY.memberNickname}
            </Label>
            <Input
              id="collab-member-nickname"
              value={nickname}
              onChange={(event) => setNickname(event.target.value)}
            />
          </div>
          {role ? (
            <p className="collab-profile-row-sub">
              {DIALOG_COPY.memberAgent}: {role.agent_id}
            </p>
          ) : null}
          <DialogFooter>
            <Button
              type="button"
              variant="secondary"
              onClick={() => onOpenChange(false)}
            >
              {DIALOG_COPY.cancel}
            </Button>
            <Button
              type="submit"
              disabled={busy || !roleId || !nickname.trim()}
            >
              <MessageSquare className="h-3.5 w-3.5" aria-hidden="true" />
              {DIALOG_COPY.memberCreate}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}

export function MigrationNoticeDialog({
  open,
  onAcknowledge,
}: {
  open: boolean;
  onAcknowledge: () => void;
}) {
  return (
    <Dialog
      open={open}
      onOpenChange={(next) => (!next ? onAcknowledge() : undefined)}
    >
      <DialogContent data-testid="collab-migration-dialog">
        <DialogHeader>
          <DialogTitle>{DIALOG_COPY.migrationTitle}</DialogTitle>
          <DialogDescription>
            {DIALOG_COPY.migrationDescription}
          </DialogDescription>
        </DialogHeader>
        <ul className="collab-migration-list">
          {[
            [Users, DIALOG_COPY.migrationSpaces],
            [UserRound, DIALOG_COPY.migrationMembers],
            [MessageSquare, DIALOG_COPY.migrationUndecided],
          ].map(([Icon, text]) => {
            const ItemIcon = Icon as typeof Users;
            return (
              <li key={text as string} className="collab-migration-item">
                <ArrowRight aria-hidden="true" />
                <ItemIcon aria-hidden="true" />
                <span>{text as string}</span>
              </li>
            );
          })}
        </ul>
        <DialogFooter>
          <Button onClick={onAcknowledge}>{DIALOG_COPY.migrationOk}</Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

/** First-run empty state: create a small team from a template. */
export function TeamTemplateEmptyState({
  busy,
  onCreate,
}: {
  busy?: boolean;
  onCreate: (template: TeamTemplate) => void;
}) {
  const [selected, setSelected] = useState(TEAM_TEMPLATES[0].id);
  const template =
    TEAM_TEMPLATES.find((t) => t.id === selected) ?? TEAM_TEMPLATES[0];
  return (
    <div className="collaboration-empty-stage" data-testid="collab-team-empty">
      <div className="collaboration-empty-card collab-form">
        <Users
          className="h-6 w-6 text-[var(--text-muted)]"
          aria-hidden="true"
        />
        <h3 className="collaboration-empty-title">{DIALOG_COPY.teamTitle}</h3>
        <p className="collab-profile-row-sub">{DIALOG_COPY.teamDescription}</p>
        <div className="collab-template-grid" role="group">
          {TEAM_TEMPLATES.map((option) => (
            <button
              key={option.id}
              type="button"
              className="collab-template"
              aria-pressed={option.id === selected}
              onClick={() => setSelected(option.id)}
            >
              {option.id === selected ? (
                <Check className="collab-template-check" aria-hidden="true" />
              ) : null}
              <span className="collab-template-name">{option.name}</span>
              <span className="collab-template-desc">{option.description}</span>
            </button>
          ))}
        </div>
        <Button disabled={busy} onClick={() => onCreate(template)}>
          {DIALOG_COPY.teamCreate}
        </Button>
      </div>
    </div>
  );
}

export function MigrationBanner({
  onMore,
  onDismiss,
}: {
  onMore: () => void;
  onDismiss: () => void;
}) {
  return (
    <div
      className="collab-banner"
      role="status"
      data-testid="collab-migration-banner"
    >
      <span className="collab-banner-text">{DIALOG_COPY.bannerText}</span>
      <Button variant="ghost" size="xs" onClick={onMore}>
        {DIALOG_COPY.bannerMore}
      </Button>
      <Button variant="ghost" size="xs" onClick={onDismiss}>
        {DIALOG_COPY.bannerDismiss}
      </Button>
    </div>
  );
}
