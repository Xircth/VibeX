import { hostFileSrc } from '@/lib/hostAsset';
import { writeTextToClipboard } from '@/utils/clipboard';

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
    const copied = await writeTextToClipboard(text);
    if (!copied) {
      throw new Error('Failed to copy text to clipboard');
    }
    return;
  }
  if (kind !== 'image') {
    return;
  }

  const src = await hostFileSrc(item.file_path);
  const response = await fetch(src);
  const blob = await response.blob();
  const type = blob.type.startsWith('image/') ? blob.type : 'image/png';
  const clipboard =
    typeof navigator !== 'undefined' ? navigator.clipboard : undefined;
  if (
    typeof ClipboardItem !== 'undefined' &&
    clipboard &&
    typeof clipboard.write === 'function'
  ) {
    await clipboard.write([new ClipboardItem({ [type]: blob })]);
    return;
  }
  const copied = await writeTextToClipboard(item.file_path);
  if (!copied) {
    throw new Error('Failed to copy image path to clipboard');
  }
}
