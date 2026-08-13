interface Disposable {
  dispose(): void;
}

interface TerminalInputSource {
  readonly textarea: HTMLTextAreaElement | undefined;
  onData(listener: (data: string) => void): Disposable;
}

/**
 * Bridges xterm input to the PTY and recovers non-composing IME text that
 * WebKit inserts into xterm's textarea before dispatching keydown.
 */
export function attachTerminalInput(
  terminal: TerminalInputSource,
  onInput: (data: string) => void
): Disposable {
  const timers = new Set<number>();
  const pendingNativeText: Array<{ data: string }> = [];
  const unmatchedXtermData: Array<{ data: string }> = [];
  let disposed = false;

  const schedule = (callback: () => void) => {
    const timer = window.setTimeout(() => {
      timers.delete(timer);
      callback();
    }, 0);
    timers.add(timer);
  };

  const dataSubscription = terminal.onData((data) => {
    const pendingIndex = pendingNativeText.findIndex(
      (candidate) => candidate.data === data
    );
    if (pendingIndex !== -1) {
      pendingNativeText.splice(pendingIndex, 1);
    } else {
      const emission = { data };
      unmatchedXtermData.push(emission);
      queueMicrotask(() => {
        const emissionIndex = unmatchedXtermData.indexOf(emission);
        if (emissionIndex !== -1) {
          unmatchedXtermData.splice(emissionIndex, 1);
        }
      });
    }
    onInput(data);
  });
  const textarea = terminal.textarea;
  const handleInput = (event: Event) => {
    const inputEvent = event as InputEvent;
    if (
      !inputEvent.data ||
      inputEvent.inputType !== 'insertText' ||
      inputEvent.isComposing
    ) {
      return;
    }

    const matchingEmissionIndex = unmatchedXtermData.findIndex(
      (emission) => emission.data === inputEvent.data
    );
    if (matchingEmissionIndex !== -1) {
      unmatchedXtermData.splice(matchingEmissionIndex, 1);
      return;
    }

    const candidate = { data: inputEvent.data };
    pendingNativeText.push(candidate);

    // Give xterm's synchronous input handler and its keyCode=229 timeout a
    // complete event-loop turn before treating the text as missed.
    schedule(() =>
      schedule(() => {
        const pendingIndex = pendingNativeText.indexOf(candidate);
        if (!disposed && pendingIndex !== -1) {
          pendingNativeText.splice(pendingIndex, 1);
          onInput(candidate.data);
        }
      })
    );
  };
  textarea?.addEventListener('input', handleInput, true);

  return {
    dispose() {
      disposed = true;
      dataSubscription.dispose();
      textarea?.removeEventListener('input', handleInput, true);
      for (const timer of timers) {
        window.clearTimeout(timer);
      }
      timers.clear();
      pendingNativeText.length = 0;
      unmatchedXtermData.length = 0;
    },
  };
}
