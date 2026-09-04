import { FolderPickerDialog } from '@/components/dialogs/shared/FolderPickerDialog';
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
