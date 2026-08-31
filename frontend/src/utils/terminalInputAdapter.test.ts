import { attachTerminalInput } from './terminalInputAdapter';

function createTerminalInputSource() {
  const textarea = document.createElement('textarea');
  const dataListeners = new Set<(data: string) => void>();

  return {
    source: {
      textarea,
      onData(listener: (data: string) => void) {
        dataListeners.add(listener);
        return { dispose: () => dataListeners.delete(listener) };
      },
    },
    emitData(data: string) {
      dataListeners.forEach((listener) => listener(data));
    },
  };
}

function dispatchWebKitImeText(
  textarea: HTMLTextAreaElement,
  data: string
): void {
  const beforeInput = new InputEvent('beforeinput', {
    bubbles: true,
    cancelable: true,
    composed: true,
    data,
    inputType: 'insertText',
    isComposing: false,
  });
  textarea.dispatchEvent(beforeInput);
  if (!beforeInput.defaultPrevented) {
    textarea.value += data;
    textarea.dispatchEvent(
      new InputEvent('input', {
        bubbles: true,
        composed: true,
        data,
        inputType: 'insertText',
        isComposing: false,
      })
    );
  }

  const keydown = new KeyboardEvent('keydown', {
    bubbles: true,
    composed: true,
    key: data,
  });
  Object.defineProperty(keydown, 'keyCode', { value: 229 });
  textarea.dispatchEvent(keydown);
}

describe('attachTerminalInput', () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it('preserves rapid non-composing IME text when WebKit fires input before keydown', async () => {
    vi.useFakeTimers();
    const terminal = createTerminalInputSource();
    const received: string[] = [];
    const subscription = attachTerminalInput(terminal.source, (data) => {
      received.push(data);
    });

    for (const character of 'cd ..') {
      dispatchWebKitImeText(terminal.source.textarea, character);
    }

    await vi.runAllTimersAsync();

    expect(received.join('')).toBe('cd ..');
    subscription.dispose();
  });

  it('does not duplicate text when xterm emits it after the native input event', async () => {
    vi.useFakeTimers();
    const terminal = createTerminalInputSource();
    const received: string[] = [];
    const subscription = attachTerminalInput(terminal.source, (data) => {
      received.push(data);
    });

    dispatchWebKitImeText(terminal.source.textarea, '.');
    terminal.emitData('.');
    await vi.runAllTimersAsync();

    expect(received.join('')).toBe('.');
    subscription.dispose();
  });

  it('does not duplicate text when xterm emits it before the native input event', async () => {
    vi.useFakeTimers();
    const terminal = createTerminalInputSource();
    const received: string[] = [];
    const subscription = attachTerminalInput(terminal.source, (data) => {
      received.push(data);
    });

    terminal.emitData('.');
    dispatchWebKitImeText(terminal.source.textarea, '.');
    await vi.runAllTimersAsync();

    expect(received.join('')).toBe('.');
    subscription.dispose();
  });

  it('does not duplicate text when a third-party IME inserts after xterm onData', async () => {
    vi.useFakeTimers();
    const terminal = createTerminalInputSource();
    const received: string[] = [];
    const subscription = attachTerminalInput(terminal.source, (data) => {
      received.push(data);
    });

    for (const character of 'pnpm') {
      terminal.emitData(character);
      await vi.advanceTimersByTimeAsync(0);
      dispatchWebKitImeText(terminal.source.textarea, character);
    }

    await vi.runAllTimersAsync();

    expect(received.join('')).toBe('pnpm');
    subscription.dispose();
  });

  it('does not match native input against xterm data from an earlier keystroke', async () => {
    vi.useFakeTimers();
    const terminal = createTerminalInputSource();
    const received: string[] = [];
    const subscription = attachTerminalInput(terminal.source, (data) => {
      received.push(data);
    });

    terminal.emitData('.');
    await vi.advanceTimersByTimeAsync(50);
    dispatchWebKitImeText(terminal.source.textarea, '.');
    await vi.runAllTimersAsync();

    expect(received.join('')).toBe('..');
    subscription.dispose();
  });

  it('stops non-composing IME insertText from reaching later textarea listeners', () => {
    const terminal = createTerminalInputSource();
    const subscription = attachTerminalInput(terminal.source, () => undefined);
    let reachedBubbleListener = false;
    terminal.source.textarea.addEventListener('beforeinput', () => {
      reachedBubbleListener = true;
    });
    terminal.source.textarea.addEventListener('input', () => {
      reachedBubbleListener = true;
    });

    dispatchWebKitImeText(terminal.source.textarea, 'p');

    expect(reachedBubbleListener).toBe(false);
    subscription.dispose();
  });
});
