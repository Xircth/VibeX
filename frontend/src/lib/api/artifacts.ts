import {
  configuredBackendTransport,
  type BackendTransport,
} from '@/lib/backendTransport';

export type ArtifactRecordView = {
  id: string;
  conversation_id: string;
  turn_id: string;
  workspace_id: string | null;
  scope_root: string;
  relative_path: string;
  media_type: string;
  content_hash: string;
  revision: number;
  producer: {
    plugin_id: string;
    plugin_version: string;
    provider_id: string;
    tool_lock: {
      id: string;
      tool_id: string;
      version: string;
      target: string;
      sha256: string;
      executable_path: string;
    };
  };
  created_at_unix_ms: number;
  updated_at_unix_ms: number;
};

export type ArtifactPreviewLease = {
  leaseId: string;
  artifactId: string;
  providerId: string;
  loopbackPort: number;
  capabilityToken: string;
  expiresAtUnixMs: number;
  previewUrl?: string;
  docxFallbackSupported: boolean;
};

export function createArtifactApi(transport: BackendTransport) {
  return {
    list: (conversationId?: string, limit = 100) =>
      transport.call('artifact_list', {
        conversationId: conversationId ?? null,
        limit,
      }) as Promise<ArtifactRecordView[]>,
    openPreview: (artifactId: string) =>
      transport.call('artifact_open_preview', {
        artifactId,
      }) as Promise<ArtifactPreviewLease>,
    closePreview: (leaseId: string) =>
      transport.call('artifact_close_preview', {
        leaseId,
      }) as Promise<void>,
  };
}

export const artifactApi = createArtifactApi(configuredBackendTransport);
