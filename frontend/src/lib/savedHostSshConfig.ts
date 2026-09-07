export const HOST_REFERENCE_DIR = '.vibex/ssh-hosts';
export const LOCAL_HOST_FILE_NAME = 'local.sshconfig';

export type SshHostTarget = {
  alias: string;
  host: string;
  user: string;
  port: number;
  jump?: string;
};

export function sshHostAlias(name: string, fallback = 'host'): string {
  const alias = name
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 32);
  return alias || fallback;
}

export function sshHostFileName(name: string, id: string): string {
  const alias = sshHostAlias(name);
  const suffix = id.replace(/[^a-zA-Z0-9]/g, '').slice(0, 8);
  return suffix ? `${alias}-${suffix}.sshconfig` : `${alias}.sshconfig`;
}

export function sshHostWorkspacePath(fileName: string): string {
  return `${HOST_REFERENCE_DIR}/${fileName}`;
}

export function formatSshHostConfig(
  name: string,
  target: SshHostTarget
): string {
  const lines = [
    `# VibeX Host: ${name}`,
    `Host ${target.alias}`,
    `  HostName ${target.host}`,
    `  User ${target.user}`,
    `  Port ${target.port}`,
  ];
  const jump = target.jump?.trim();
  if (jump) {
    lines.push(`  ProxyJump ${jump}`);
  }
  return `${lines.join('\n')}\n`;
}

export function sshTargetFromProvision(
  provision: Record<string, unknown> | null | undefined
): Omit<SshHostTarget, 'alias'> | null {
  const host =
    typeof provision?.host === 'string' ? provision.host.trim() : '';
  const user =
    typeof provision?.user === 'string' ? provision.user.trim() : '';
  if (!host || !user) return null;
  const port = Number(provision?.port);
  const jump =
    typeof provision?.jump === 'string' ? provision.jump.trim() : '';
  return {
    host,
    user,
    port: Number.isInteger(port) && port > 0 ? port : 22,
    jump: jump || undefined,
  };
}

export function mentionedHostFileNames(text: string): string[] {
  const names: string[] = [];
  const seen = new Set<string>();
  const pattern = /\[@:([^\]]*)\]\(\.vibex\/ssh-hosts\/([^)]+)\)/g;
  for (const match of text.matchAll(pattern)) {
    const fileName = (match[2] ?? '').trim();
    if (!fileName || seen.has(fileName)) continue;
    if (!fileName.endsWith('.sshconfig')) continue;
    if (fileName.includes('/') || fileName.includes('\\')) continue;
    seen.add(fileName);
    names.push(fileName);
  }
  return names;
}
