import { useState } from 'react';
import { Dialog, DialogContent } from '@/components/ui/dialog';
import NiceModal, { useModal } from '@ebay/nice-modal-react';
import { Loader2 } from 'lucide-react';
import { defineModal } from '@/lib/modals';
import { fileExtension, isVideoExtension } from '@/utils/mediaAttachments';

export interface ImagePreviewDialogProps {
  imageUrl: string;
  altText: string;
  fileName?: string;
  format?: string;
  sizeBytes?: bigint | null;
}

function isVideoPreview({
  imageUrl,
  fileName,
  format,
}: ImagePreviewDialogProps): boolean {
  if (imageUrl.startsWith('data:video/')) return true;
  if (format && isVideoExtension(format)) return true;
  if (fileName && isVideoExtension(fileExtension(fileName))) return true;
  return false;
}

const ImagePreviewDialogImpl = NiceModal.create<ImagePreviewDialogProps>(
  (props) => {
    const modal = useModal();
    const { imageUrl, altText } = props;
    const [imageLoaded, setImageLoaded] = useState(false);
    const videoPreview = isVideoPreview(props);

    const handleClose = () => {
      modal.hide();
    };

    return (
      <Dialog open={modal.visible} onOpenChange={handleClose}>
        <DialogContent className="max-w-4xl overflow-hidden p-0">
          <div className="relative flex min-h-[200px] items-center justify-center">
            {!imageLoaded && (
              <div className="absolute inset-0 flex items-center justify-center">
                <Loader2 className="h-8 w-8 animate-spin text-muted-foreground" />
              </div>
            )}
            {videoPreview ? (
              <video
                src={imageUrl}
                controls
                autoPlay
                className={`max-h-[70vh] max-w-full ${
                  imageLoaded ? 'opacity-100' : 'opacity-0'
                }`}
                onLoadedData={() => setImageLoaded(true)}
              />
            ) : (
              <img
                src={imageUrl}
                alt={altText}
                className={`max-h-[70vh] max-w-full object-contain ${
                  imageLoaded ? 'opacity-100' : 'opacity-0'
                }`}
                onLoad={() => setImageLoaded(true)}
              />
            )}
          </div>
        </DialogContent>
      </Dialog>
    );
  }
);

export const ImagePreviewDialog = defineModal<ImagePreviewDialogProps, void>(
  ImagePreviewDialogImpl
);
