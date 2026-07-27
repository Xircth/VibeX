export interface FrameScheduler {
  request(): void;
  cancel(): void;
}

const LAYOUT_STABILIZATION_FRAMES = 2;

export function createFrameScheduler(
  synchronize: () => void,
  requestFrame: typeof requestAnimationFrame = requestAnimationFrame,
  cancelFrame: typeof cancelAnimationFrame = cancelAnimationFrame
): FrameScheduler {
  let pending = false;
  let frameId: number | null = null;
  let remainingFrames = 0;

  const scheduleFrame = () => {
    const requestedFrameId = requestFrame(() => {
      frameId = null;
      remainingFrames -= 1;
      synchronize();
      if (remainingFrames > 0) {
        scheduleFrame();
      } else {
        pending = false;
      }
    });
    if (pending && frameId === null) frameId = requestedFrameId;
  };

  return {
    request() {
      remainingFrames = LAYOUT_STABILIZATION_FRAMES;
      if (pending) return;
      pending = true;
      scheduleFrame();
    },
    cancel() {
      pending = false;
      remainingFrames = 0;
      if (frameId !== null) cancelFrame(frameId);
      frameId = null;
    },
  };
}
