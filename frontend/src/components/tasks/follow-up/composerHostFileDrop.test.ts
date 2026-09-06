import { describe, expect, it } from 'vitest';

import {
  fileFromHostPath,
  hostPathFileName,
  isImageHostPath,
  isPointInElement,
  relativePathInsideRoot,
} from './composerHostFileDrop';

describe('composerHostFileDrop', () => {
  it('classifies image paths', () => {
    expect(isImageHostPath('C:\\Users\\mac\\shot.PNG')).toBe(true);
    expect(isImageHostPath('/tmp/notes.txt')).toBe(false);
    expect(hostPathFileName('C:\\Users\\mac\\shot.PNG')).toBe('shot.PNG');
  });

  it('returns a workspace-relative path when the drop is inside the root', () => {
    expect(relativePathInsideRoot('C:\\proj', 'C:\\proj\\src\\App.tsx')).toBe(
      'src/App.tsx'
    );
    expect(relativePathInsideRoot('/Users/mac/app', '/tmp/out.png')).toBeNull();
  });

  it('builds a File from host bytes', async () => {
    const file = await fileFromHostPath('/tmp/shot.png', async () =>
      Uint8Array.from([1, 2, 3])
    );
    expect(file.name).toBe('shot.png');
    expect(file.type).toBe('image/png');
    expect(file.size).toBe(3);
  });

  it('hit-tests both physical and CSS coordinates', () => {
    const element = document.createElement('div');
    element.getBoundingClientRect = () =>
      ({
        left: 10,
        right: 110,
        top: 20,
        bottom: 120,
        width: 100,
        height: 100,
        x: 10,
        y: 20,
        toJSON() {
          return this;
        },
      }) as DOMRect;
    Object.defineProperty(window, 'devicePixelRatio', {
      configurable: true,
      value: 2,
    });
    expect(isPointInElement(element, 50, 50)).toBe(true);
    expect(isPointInElement(element, 80, 80)).toBe(true);
    expect(isPointInElement(element, 400, 400)).toBe(false);
  });
});
