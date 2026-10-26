import { hostFileSrc } from '@/lib/hostAsset';

import type { SpaceCollectionItemRecord } from './CollaborationSpaceCollectionPanel';

function collectionItemKind(item: SpaceCollectionItemRecord): string {
  return item.item_kind ?? item.kind ?? 'file';
}

export async function copySpaceCollectionItem(
  item: SpaceCollectionItemRecord
): Promise<void> {
  const kind = collectionItemKind(item);
  if (kind === 'text') {
    const text = item.text_content ?? item.file_name ?? item.name ?? '';
    await navigator.clipboard.writeText(text);
    return;
  }
  if (kind !== 'image') {
    return;
  }

  const src = await hostFileSrc(item.file_path);
  const response = await fetch(src);
  const blob = await response.blob();
  const type = blob.type.startsWith('image/') ? blob.type : 'image/png';
  const clipboard = navigator.clipboard;
  if (
    typeof ClipboardItem !== 'undefined' &&
    typeof clipboard.write === 'function'
  ) {
    await clipboard.write([new ClipboardItem({ [type]: blob })]);
    return;
  }
  await clipboard.writeText(item.file_path);
}
