import {
  BaseCodingAgent,
  type ExecutorProfileId,
  type JsonValue,
  type ProviderRuntimeEvent,
  type ProviderTurnRequest,
} from 'shared/types';
import { providerRuntimeApi } from '@/lib/providerRuntime';
import { getProviderFrontendAdapterByExecutor } from './providerFrontendAdapters';

type ProviderOptions = { [key: string]: JsonValue | undefined };

export type ProviderRuntimeTurnInput = {
  workspaceId: string;
  sessionId: string;
  executorProfileId: ExecutorProfileId;
  text: string;
  displayText?: string;
  threadId?: string | null;
  images?: string[];
  providerOptions?: ProviderOptions;
};

const MARKDOWN_IMAGE_REGEX = /!\[[^\]]*]\(([^)\s]+)(?:\s+"[^"]*")?\)/g;

function extractMarkdownImagePaths(text: string): string[] {
  const images: string[] = [];
  const seen = new Set<string>();

  for (const match of text.matchAll(MARKDOWN_IMAGE_REGEX)) {
    const path = match[1]?.trim();
    if (!path || seen.has(path)) continue;
    seen.add(path);
    images.push(path);
  }

  return images;
}

function mergeImageInputs(
  explicitImages: string[] | undefined,
  text: string
): string[] {
  const merged: string[] = [];
  const seen = new Set<string>();

  for (const image of [
    ...(explicitImages ?? []),
    ...extractMarkdownImagePaths(text),
  ]) {
    if (!image || seen.has(image)) continue;
    seen.add(image);
    merged.push(image);
  }

  return merged;
}

export function buildProviderRuntimeTurnRequest({
  workspaceId,
  sessionId,
  executorProfileId,
  text,
  displayText,
  threadId,
  images,
  providerOptions,
}: ProviderRuntimeTurnInput): ProviderTurnRequest {
  const adapter = getProviderFrontendAdapterByExecutor(
    executorProfileId.executor
  );
  if (!adapter) {
    throw new Error(
      `Provider runtime is not available for ${executorProfileId.executor}`
    );
  }

  const request = adapter.buildTurnRequest(
    { text, images: mergeImageInputs(images, text) },
    {
      workspaceId,
      sessionId,
      threadId,
      model: executorProfileId.model ?? null,
    }
  );

  return {
    ...request,
    executor_profile_id: executorProfileId,
    provider_options: {
      ...(request.provider_options ?? {}),
      ...(providerOptions ?? {}),
      ...(displayText !== undefined && displayText !== text
        ? { display_text: displayText }
        : {}),
      ...(executorProfileId.executor === BaseCodingAgent.CODEX &&
      executorProfileId.reasoning_effort
        ? { effort: executorProfileId.reasoning_effort }
        : {}),
      ...(executorProfileId.executor === BaseCodingAgent.CODEX
        ? { fast_mode: executorProfileId.fast_mode ?? false }
        : {}),
    },
  };
}

export async function sendProviderRuntimeTurn(
  input: ProviderRuntimeTurnInput
): Promise<ProviderRuntimeEvent> {
  return providerRuntimeApi.sendTurn(buildProviderRuntimeTurnRequest(input));
}
