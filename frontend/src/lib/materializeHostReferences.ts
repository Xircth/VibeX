import { hostClientApi, type HostClientProfile } from '@/lib/api';
import { backendCall } from '@/lib/backendTransport';
import { isTauriClient } from '@/lib/desktopShell';

import {
  HOST_REFERENCE_DIR,
  LOCAL_HOST_FILE_NAME,
  formatSshHostConfig,
  mentionedHostFileNames,
  sshHostAlias,
  sshHostFileName,
  sshHostWorkspacePath,
  sshTargetFromProvision,
  type SshHostTarget,
} from './savedHostSshConfig';

export type HostReferenceCatalogEntry = {
  fileName: string;
  workspacePath: string;
  label: string;
  detail: string;
  content: string;
  kind: 'saved' | 'local';
};

export function hostReferenceCatalog(
  profiles: HostClientProfile[],
  options: {
    connectedProfileId?: string | null;
    local?: { user: string; host: string; port: number } | null;
    includeLocal?: boolean;
  } = {}
): HostReferenceCatalogEntry[] {
  const connectedId = options.connectedProfileId?.trim() || null;
  const entries: HostReferenceCatalogEntry[] = [];
  for (const profile of profiles) {
    if ((profile.provision_kind ?? '').trim() !== 'ssh') continue;
    if (connectedId && profile.id === connectedId) continue;
    const target = sshTargetFromProvision(profile.provision);
    if (!target) continue;
    const name = profile.name.trim() || target.host;
    const alias = sshHostAlias(name);
    const fileName = sshHostFileName(name, profile.id);
    const sshTarget: SshHostTarget = { alias, ...target };
    entries.push({
      fileName,
      workspacePath: sshHostWorkspacePath(fileName),
      label: name,
      detail: `${target.user}@${target.host}`,
      content: formatSshHostConfig(name, sshTarget),
      kind: 'saved',
    });
  }
  if (options.includeLocal && options.local?.host && options.local.user) {
    const local = options.local;
    const sshTarget: SshHostTarget = {
      alias: 'local',
      host: local.host,
      user: local.user,
      port: local.port || 22,
    };
    entries.push({
      fileName: LOCAL_HOST_FILE_NAME,
      workspacePath: sshHostWorkspacePath(LOCAL_HOST_FILE_NAME),
      label: 'local',
      detail: `${local.user}@${local.host}`,
      content: formatSshHostConfig('local', sshTarget),
      kind: 'local',
    });
  }
  return entries;
}

export async function loadHostReferenceCatalog(): Promise<
  HostReferenceCatalogEntry[]
> {
  if (!isTauriClient()) return [];
  try {
    const status = await hostClientApi.status();
    return hostReferenceCatalog(status.profiles, {
      connectedProfileId: status.profile?.id,
      local: status.local_ssh ?? null,
      includeLocal: Boolean(status.connected && status.local_ssh),
    });
  } catch {
    return [];
  }
}

export function rewriteHostReferencePaths(
  text: string,
  written: Array<{ fileName: string; path: string }>
): string {
  let next = text;
  for (const file of written) {
    const marker = `${HOST_REFERENCE_DIR}/${file.fileName}`;
    next = next.split(marker).join(file.path);
  }
  return next;
}

export async function materializeMentionedHostFiles(input: {
  text: string;
}): Promise<string> {
  const fileNames = mentionedHostFileNames(input.text);
  if (fileNames.length === 0) return input.text;
  const catalog = await loadHostReferenceCatalog();
  const byName = new Map(catalog.map((entry) => [entry.fileName, entry]));
  const files = fileNames.flatMap((fileName) => {
    const entry = byName.get(fileName);
    return entry
      ? [{ fileName: entry.fileName, content: entry.content }]
      : [];
  });
  if (files.length === 0) return input.text;
  const result = await backendCall<{
    files: Array<{ fileName: string; path: string }>;
  }>('write_ssh_host_files', { files });
  return rewriteHostReferencePaths(input.text, result.files ?? []);
}
