export type PickedRect = {
  x: number;
  y: number;
  width: number;
  height: number;
};

export type PickedViewport = {
  width: number;
  height: number;
  dpr?: number;
};

export type FrozenPageFrame = {
  mime?: string | null;
  data?: string | null;
};

export function cropRectToImage(
  rect: PickedRect,
  viewport: PickedViewport,
  imageWidth: number,
  imageHeight: number
): { sx: number; sy: number; sw: number; sh: number } | null {
  if (
    viewport.width < 1 ||
    viewport.height < 1 ||
    imageWidth < 1 ||
    imageHeight < 1 ||
    rect.width < 1 ||
    rect.height < 1
  ) {
    return null;
  }
  const scaleX = imageWidth / viewport.width;
  const scaleY = imageHeight / viewport.height;
  const sx = Math.max(0, Math.floor(rect.x * scaleX));
  const sy = Math.max(0, Math.floor(rect.y * scaleY));
  const sw = Math.max(
    1,
    Math.min(imageWidth - sx, Math.ceil(rect.width * scaleX))
  );
  const sh = Math.max(
    1,
    Math.min(imageHeight - sy, Math.ceil(rect.height * scaleY))
  );
  if (sx >= imageWidth || sy >= imageHeight) return null;
  return { sx, sy, sw, sh };
}

function loadFrameImage(frame: FrozenPageFrame): Promise<HTMLImageElement> {
  return new Promise((resolve, reject) => {
    if (!frame.mime || !frame.data) {
      reject(new Error('empty frame'));
      return;
    }
    const image = new Image();
    image.onload = () => resolve(image);
    image.onerror = () => reject(new Error('frame decode failed'));
    image.src = `data:${frame.mime};base64,${frame.data}`;
  });
}

function canvasToFile(
  canvas: HTMLCanvasElement,
  name: string
): Promise<File | null> {
  return new Promise((resolve) => {
    canvas.toBlob(
      (blob) => {
        if (!blob) {
          resolve(null);
          return;
        }
        resolve(new File([blob], name, { type: blob.type || 'image/png' }));
      },
      'image/png',
      0.92
    );
  });
}

export async function fileFromPickedFrame(
  frame: FrozenPageFrame | null | undefined,
  payload: {
    rect?: PickedRect | null;
    viewport?: PickedViewport | null;
    tag?: string | null;
  }
): Promise<File | null> {
  if (!frame?.mime || !frame.data) return null;
  try {
    const image = await loadFrameImage(frame);
    const canvas = document.createElement('canvas');
    const crop =
      payload.rect && payload.viewport
        ? cropRectToImage(
            payload.rect,
            payload.viewport,
            image.naturalWidth || image.width,
            image.naturalHeight || image.height
          )
        : null;
    if (crop) {
      canvas.width = crop.sw;
      canvas.height = crop.sh;
      const context = canvas.getContext('2d');
      if (!context) return null;
      context.drawImage(
        image,
        crop.sx,
        crop.sy,
        crop.sw,
        crop.sh,
        0,
        0,
        crop.sw,
        crop.sh
      );
    } else {
      canvas.width = image.naturalWidth || image.width;
      canvas.height = image.naturalHeight || image.height;
      const context = canvas.getContext('2d');
      if (!context) return null;
      context.drawImage(image, 0, 0);
    }
    const tag =
      (payload.tag || 'element').replace(/[^a-zA-Z0-9_-]/g, '') || 'element';
    return canvasToFile(canvas, `${tag}.png`);
  } catch {
    return null;
  }
}
