import { useTranslation } from 'react-i18next';
import { ChatComposerDrawer } from '@astryxdesign/core/Chat';

import type { SessionComposerImage } from './sessionComposerTypes';
import { SessionComposerImageAttachment } from './SessionComposerImageAttachment';

export function SessionComposerAttachmentDrawer({
  images,
  disabled = false,
  taskAttemptId,
  taskId,
  onRemoveImage,
}: {
  images: SessionComposerImage[];
  disabled?: boolean;
  taskAttemptId?: string;
  taskId?: string;
  onRemoveImage: (imageId: string) => void;
}) {
  const { t } = useTranslation('tasks');
  if (images.length === 0) return null;

  return (
    <ChatComposerDrawer
      count={images.length}
      label={t('composer.attachments')}
      className="session-composer-attachment-drawer"
      data-testid="session-composer-attachment-drawer"
    >
      <div className="session-composer-attachment-row">
        {images.map((image) => (
          <SessionComposerImageAttachment
            key={image.id}
            image={image}
            disabled={disabled}
            taskAttemptId={taskAttemptId}
            taskId={taskId}
            onRemoveImage={onRemoveImage}
          />
        ))}
      </div>
    </ChatComposerDrawer>
  );
}
