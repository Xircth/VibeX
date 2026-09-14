import { describe, expect, it } from 'vitest';

import {
  attachmentPreviewKind,
  fileNameForMediaUpload,
  isAttachableFile,
  isAttachableMediaFile,
  isImageFile,
  isRasterImageExtension,
  isVideoFile,
  mediaExtensionForMime,
  mimeForMediaExtension,
  prepareMediaFileForUpload,
} from './mediaAttachments';

describe('mediaAttachments', () => {
  it('classifies images and videos by mime or extension', () => {
    expect(
      isImageFile(new File(['x'], 'shot.png', { type: 'image/png' }))
    ).toBe(true);
    expect(
      isVideoFile(new File(['x'], 'clip.mp4', { type: 'video/mp4' }))
    ).toBe(true);
    expect(
      isAttachableMediaFile(new File(['x'], 'clip.MOV', { type: '' }))
    ).toBe(true);
    expect(
      isAttachableMediaFile(
        new File(['x'], 'notes.txt', { type: 'text/plain' })
      )
    ).toBe(false);
  });

  it('renders raster images inline and documents as file cards', () => {
    expect(isRasterImageExtension('png')).toBe(true);
    expect(isRasterImageExtension('svg')).toBe(false);
    expect(attachmentPreviewKind('shot.png')).toBe('image');
    expect(attachmentPreviewKind('clip.mp4')).toBe('video');
    expect(attachmentPreviewKind('notes.md')).toBe('file');
    expect(attachmentPreviewKind('diagram.svg')).toBe('file');
    expect(attachmentPreviewKind('report.pdf')).toBe('file');
    expect(attachmentPreviewKind('letter.docx')).toBe('file');
    expect(attachmentPreviewKind('deck.pptx')).toBe('file');
    expect(attachmentPreviewKind('data.xlsx')).toBe('file');
    expect(
      attachmentPreviewKind('.vibe-images/uuid.bin', 'application/pdf')
    ).toBe('file');
    expect(attachmentPreviewKind('', 'image/png')).toBe('image');
    expect(attachmentPreviewKind('.vibe-images/notes.pdf', 'image/png')).toBe(
      'file'
    );
  });

  it('treats documents as attachable files', () => {
    expect(
      isAttachableFile(new File(['x'], 'notes.txt', { type: 'text/plain' }))
    ).toBe(true);
    expect(
      isAttachableFile(new File(['x'], 'readme.md', { type: 'text/markdown' }))
    ).toBe(true);
    expect(
      isAttachableFile(
        new File(['x'], 'report.pdf', { type: 'application/pdf' })
      )
    ).toBe(true);
    expect(
      isAttachableFile(
        new File(['x'], 'letter.docx', {
          type: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
        })
      )
    ).toBe(true);
  });

  it('maps video extensions and mime types', () => {
    expect(mimeForMediaExtension('mp4')).toBe('video/mp4');
    expect(mimeForMediaExtension('mov')).toBe('video/quicktime');
    expect(mediaExtensionForMime('video/webm')).toBe('webm');
    expect(mediaExtensionForMime('video/quicktime')).toBe('mov');
  });

  it('maps document extensions and mime types', () => {
    expect(mimeForMediaExtension('pdf')).toBe('application/pdf');
    expect(mimeForMediaExtension('md')).toBe('text/markdown');
    expect(mimeForMediaExtension('txt')).toBe('text/plain');
    expect(mediaExtensionForMime('application/pdf')).toBe('pdf');
    expect(mediaExtensionForMime('text/plain')).toBe('txt');
  });

  it('keeps video filenames and names unnamed clipboard videos', () => {
    expect(
      fileNameForMediaUpload(new File(['x'], 'demo.MP4', { type: 'video/mp4' }))
    ).toBe('demo.MP4');
    expect(
      fileNameForMediaUpload(new File(['x'], '', { type: 'video/webm' }))
    ).toBe('pasted-video.webm');
    expect(
      fileNameForMediaUpload(
        new File(['x'], 'clipboard', { type: 'video/mp4' })
      )
    ).toBe('clipboard.mp4');
  });

  it('rewrites unnamed video files before upload', () => {
    const prepared = prepareMediaFileForUpload(
      new File(['bytes'], '', { type: 'video/mp4' })
    );
    expect(prepared.name).toBe('pasted-video.mp4');
    expect(prepared.type).toBe('video/mp4');
  });

  it('keeps document filenames', () => {
    expect(
      fileNameForMediaUpload(
        new File(['x'], 'notes.txt', { type: 'text/plain' })
      )
    ).toBe('notes.txt');
    expect(
      fileNameForMediaUpload(
        new File(['x'], 'Report.PDF', { type: 'application/pdf' })
      )
    ).toBe('Report.PDF');
    expect(
      fileNameForMediaUpload(new File(['x'], '', { type: 'application/pdf' }))
    ).toBe('pasted-file.pdf');
  });
});
