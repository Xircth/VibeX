import { Paperclip } from 'lucide-react';
import { useCallback, useRef, type ChangeEvent } from 'react';
import { useTranslation } from 'react-i18next';

import { Button } from '@/components/ui/button';
import { isAttachableFile } from '@/utils/mediaAttachments';

type ActionBarImageButtonProps = {
  isEditable: boolean;
  onAttachImages: (files: File[]) => void;
};

export function ActionBarImageButton({
  isEditable,
  onAttachImages,
}: ActionBarImageButtonProps) {
  const { t } = useTranslation('tasks');
  const fileInputRef = useRef<HTMLInputElement>(null);
  const attachLabel = t('composer.attachFiles');

  const handleAttachClick = useCallback(() => {
    fileInputRef.current?.click();
  }, []);

  const handleFileInputChange = useCallback(
    (event: ChangeEvent<HTMLInputElement>) => {
      const files = Array.from(event.target.files || []).filter(
        isAttachableFile
      );
      if (files.length > 0) {
        onAttachImages(files);
      }
      event.target.value = '';
    },
    [onAttachImages]
  );

  return (
    <>
      <input
        ref={fileInputRef}
        type="file"
        multiple
        className="hidden"
        onChange={handleFileInputChange}
      />

      <Button
        onClick={handleAttachClick}
        disabled={!isEditable}
        size="sm"
        variant="ghost"
        className="h-7 w-7 p-0"
        title={attachLabel}
        aria-label={attachLabel}
      >
        <Paperclip className="h-3.5 w-3.5" />
      </Button>
    </>
  );
}
