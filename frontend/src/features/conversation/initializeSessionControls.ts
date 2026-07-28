import { conversationApi } from './conversationApi';

export type InitialSessionControls = {
  modeOverride: string | null;
  configOverrides: Record<string, string>;
};

/**
 * Materialize a newly created conversation's ACP session before navigation so
 * its composer can render and edit authoritative controls without waiting for
 * the first prompt.
 */
export async function initializeSessionControls(
  conversationId: string,
  controls: InitialSessionControls | null | undefined
): Promise<void> {
  await conversationApi.ensureSessionControls(conversationId);

  if (controls?.modeOverride) {
    await conversationApi.setSessionMode({
      conversationId,
      modeId: controls.modeOverride,
    });
  }

  for (const [key, value] of Object.entries(controls?.configOverrides ?? {})) {
    await conversationApi.setSessionConfigOption({
      conversationId,
      key,
      value,
    });
  }
}
