import { act, render, screen, waitFor } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';

import {
  AppSurfaceHost,
  buildAppSurfaceDocument,
  type AppSurfaceHostTransport,
} from './AppSurfaceHost';

vi.mock('@/components/ThemeProvider', () => ({
  useTheme: () => ({ resolvedTheme: 'dark' }),
}));

class TestPort {
  peer: TestPort | null = null;
  listeners = new Set<(event: MessageEvent) => void>();
  closed = false;

  addEventListener(type: string, listener: (event: MessageEvent) => void) {
    if (type === 'message') this.listeners.add(listener);
  }

  removeEventListener(type: string, listener: (event: MessageEvent) => void) {
    if (type === 'message') this.listeners.delete(listener);
  }

  postMessage(message: unknown) {
    if (this.closed) return;
    this.peer?.listeners.forEach((listener) =>
      listener({ data: message } as MessageEvent)
    );
  }

  start() {}

  close() {
    this.closed = true;
    this.listeners.clear();
  }
}

class TestMessageChannel {
  port1 = new TestPort();
  port2 = new TestPort();

  constructor() {
    this.port1.peer = this.port2;
    this.port2.peer = this.port1;
  }
}

const descriptor = {
  pluginId: 'acme.dashboard',
  surfaceId: 'project-health',
  label: 'Project health',
  generation: 4,
  allowedMethods: ['app.navigation.open'],
};
const editorDescriptor = {
  ...descriptor,
  surfaceId: 'drawio-editor',
  label: 'Drawio editor',
  slot: 'artifact.editor' as const,
  artifactPath: '/workspace/architecture.drawio',
  allowedMethods: [],
};
const mountNonce = 'mount-nonce';
const authorityToken = '0123456789abcdef0123456789abcdef';
const testTokenFactory = () => mountNonce;

function createTransport(): AppSurfaceHostTransport & {
  load: ReturnType<typeof vi.fn>;
  invoke: ReturnType<typeof vi.fn>;
  revoke: ReturnType<typeof vi.fn>;
} {
  return {
    load: vi.fn().mockResolvedValue({
      html: '<main><h1>Project health</h1><script>window.loaded = true;</script></main>',
      token: authorityToken,
    }),
    invoke: vi.fn().mockResolvedValue({ opened: true }),
    revoke: vi.fn().mockResolvedValue(undefined),
  };
}

function renderHost(
  transport: AppSurfaceHostTransport,
  props: Partial<React.ComponentProps<typeof AppSurfaceHost>> = {}
) {
  return render(
    <AppSurfaceHost
      descriptor={descriptor}
      enabled
      transport={transport}
      tokenFactory={testTokenFactory}
      channelFactory={() =>
        new TestMessageChannel() as unknown as MessageChannel
      }
      {...props}
    />
  );
}

describe('AppSurfaceHost lifecycle boundary', () => {
  it('preserves trusted plugin markup while adding the lifecycle bridge', () => {
    const html = buildAppSurfaceDocument({
      pluginHtml:
        '<link rel="stylesheet" href="https://example.com/theme.css"><a href="https://example.com">jump</a><script src="https://example.com/app.js"></script>',
      nonce: 'nonce-123',
    });

    expect(html).toContain('https://example.com/theme.css');
    expect(html).toContain('https://example.com/app.js');
    expect(html).toContain('https://example.com');
    expect(html).toContain('vibexSurface');
    expect(html).not.toContain('Content-Security-Policy');
  });

  it('mounts a trusted external document without a content gate', async () => {
    const transport = createTransport();
    transport.load.mockResolvedValue({
      html: '<script src="https://example.com/remote.js"></script>',
      token: authorityToken,
    });

    renderHost(transport);

    const iframe = await screen.findByTitle('Project health');
    expect(iframe.getAttribute('srcdoc')).toContain(
      'https://example.com/remote.js'
    );
    expect(transport.revoke).not.toHaveBeenCalled();
  });

  it('mounts a full-trust frame and sends lifecycle context over a MessagePort', async () => {
    const transport = createTransport();
    const bootstrapMessenger = vi.fn();
    renderHost(transport, { bootstrapMessenger });

    const iframe = await screen.findByTitle('Project health');
    expect(iframe).not.toHaveAttribute('sandbox');
    expect(iframe).toHaveAttribute('referrerpolicy', 'no-referrer');
    expect(iframe).not.toHaveAttribute('allow');
    expect(iframe.getAttribute('srcdoc')).not.toContain(
      'Content-Security-Policy'
    );

    await waitFor(() => expect(bootstrapMessenger).toHaveBeenCalled());
    expect(bootstrapMessenger).toHaveBeenCalledWith(
      iframe,
      expect.objectContaining({
        protocol: 'vibex.app-surface/1',
        type: 'bootstrap',
        token: authorityToken,
        pluginId: descriptor.pluginId,
        surfaceId: descriptor.surfaceId,
        generation: 4,
        context: expect.objectContaining({
          theme: 'dark',
          locale: 'zh-CN',
          direction: 'ltr',
          label: 'Project health',
        }),
      }),
      expect.anything()
    );
  });

  it('mounts an artifact editor without panel chrome and forwards document methods', async () => {
    const transport = createTransport();
    transport.load.mockResolvedValue({
      html: '<main>Drawio</main>',
      token: authorityToken,
      context: {
        slot: 'artifact.editor',
        artifact: { name: 'architecture.drawio', revision: 'rev-1' },
      },
    });
    const bootstrapMessenger = vi.fn();
    renderHost(transport, {
      descriptor: editorDescriptor,
      variant: 'editor',
      bootstrapMessenger,
    });

    const iframe = await screen.findByTitle('Drawio editor');
    expect(transport.load).toHaveBeenCalledWith(
      expect.objectContaining({
        artifactPath: '/workspace/architecture.drawio',
      })
    );
    expect(screen.queryByText(/generation|代次/i)).not.toBeInTheDocument();
    await waitFor(() => expect(bootstrapMessenger).toHaveBeenCalled());
    expect(bootstrapMessenger.mock.calls[0][1]).toEqual(
      expect.objectContaining({
        context: expect.objectContaining({
          slot: 'artifact.editor',
          artifact: { name: 'architecture.drawio', revision: 'rev-1' },
        }),
      })
    );
    const pluginPort = bootstrapMessenger.mock.calls[0][2] as TestPort;
    await act(async () =>
      pluginPort.postMessage({
        protocol: 'vibex.app-surface/1',
        type: 'request',
        token: authorityToken,
        sequence: 1,
        requestId: 'read-document',
        method: 'artifact.readText',
        params: null,
      })
    );
    await waitFor(() =>
      expect(transport.invoke).toHaveBeenCalledWith(
        expect.objectContaining({ method: 'artifact.readText', sequence: 1 })
      )
    );
    await act(async () =>
      pluginPort.postMessage({
        protocol: 'vibex.app-surface/1',
        type: 'request',
        token: authorityToken,
        sequence: 2,
        requestId: 'ready',
        method: 'surface.ready',
        params: null,
      })
    );
    await act(async () =>
      pluginPort.postMessage({
        protocol: 'vibex.app-surface/1',
        type: 'request',
        token: authorityToken,
        sequence: 3,
        requestId: 'write-document',
        method: 'artifact.writeText',
        params: { content: '<mxfile />', expectedRevision: 'rev-1' },
      })
    );
    await waitFor(() =>
      expect(transport.invoke).toHaveBeenLastCalledWith(
        expect.objectContaining({ method: 'artifact.writeText', sequence: 2 })
      )
    );
    expect(iframe).toHaveClass('plugin-app-surface-frame');
  });

  it('revokes a forged mount token before dispatch', async () => {
    const transport = createTransport();
    const bootstrapMessenger = vi.fn();
    renderHost(transport, { bootstrapMessenger });
    await screen.findByTitle('Project health');
    await waitFor(() => expect(bootstrapMessenger).toHaveBeenCalled());
    const pluginPort = bootstrapMessenger.mock.calls[0][2] as TestPort;

    await act(async () => {
      pluginPort.postMessage({
        protocol: 'vibex.app-surface/1',
        type: 'request',
        token: 'wrong-token',
        sequence: 1,
        requestId: 'forged',
        method: 'app.navigation.open',
        params: {},
      });
    });

    await waitFor(() =>
      expect(screen.getByRole('alert')).toHaveTextContent(/bridge|消息通道/i)
    );
    expect(transport.invoke).not.toHaveBeenCalled();
    expect(transport.revoke).toHaveBeenCalledWith(
      expect.objectContaining({ token: authorityToken, generation: 4 })
    );
    expect(screen.queryByTitle('Project health')).not.toBeInTheDocument();
  });

  it('revokes non-JSON payloads before they reach the broker', async () => {
    const transport = createTransport();
    const bootstrapMessenger = vi.fn();
    renderHost(transport, { bootstrapMessenger });
    await screen.findByTitle('Project health');
    await waitFor(() => expect(bootstrapMessenger).toHaveBeenCalled());
    const pluginPort = bootstrapMessenger.mock.calls[0][2] as TestPort;

    await act(async () =>
      pluginPort.postMessage({
        protocol: 'vibex.app-surface/1',
        type: 'request',
        token: authorityToken,
        sequence: 1,
        requestId: 'invalid-json',
        method: 'app.navigation.open',
        params: { callback: () => undefined },
      })
    );

    await waitFor(() => expect(transport.revoke).toHaveBeenCalled());
    expect(transport.invoke).not.toHaveBeenCalled();
    expect(screen.queryByTitle('Project health')).not.toBeInTheDocument();
  });

  it('revokes undeclared methods before they reach the broker', async () => {
    const transport = createTransport();
    const bootstrapMessenger = vi.fn();
    renderHost(transport, { bootstrapMessenger });
    await screen.findByTitle('Project health');
    await waitFor(() => expect(bootstrapMessenger).toHaveBeenCalled());
    const pluginPort = bootstrapMessenger.mock.calls[0][2] as TestPort;

    await act(async () =>
      pluginPort.postMessage({
        protocol: 'vibex.app-surface/1',
        type: 'request',
        token: authorityToken,
        sequence: 1,
        requestId: 'undeclared',
        method: 'system.shell',
        params: {},
      })
    );

    await waitFor(() => expect(transport.revoke).toHaveBeenCalled());
    expect(transport.invoke).not.toHaveBeenCalled();
  });

  it('dispatches one declared request and revokes a replayed sequence', async () => {
    const transport = createTransport();
    const bootstrapMessenger = vi.fn();
    renderHost(transport, { bootstrapMessenger });
    await screen.findByTitle('Project health');
    await waitFor(() => expect(bootstrapMessenger).toHaveBeenCalled());
    const pluginPort = bootstrapMessenger.mock.calls[0][2] as TestPort;
    const request = {
      protocol: 'vibex.app-surface/1',
      type: 'request',
      token: authorityToken,
      sequence: 1,
      requestId: 'navigation-1',
      method: 'app.navigation.open',
      params: { path: '/local-projects' },
    };

    await act(async () => pluginPort.postMessage(request));
    await waitFor(() =>
      expect(transport.invoke).toHaveBeenCalledWith(
        expect.objectContaining({
          token: authorityToken,
          sequence: 1,
          method: 'app.navigation.open',
          params: { path: '/local-projects' },
        })
      )
    );

    await act(async () => pluginPort.postMessage(request));
    await waitFor(() =>
      expect(transport.revoke).toHaveBeenCalledWith(
        expect.objectContaining({ reason: 'protocol_violation' })
      )
    );
    expect(screen.queryByTitle('Project health')).not.toBeInTheDocument();
  });

  it('revokes and unmounts on generation replacement and disable', async () => {
    const transport = createTransport();
    const view = renderHost(transport);
    expect(await screen.findByTitle('Project health')).toBeInTheDocument();

    view.rerender(
      <AppSurfaceHost
        descriptor={{ ...descriptor, generation: 5 }}
        enabled
        transport={transport}
        tokenFactory={() => 'next-token'}
        channelFactory={() =>
          new TestMessageChannel() as unknown as MessageChannel
        }
      />
    );

    await waitFor(() =>
      expect(transport.revoke).toHaveBeenCalledWith(
        expect.objectContaining({ token: authorityToken, generation: 4 })
      )
    );
    expect(await screen.findByTitle('Project health')).toBeInTheDocument();

    view.rerender(
      <AppSurfaceHost
        descriptor={{ ...descriptor, generation: 5 }}
        enabled={false}
        transport={transport}
      />
    );

    expect(screen.queryByTitle('Project health')).not.toBeInTheDocument();
    expect(screen.getByText(/已停用|disabled/i)).toBeVisible();
  });

  it('does not reopen or revoke when a parent renders an equivalent descriptor', async () => {
    const transport = createTransport();
    const view = renderHost(transport);
    await screen.findByTitle('Project health');

    view.rerender(
      <AppSurfaceHost
        descriptor={{
          ...descriptor,
          allowedMethods: [...descriptor.allowedMethods],
        }}
        enabled
        transport={transport}
        tokenFactory={testTokenFactory}
        channelFactory={() =>
          new TestMessageChannel() as unknown as MessageChannel
        }
      />
    );

    await waitFor(() => expect(transport.load).toHaveBeenCalledTimes(1));
    expect(transport.revoke).not.toHaveBeenCalled();
  });

  it('returns keyboard focus when the iframe bridge requests surface.escape', async () => {
    const transport = createTransport();
    const bootstrapMessenger = vi.fn();
    renderHost(transport, { bootstrapMessenger });
    const iframe = await screen.findByTitle('Project health');
    await waitFor(() => expect(bootstrapMessenger).toHaveBeenCalled());
    const pluginPort = bootstrapMessenger.mock.calls[0][2] as TestPort;
    iframe.focus();

    await act(async () =>
      pluginPort.postMessage({
        protocol: 'vibex.app-surface/1',
        type: 'request',
        token: authorityToken,
        sequence: 1,
        requestId: 'escape-1',
        method: 'surface.escape',
        params: null,
      })
    );

    expect(
      screen.getByRole('region', { name: 'Project health' })
    ).toHaveFocus();
  });
});
