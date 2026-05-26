import { Paperclip } from 'lucide-react';
import { useCallback, useRef, type ChangeEvent } from 'react';

import { Button } from '@/components/ui/button';

const ATTACH_IMAGES_LABEL = '\u9644\u52a0\u56fe\u7247';

type ActionBarImageButtonProps = {
  isEditable: boolean;
  onAttachImages: (files: File[]) => void;
};

export function ActionBarImageButton({
  isEditable,
  onAttachImages,
}: ActionBarImageButtonProps) {
  const fileInputRef = useRef<HTMLInputElement>(null);

  const handleAttachClick = useCallback(() => {
    fileInputRef.current?.click();
  }, []);

  const handleFileInputChange = useCallback(
    (event: ChangeEvent<HTMLInputElement>) => {
      const files = Array.from(event.target.files || []).filter((file) =>
        file.type.startsWith('image/')
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
        accept="image/*"
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
        title={ATTACH_IMAGES_LABEL}
        aria-label={ATTACH_IMAGES_LABEL}
      >
        <Paperclip className="h-3.5 w-3.5" />
      </Button>
    </>
  );
}
