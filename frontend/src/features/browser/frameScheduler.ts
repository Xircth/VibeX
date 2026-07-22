export interface FrameScheduler {
  request(): void;
  cancel(): void;
}

export function createFrameScheduler(
  synchronize: () => void,
  requestFrame: typeof requestAnimationFrame = requestAnimationFrame,
  cancelFrame: typeof cancelAnimationFrame = cancelAnimationFrame
): FrameScheduler {
  let pending = false;
  let frameId: number | null = null;

  return {
    request() {
      if (pending) return;
      pending = true;
      const requestedFrameId = requestFrame(() => {
        pending = false;
        frameId = null;
        synchronize();
      });
      if (pending) frameId = requestedFrameId;
    },
    cancel() {
      pending = false;
      if (frameId !== null) cancelFrame(frameId);
      frameId = null;
    },
  };
}
