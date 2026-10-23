const owners = new Map<string, { css: string; refs: number }>();
let observer: MutationObserver | null = null;
let observedHead: Node | null = null;

function headNode(): HTMLElement | null {
  return document.head ?? document.documentElement ?? null;
}

function ensure(id: string, css: string) {
  const parent = headNode();
  if (!parent) return;
  let node = document.getElementById(id);
  if (!node || node.tagName !== 'STYLE' || !node.isConnected) {
    node = document.createElement('style');
    node.id = id;
    node.setAttribute('data-vibex-plugin', 'vibex-plugin-computer-use');
    node.textContent = css;
    parent.appendChild(node);
    return;
  }
  if (node.textContent !== css) node.textContent = css;
}

function watch() {
  const root = document.documentElement;
  if (!root || typeof MutationObserver === 'undefined') return;
  if (!observer) {
    observer = new MutationObserver(() => {
      for (const [id, entry] of owners) {
        if (entry.refs > 0) ensure(id, entry.css);
      }
      const head = document.head;
      if (observer && head && observedHead !== head) {
        observer.observe(head, { childList: true });
        observedHead = head;
      }
    });
    observer.observe(root, { childList: true });
  }
  const head = document.head;
  if (head && observedHead !== head) {
    observer.observe(head, { childList: true });
    observedHead = head;
  }
}

/**
 * Keep a plugin stylesheet in `document.head`. Reinserts it if the host, Vite,
 * or a remote unload removes the node while this caller is still mounted.
 */
export function retainStyle(id: string, css: string): () => void {
  const current = owners.get(id);
  if (current) {
    current.refs += 1;
    current.css = css;
  } else {
    owners.set(id, { css, refs: 1 });
  }
  ensure(id, css);
  watch();
  let released = false;
  return () => {
    if (released) return;
    released = true;
    const entry = owners.get(id);
    if (!entry) return;
    entry.refs -= 1;
    if (entry.refs > 0) return;
    owners.delete(id);
    document.getElementById(id)?.remove();
    if (owners.size === 0) {
      observer?.disconnect();
      observer = null;
      observedHead = null;
    }
  };
}
