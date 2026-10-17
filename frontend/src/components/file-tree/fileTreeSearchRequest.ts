type FileTreeSearchListener = () => void;

const listeners = new Set<FileTreeSearchListener>();
let pending = false;

export function requestFileTreeSearch(): void {
  pending = true;
  for (const listener of listeners) {
    listener();
  }
}

export function subscribeFileTreeSearch(
  listener: FileTreeSearchListener
): () => void {
  listeners.add(listener);
  if (pending) listener();
  return () => {
    listeners.delete(listener);
  };
}

export function acknowledgeFileTreeSearch(): void {
  pending = false;
}
