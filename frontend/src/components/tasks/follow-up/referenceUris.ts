/**
 * `@` reference URIs (`dimo://conversation/…`, `dimo://commit/…`,
 * `dimo://project/…`).
 *
 * Shared by the composer and the markdown renderer so the write format and the
 * read rules cannot drift. References serialized before the Dimo rename used
 * the `vibex://` scheme and still appear in existing transcripts, so parsing
 * accepts both schemes while serialization always writes `dimo://`.
 */

export const CONVERSATION_URI_PREFIX = 'dimo://conversation/';
export const COMMIT_URI_PREFIX = 'dimo://commit/';
export const PROJECT_URI_PREFIX = 'dimo://project/';

export const PRE_RENAME_URI_SCHEME_PREFIX = 'vibex://';

/** Rewrites a pre-rename `vibex://` URI onto the current `dimo://` scheme. */
export function normalizeReferenceUri(uri: string): string {
  if (!uri.toLowerCase().startsWith(PRE_RENAME_URI_SCHEME_PREFIX)) return uri;
  return `dimo://${uri.slice(PRE_RENAME_URI_SCHEME_PREFIX.length)}`;
}

export function conversationReferenceUri(conversationId: string): string {
  return `${CONVERSATION_URI_PREFIX}${conversationId}`;
}

export function parseConversationReferenceUri(uri: string): string | null {
  const normalized = normalizeReferenceUri(uri);
  if (!normalized.toLowerCase().startsWith(CONVERSATION_URI_PREFIX)) {
    return null;
  }
  const id = normalized.slice(CONVERSATION_URI_PREFIX.length).trim();
  return id || null;
}

export function commitReferenceUri(repoId: string, sha: string): string {
  return `${COMMIT_URI_PREFIX}${encodeURIComponent(repoId)}@${sha}`;
}

export function parseCommitReferenceUri(
  uri: string
): { repoId: string; sha: string } | null {
  const normalized = normalizeReferenceUri(uri);
  if (!normalized.toLowerCase().startsWith(COMMIT_URI_PREFIX)) return null;
  const body = normalized.slice(COMMIT_URI_PREFIX.length);
  const separator = body.lastIndexOf('@');
  if (separator <= 0 || separator === body.length - 1) return null;
  try {
    const repoId = decodeURIComponent(body.slice(0, separator));
    const sha = body.slice(separator + 1);
    if (!repoId || !sha) return null;
    return { repoId, sha };
  } catch {
    return null;
  }
}

export function projectReferenceUri(projectId: string, path: string): string {
  return `${PROJECT_URI_PREFIX}${encodeURIComponent(projectId)}@${encodeURIComponent(path)}`;
}

export function parseProjectReferenceUri(
  uri: string
): { projectId: string; path: string } | null {
  const normalized = normalizeReferenceUri(uri);
  if (!normalized.toLowerCase().startsWith(PROJECT_URI_PREFIX)) return null;
  const body = normalized.slice(PROJECT_URI_PREFIX.length);
  const separator = body.lastIndexOf('@');
  if (separator <= 0 || separator === body.length - 1) return null;
  try {
    const projectId = decodeURIComponent(body.slice(0, separator));
    const path = decodeURIComponent(body.slice(separator + 1));
    if (!projectId || !path) return null;
    return { projectId, path };
  } catch {
    return null;
  }
}

export function shortCommitSha(sha: string): string {
  return sha.slice(0, 7);
}
