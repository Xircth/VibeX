import { createContext, useContext, type ReactNode } from 'react';

export type ImagePreviewPresentation = 'dialog' | 'workspace-tab';

const ImagePreviewPresentationContext =
  createContext<ImagePreviewPresentation>('dialog');

export function ImagePreviewPresentationProvider({
  children,
  value,
}: {
  children: ReactNode;
  value: ImagePreviewPresentation;
}) {
  return (
    <ImagePreviewPresentationContext.Provider value={value}>
      {children}
    </ImagePreviewPresentationContext.Provider>
  );
}

export function useImagePreviewPresentation(): ImagePreviewPresentation {
  return useContext(ImagePreviewPresentationContext);
}
