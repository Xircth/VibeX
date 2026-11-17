import {
  FolderPickerDialog,
  MultiFolderPickerDialog,
} from '@/components/dialogs/shared/FolderPickerDialog';
import { getBackendTransport } from '@/lib/transport';

export type PickHostDirectoryOptions = {
  title?: string;
  description?: string;
  value?: string;
};

export type PickHostFileOptions = {
  title?: string;
  description?: string;
  value?: string;
  extensions?: string[];
};

export async function pickHostDirectory(
  options: PickHostDirectoryOptions = {}
): Promise<string | null> {
  const transport = getBackendTransport();
  if (transport.environment === 'desktop') {
    const { open } = await import('@tauri-apps/plugin-dialog');
    const selected = await open({
      directory: true,
      multiple: false,
      title: options.title,
    });
    return typeof selected === 'string' ? selected : null;
  }
  const selected = await FolderPickerDialog.show({
    value: options.value ?? '',
    title: options.title,
    description: options.description,
  });
  return selected ?? null;
}

export async function pickHostDirectories(
  options: PickHostDirectoryOptions = {}
): Promise<string[]> {
  const transport = getBackendTransport();
  if (transport.environment === 'desktop') {
    const { open } = await import('@tauri-apps/plugin-dialog');
    const selected = await open({
      directory: true,
      multiple: true,
      title: options.title,
    });
    const items: unknown[] = Array.isArray(selected)
      ? selected
      : selected
        ? [selected]
        : [];
    return items.filter(
      (item): item is string =>
        typeof item === 'string' && item.trim().length > 0
    );
  }
  const selected = await MultiFolderPickerDialog.show({
    value: options.value ?? '',
    title: options.title,
    description: options.description,
  });
  return Array.isArray(selected)
    ? selected.filter((item) => item.trim().length > 0)
    : [];
}

export async function pickHostFile(
  options: PickHostFileOptions = {}
): Promise<string | null> {
  const transport = getBackendTransport();
  if (transport.environment === 'desktop') {
    const { open } = await import('@tauri-apps/plugin-dialog');
    const selected = await open({
      directory: false,
      multiple: false,
      title: options.title,
      filters: options.extensions?.length
        ? [{ name: 'Files', extensions: options.extensions }]
        : undefined,
    });
    return typeof selected === 'string' ? selected : null;
  }
  const selected = await FolderPickerDialog.show({
    value: options.value ?? '',
    title: options.title,
    description: options.description,
    selectFile: true,
    extensions: options.extensions,
  });
  return selected ?? null;
}

export type PickHostSavePathOptions = {
  title?: string;
  defaultName: string;
  extensions?: string[];
};

/** Native save dialog on desktop; elsewhere picks a host directory and places
 * `defaultName` inside it. */
export async function pickHostSavePath(
  options: PickHostSavePathOptions
): Promise<string | null> {
  const transport = getBackendTransport();
  if (transport.environment === 'desktop') {
    const { save } = await import('@tauri-apps/plugin-dialog');
    const selected = await save({
      title: options.title,
      defaultPath: options.defaultName,
      filters: options.extensions?.length
        ? [{ name: 'Files', extensions: options.extensions }]
        : undefined,
    });
    return selected ?? null;
  }
  const directory = await pickHostDirectory({ title: options.title });
  if (!directory) return null;
  const separator =
    directory.includes('\\') && !directory.includes('/') ? '\\' : '/';
  return `${directory.replace(/[\\/]+$/, '')}${separator}${options.defaultName}`;
}
