import { useState } from 'react';
import { ChatMessage, ChatMessageBubble } from '@astryxdesign/core/Chat';

import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';

import { AstryxMarkdown } from '@/components/NormalizedConversation/AstryxMarkdown';
import { UserMessageAttachments } from '@/components/NormalizedConversation/UserMessageImageAttachment';
import { UserMessageMarkdown } from '@/components/NormalizedConversation/UserMessageMarkdown';
import { splitDisplayContentImages } from '@/components/NormalizedConversation/userMessageImages';

import { collaborationCall } from './collaborationApi';

export type ParsedCard = {
  kind: 'ask' | 'approval';
  id: string;
  before: string;
  body: string;
  options: string[];
};

const CARD_RE = /<card kind="(ask|approval)" id="([^"]+)">([\s\S]*?)<\/card>/;

function unescapeCard(value: string): string {
  return value
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&amp;/g, '&');
}

function cardField(inner: string, tag: string): string {
  const match = inner.match(new RegExp(`<${tag}>([\\s\\S]*?)</${tag}>`));
  return match ? unescapeCard(match[1].trim()) : '';
}

/** Parse an agent ask/approval card (rendered by the backend) out of a message. */
export function parseCard(text: string): ParsedCard | null {
  const match = text.match(CARD_RE);
  if (!match) return null;
  const kind = match[1] as ParsedCard['kind'];
  const inner = match[3];
  const before = text.slice(0, match.index).trim();
  if (kind === 'ask') {
    const options = cardField(inner, 'options')
      .split('|')
      .map((item) => item.trim())
      .filter(Boolean);
    return {
      kind,
      id: match[2],
      before,
      body: cardField(inner, 'question'),
      options,
    };
  }
  const command = cardField(inner, 'command');
  const reason = cardField(inner, 'reason');
  const body = [
    cardField(inner, 'action'),
    command ? `\`\`\`\n${command}\n\`\`\`` : '',
    reason,
  ]
    .filter(Boolean)
    .join('\n\n');
  return { kind, id: match[2], before, body, options: [] };
}

/** One-line sidebar preview: cards become a short label instead of raw markup. */
export function messagePreviewText(text: string): string {
  const card = parseCard(text);
  let result = text;
  if (card) {
    const label =
      card.kind === 'approval'
        ? '审批请求'
        : card.body
          ? `提问：${card.body}`
          : '提问';
    result = label;
  } else {
    result = text.replace(/<card[\s\S]*?(<\/card>|$)/g, '审批请求');
  }
  return result.replace(/\s+/g, ' ').trim();
}

export function SpaceCardActions({ card }: { card: ParsedCard }) {
  const [answer, setAnswer] = useState('');
  const [busy, setBusy] = useState(false);
  const [done, setDone] = useState<string | null>(null);
  const [error, setError] = useState('');
  const resolve = async (input: Record<string, unknown>, label: string) => {
    setBusy(true);
    setError('');
    try {
      await collaborationCall('collaboration', 'card.resolve', {
        cardId: card.id,
        ...input,
      });
      setDone(label);
    } catch (err) {
      const message =
        err && typeof err === 'object' && 'message' in err
          ? String((err as { message: unknown }).message)
          : String(err);
      if (/already|resolved/i.test(message)) setDone('已处理');
      else setError(message);
    } finally {
      setBusy(false);
    }
  };
  if (done) {
    return (
      <p
        className="collaboration-card-resolved text-xs text-muted-foreground"
        data-testid="collaboration-card-resolved"
      >
        {done}
      </p>
    );
  }
  return (
    <div
      className="collaboration-card-actions mt-2 flex flex-wrap items-center gap-2"
      data-testid="collaboration-card-actions"
    >
      {card.kind === 'approval' ? (
        <>
          <Button
            type="button"
            size="sm"
            disabled={busy}
            onClick={() => void resolve({ decision: 'allow_once' }, '已批准')}
          >
            批准
          </Button>
          <Button
            type="button"
            size="sm"
            variant="outline"
            disabled={busy}
            onClick={() => void resolve({ decision: 'deny' }, '已拒绝')}
          >
            拒绝
          </Button>
        </>
      ) : (
        <>
          {card.options.map((option) => (
            <Button
              key={option}
              type="button"
              size="sm"
              variant="outline"
              disabled={busy}
              onClick={() =>
                void resolve({ answer: option }, `已回答：${option}`)
              }
            >
              {option}
            </Button>
          ))}
          <form
            className="flex items-center gap-2"
            onSubmit={(event) => {
              event.preventDefault();
              if (answer.trim())
                void resolve(
                  { answer: answer.trim() },
                  `已回答：${answer.trim()}`
                );
            }}
          >
            <Input
              value={answer}
              onChange={(event) => setAnswer(event.target.value)}
              placeholder="输入回答"
              aria-label="回答"
              className="h-8 w-56"
              disabled={busy}
            />
            <Button type="submit" size="sm" disabled={busy || !answer.trim()}>
              回答
            </Button>
          </form>
        </>
      )}
      {error ? <span className="text-xs text-destructive">{error}</span> : null}
    </div>
  );
}

export function bubbleText(envelope: {
  content?: string;
  summary?: string;
}): string {
  const content = String(envelope.content ?? '');
  const summary = String(envelope.summary ?? '');
  if (!summary || summary === content || content.startsWith(summary)) {
    return content;
  }
  return `${summary}\n\n${content}`;
}

export function SpaceMessageBody({
  fromYou,
  text,
  workspacePath,
  workspaceId,
}: {
  fromYou: boolean;
  text: string;
  workspacePath?: string;
  workspaceId?: string;
}) {
  if (fromYou) {
    const { text: cleanText, images, files } = splitDisplayContentImages(text);
    const hasText =
      cleanText.trim().length > 0 ||
      (images.length === 0 && files.length === 0);
    return (
      <div className="conv-entry-item conv-user-msg">
        {images.length > 0 || files.length > 0 ? (
          <UserMessageAttachments
            images={images}
            files={files}
            taskAttemptId={workspaceId}
            workspacePath={workspacePath}
          />
        ) : null}
        {hasText ? (
          <ChatMessage
            sender="user"
            density="compact"
            className="vibex-user-message"
          >
            <ChatMessageBubble className="conv-user-bubble">
              <UserMessageMarkdown
                value={cleanText}
                workspacePath={workspacePath}
              />
            </ChatMessageBubble>
          </ChatMessage>
        ) : null}
      </div>
    );
  }
  const card = parseCard(text);
  return (
    <div className="conv-entry-item conv-assistant-msg px-4 py-2 text-sm">
      <div className="conv-assistant-body">
        <AstryxMarkdown
          value={
            card ? [card.before, card.body].filter(Boolean).join('\n\n') : text
          }
          workspacePath={workspacePath}
          rawHtml={false}
        />
        {card ? <SpaceCardActions card={card} /> : null}
      </div>
    </div>
  );
}
