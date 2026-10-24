import type { ReactNode } from 'react';
import { ChatMessage, ChatMessageBubble } from '@astryxdesign/core/Chat';

import { AstryxMarkdown } from '@/components/NormalizedConversation/AstryxMarkdown';
import { UserMessageAttachments } from '@/components/NormalizedConversation/UserMessageImageAttachment';
import { UserMessageMarkdown } from '@/components/NormalizedConversation/UserMessageMarkdown';
import { splitDisplayContentImages } from '@/components/NormalizedConversation/userMessageImages';
import './chatUiPolish.css';

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
  bubble = false,
  footer,
}: {
  fromYou: boolean;
  text: string;
  workspacePath?: string;
  workspaceId?: string;
  /** Group chats: wrap member (agent) messages in the neutral bubble. */
  bubble?: boolean;
  /** Rendered bottom-right inside the bubble (e.g. the receipt check). */
  footer?: ReactNode;
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
              {footer ? (
                <span className="collaboration-bubble-footer">{footer}</span>
              ) : null}
            </ChatMessageBubble>
          </ChatMessage>
        ) : null}
      </div>
    );
  }
  if (bubble) {
    return (
      <div
        className="conv-entry-item collaboration-member-msg"
        data-testid="collaboration-member-bubble"
      >
        <div className="collaboration-member-bubble">
          <AstryxMarkdown
            value={text}
            workspacePath={workspacePath}
            rawHtml={false}
          />
          {footer ? (
            <span className="collaboration-bubble-footer">{footer}</span>
          ) : null}
        </div>
      </div>
    );
  }
  return (
    <div className="conv-entry-item conv-assistant-msg px-4 py-2 text-sm">
      <div className="conv-assistant-body">
        <AstryxMarkdown
          value={text}
          workspacePath={workspacePath}
          rawHtml={false}
        />
      </div>
      {footer ? (
        <span className="collaboration-bubble-footer">{footer}</span>
      ) : null}
    </div>
  );
}
