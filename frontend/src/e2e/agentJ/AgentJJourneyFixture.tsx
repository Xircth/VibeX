import { useMemo, useState } from 'react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { RotateCw, Send } from 'lucide-react';

import { ArtifactTimelineCard } from '@/components/NormalizedConversation/ArtifactTimelineCard';
import { PermissionRequestCard } from '@/components/NormalizedConversation/conversation/PermissionRequestCard';
import { LegacyDesignScope } from '@/components/legacy-design/LegacyDesignScope';
import { Button } from '@/components/ui/button';
import type { BackendTransport } from '@/lib/backendTransport';
import { BackendTransportProvider } from '@/lib/transport';
import '@/i18n';

class FakeAgentTransport implements BackendTransport {
  readonly environment = 'web' as const;

  async call(command: string): Promise<unknown> {
    if (command === 'conversation_start_turn') {
      return {
        conversationId: 'conversation-web-1',
        turnId: 'turn-web-1',
        status: 'running',
        lastSequence: 3,
      };
    }
    if (command === 'conversation_respond_permission') return null;
    if (command === 'artifact_open_preview') {
      return {
        leaseId: 'lease-web-1',
        artifactId: 'artifact-web-1',
        providerId: 'officecli',
        loopbackPort: 43123,
        capabilityToken: 'short-preview-cap',
        expiresAtUnixMs: Date.now() + 60_000,
        docxFallbackSupported: true,
      };
    }
    if (command === 'artifact_close_preview') return null;
    throw new Error(`Unsupported fixture command: ${command}`);
  }

  artifactPreviewUrl(lease: {
    leaseId: string;
    capabilityToken: string;
  }): string {
    return `/api/v1/previews/${lease.leaseId}/c/${lease.capabilityToken}/`;
  }
}

function JourneySurface({ transport }: { transport: BackendTransport }) {
  const [turnStarted, setTurnStarted] = useState(false);
  const [permissionStatus, setPermissionStatus] = useState<
    'hidden' | 'pending' | 'responded'
  >('hidden');
  const [streamStatus, setStreamStatus] = useState('not attached');

  const startTurn = async () => {
    await transport.call('conversation_start_turn', {
      request: {
        conversationId: 'conversation-web-1',
        workspaceId: 'workspace-web-1',
        agentId: 'fixture-agent',
        text: 'Create an Office briefing.',
        images: [],
        configOverrides: [],
      },
    });
    setTurnStarted(true);
    setPermissionStatus('pending');
    setStreamStatus('live at sequence 3');
  };

  const reconnect = () => {
    setStreamStatus('reconnecting after sequence 3');
    window.setTimeout(() => setStreamStatus('ready at sequence 6'), 50);
  };

  return (
    <main className="min-h-screen bg-background p-6 text-foreground">
      <div className="mx-auto max-w-4xl space-y-4">
        <header>
          <h1 className="text-lg font-semibold">
            Web Turn · Permission · Preview
          </h1>
          <p className="mt-1 text-sm text-foreground">
            Production components over a fake Agent at the BackendTransport seam
          </p>
        </header>

        <section
          aria-label="Web conversation"
          className="rounded-lg border border-border bg-card p-4"
        >
          <Button type="button" onClick={() => void startTurn()}>
            <Send className="mr-1.5 h-3.5 w-3.5" />
            Start Turn
          </Button>
          {turnStarted ? (
            <div className="mt-3 space-y-3">
              <p>Agent stream: preparing an editable Office briefing…</p>
              <PermissionRequestCard
                request={{
                  permission_id: 'permission-web-1',
                  title: 'Write briefing.pptx',
                  status:
                    permissionStatus === 'pending' ? 'pending' : 'responded',
                  details: {
                    fields: {
                      kind: 'write',
                      locations: [{ path: 'deliverables/briefing.pptx' }],
                    },
                  },
                  options: [
                    {
                      id: 'allow-once',
                      label: 'Allow once',
                      kind: 'allow_once',
                    },
                    {
                      id: 'allow-similar',
                      label: 'Allow similar file writes',
                      kind: 'allow_always',
                      description:
                        'Allow matching write requests for this session.',
                    },
                    {
                      id: 'reject-once',
                      label: 'Reject',
                      kind: 'reject_once',
                    },
                  ],
                }}
                onRespond={async (permissionId, response) => {
                  await transport.call('conversation_respond_permission', {
                    request: {
                      conversationId: 'conversation-web-1',
                      permissionId,
                      response,
                    },
                  });
                  setPermissionStatus('responded');
                }}
              />
            </div>
          ) : null}
        </section>

        <section
          aria-label="Reconnect evidence"
          className="rounded-lg border border-border bg-card p-4"
        >
          <div className="flex items-center justify-between gap-3">
            <p role="status">{streamStatus}</p>
            <Button type="button" variant="outline" onClick={reconnect}>
              <RotateCw className="mr-1.5 h-3.5 w-3.5" />
              Reconnect stream
            </Button>
          </div>
        </section>

        {permissionStatus === 'responded' ? (
          <ArtifactTimelineCard
            transport={transport}
            artifact={{
              artifact_id: 'artifact-web-1',
              workspace_id: 'workspace-web-1',
              relative_path: 'deliverables/briefing.pptx',
              media_type:
                'application/vnd.openxmlformats-officedocument.presentationml.presentation',
              content_hash: 'sha256-fixture',
              revision: 1n,
              plugin_id: 'vibex.office',
              plugin_version: '2.0.0',
              provider_id: 'officecli',
              tool_lock_id: 'officecli@fixture',
            }}
          />
        ) : null}
      </div>
    </main>
  );
}

export function AgentJJourneyFixture() {
  const transport = useMemo(() => new FakeAgentTransport(), []);
  const queryClient = useMemo(
    () => new QueryClient({ defaultOptions: { queries: { retry: false } } }),
    []
  );

  return (
    <QueryClientProvider client={queryClient}>
      <BackendTransportProvider transport={transport}>
        <LegacyDesignScope>
          <JourneySurface transport={transport} />
        </LegacyDesignScope>
      </BackendTransportProvider>
    </QueryClientProvider>
  );
}
