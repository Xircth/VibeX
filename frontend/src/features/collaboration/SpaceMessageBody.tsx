import { ChatMessage, ChatMessageBubble } from '@astryxdesign/core/Chat';

import { AstryxMarkdown } from '@/components/NormalizedConversation/AstryxMarkdown';
import { UserMessageAttachments } from '@/components/NormalizedConversation/UserMessageImageAttachment';
import { UserMessageMarkdown } from '@/components/NormalizedConversation/UserMessageMarkdown';
import { splitDisplayContentImages } from '@/components/NormalizedConversation/userMessageImages';

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
  return (
    <div className="conv-entry-item conv-assistant-msg px-4 py-2 text-sm">
      <div className="conv-assistant-body">
        <AstryxMarkdown
          value={text}
          workspacePath={workspacePath}
          rawHtml={false}
        />
      </div>
    </div>
  );
}
