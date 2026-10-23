import { useState } from 'react';
import { Globe, Hash, Lock, Pencil, Trash2, X } from 'lucide-react';
import {
  SegmentedControl,
  SegmentedControlItem,
} from '@astryxdesign/core/SegmentedControl';

import { Button } from '@/components/ui/button';
import { Textarea } from '@/components/ui/textarea';

import { MemberBotAvatar, type MemberBotAvatarConfig } from './MemberBotAvatar';
import { factScopeTag, type PresenceView } from './threadModel';

export const PROFILE_COPY = {
  title: '成员资料',
  close: '关闭资料',
  groups: '所在群聊',
  groupsEmpty: '还没有加入群聊',
  activity: '近期动态',
  activityEmpty: '暂无动态',
  facts: '长期记忆',
  factsEmpty: '还没有记住的事实',
  factsHint: '私聊产生的记忆默认不共享到群聊',
  edit: '编辑',
  delete: '删除',
  confirmDelete: '确认删除',
  save: '保存',
  cancel: '取消',
  writeAccess: '写入方式',
  writeIsolated: '独立 worktree',
  writeSerialized: '共享 · 排队写入',
  writeHint: '多个群同时需要写入时，独立 worktree 互不覆盖；共享则按顺序排队。',
  privateTag: '私聊',
} as const;

export type ProfileFact = {
  id: string;
  content: string;
  scope: string;
  updated_at?: string;
};

export type ProfileActivity = {
  id: string;
  threadId?: string | null;
  summary: string;
  private?: boolean;
  createdAt?: string;
};

export type WriteAccess = 'write_isolated' | 'write_serialized';

const SCOPE_ICON = { global: Globe, thread: Hash, private: Lock } as const;

function FactRow({
  fact,
  threadNames,
  onUpdate,
  onDelete,
}: {
  fact: ProfileFact;
  threadNames: ReadonlyMap<string, string>;
  onUpdate: (content: string) => void;
  onDelete: () => void;
}) {
  const [editing, setEditing] = useState<string | null>(null);
  const [confirming, setConfirming] = useState(false);
  const tag = factScopeTag(fact.scope, threadNames);
  const Icon = SCOPE_ICON[tag.kind];
  return (
    <li className="collab-profile-row" data-testid="collab-fact">
      <div className="collab-profile-row-main">
        {editing === null ? (
          <span>{fact.content}</span>
        ) : (
          <Textarea
            autoFocus
            value={editing}
            aria-label={PROFILE_COPY.edit}
            onChange={(event) => setEditing(event.target.value)}
          />
        )}
        <span
          className="collaboration-team-pill collab-scope-pill"
          data-scope={tag.kind}
        >
          <Icon aria-hidden="true" />
          {tag.label}
        </span>
        {editing !== null ? (
          <span className="collab-card-actions">
            <Button
              size="xs"
              disabled={!editing.trim()}
              onClick={() => {
                onUpdate(editing.trim());
                setEditing(null);
              }}
            >
              {PROFILE_COPY.save}
            </Button>
            <Button size="xs" variant="ghost" onClick={() => setEditing(null)}>
              {PROFILE_COPY.cancel}
            </Button>
          </span>
        ) : null}
      </div>
      {editing === null ? (
        confirming ? (
          <Button
            size="xs"
            variant="destructive"
            onClick={() => {
              setConfirming(false);
              onDelete();
            }}
            onBlur={() => setConfirming(false)}
          >
            {PROFILE_COPY.confirmDelete}
          </Button>
        ) : (
          <span className="inline-flex gap-1">
            <Button
              size="xs"
              variant="icon"
              aria-label={PROFILE_COPY.edit}
              onClick={() => setEditing(fact.content)}
            >
              <Pencil className="h-3.5 w-3.5" aria-hidden="true" />
            </Button>
            <Button
              size="xs"
              variant="icon"
              aria-label={PROFILE_COPY.delete}
              onClick={() => setConfirming(true)}
            >
              <Trash2 className="h-3.5 w-3.5" aria-hidden="true" />
            </Button>
          </span>
        )
      ) : null}
    </li>
  );
}

export function MemberProfilePanel({
  nickname,
  avatar,
  agentLabel,
  presence,
  groups,
  activity,
  facts,
  writeAccess,
  threadNames,
  onClose,
  onOpenGroup,
  onUpdateFact,
  onDeleteFact,
  onSetWriteAccess,
}: {
  nickname: string;
  avatar: MemberBotAvatarConfig;
  agentLabel?: string;
  presence: PresenceView;
  groups: readonly { spaceId: string; name: string; busy: boolean }[];
  activity: readonly ProfileActivity[];
  facts: readonly ProfileFact[];
  writeAccess: WriteAccess;
  threadNames: ReadonlyMap<string, string>;
  onClose: () => void;
  onOpenGroup: (spaceId: string) => void;
  onUpdateFact: (factId: string, content: string) => void;
  onDeleteFact: (factId: string) => void;
  onSetWriteAccess: (value: WriteAccess) => void;
}) {
  return (
    <aside
      className="collab-profile"
      aria-label={PROFILE_COPY.title}
      data-testid="collab-profile"
    >
      <div className="collab-profile-identity">
        <MemberBotAvatar config={avatar} className="collab-profile-avatar" />
        <div className="collab-main-head-text">
          <h3 className="collab-main-title">{nickname}</h3>
          <p className="collab-main-subtitle">
            {[agentLabel, presence.line].filter(Boolean).join(' · ')}
          </p>
        </div>
        <Button
          variant="icon"
          size="sm"
          aria-label={PROFILE_COPY.close}
          onClick={onClose}
        >
          <X className="h-4 w-4" aria-hidden="true" />
        </Button>
      </div>

      <section className="collab-profile-section">
        <h4 className="collab-profile-section-title">{PROFILE_COPY.groups}</h4>
        {groups.length === 0 ? (
          <p className="collab-profile-row-sub">{PROFILE_COPY.groupsEmpty}</p>
        ) : (
          <ul className="collab-profile-rows">
            {groups.map((group) => (
              <li key={group.spaceId} className="collab-profile-row">
                <Button
                  variant="ghost"
                  size="sm"
                  onClick={() => onOpenGroup(group.spaceId)}
                >
                  <Hash className="h-3.5 w-3.5" aria-hidden="true" />
                  {group.name}
                </Button>
                {group.busy ? (
                  <span
                    className="collab-profile-row-sub collab-presence-line"
                    data-state="busy"
                  >
                    处理中
                  </span>
                ) : null}
              </li>
            ))}
          </ul>
        )}
      </section>

      <section className="collab-profile-section">
        <h4 className="collab-profile-section-title">
          {PROFILE_COPY.activity}
        </h4>
        {activity.length === 0 ? (
          <p className="collab-profile-row-sub">{PROFILE_COPY.activityEmpty}</p>
        ) : (
          <ul className="collab-profile-rows">
            {activity.map((entry) => (
              <li key={entry.id} className="collab-profile-row">
                <div className="collab-profile-row-main">
                  <span>{entry.summary}</span>
                  <span className="collab-profile-row-sub">
                    {entry.private
                      ? PROFILE_COPY.privateTag
                      : entry.threadId
                        ? `#${threadNames.get(entry.threadId) ?? entry.threadId}`
                        : ''}
                  </span>
                </div>
              </li>
            ))}
          </ul>
        )}
      </section>

      <section className="collab-profile-section">
        <h4 className="collab-profile-section-title">{PROFILE_COPY.facts}</h4>
        <p className="collab-profile-row-sub">{PROFILE_COPY.factsHint}</p>
        {facts.length === 0 ? (
          <p className="collab-profile-row-sub">{PROFILE_COPY.factsEmpty}</p>
        ) : (
          <ul className="collab-profile-rows">
            {facts.map((fact) => (
              <FactRow
                key={fact.id}
                fact={fact}
                threadNames={threadNames}
                onUpdate={(content) => onUpdateFact(fact.id, content)}
                onDelete={() => onDeleteFact(fact.id)}
              />
            ))}
          </ul>
        )}
      </section>

      <section className="collab-profile-section">
        <h4 className="collab-profile-section-title">
          {PROFILE_COPY.writeAccess}
        </h4>
        <SegmentedControl
          label={PROFILE_COPY.writeAccess}
          size="sm"
          layout="hug"
          className="collaboration-compact-segmented"
          value={writeAccess}
          onChange={(value) => onSetWriteAccess(value as WriteAccess)}
        >
          <SegmentedControlItem
            value="write_isolated"
            label={PROFILE_COPY.writeIsolated}
          />
          <SegmentedControlItem
            value="write_serialized"
            label={PROFILE_COPY.writeSerialized}
          />
        </SegmentedControl>
        <p className="collab-profile-row-sub">{PROFILE_COPY.writeHint}</p>
      </section>
    </aside>
  );
}
