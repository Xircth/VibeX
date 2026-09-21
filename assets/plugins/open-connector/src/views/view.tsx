import { useEffect, useRef } from 'react';

type Environment = {
  invoke: (
    handler: string,
    input?: Record<string, unknown> | null,
  ) => Promise<unknown>;
};

type Status = {
  state?: string;
  origin?: string;
  lastError?: string;
};

function escapeText(value: string) {
  return value.replace(/[&<>"']/g, (character) =>
    ({
      '&': '&amp;',
      '<': '&lt;',
      '>': '&gt;',
      '"': '&quot;',
      "'": '&#39;',
    })[character]!,
  );
}

function setPlaceholder(root: HTMLElement, title: string, detail: string) {
  root.innerHTML = `<section style="box-sizing:border-box;height:100%;padding:16px;background:transparent"><h1 style="margin:0;font-size:15px;font-weight:600">${escapeText(title)}</h1><p style="margin:8px 0 0;opacity:.75">${escapeText(detail)}</p></section>`;
}

export function mount(root: HTMLElement, environment?: Environment) {
  let cancelled = false;
  const paint = async () => {
    if (!environment) {
      setPlaceholder(root, 'Open Connector', '未连接到宿主。');
      return;
    }
    try {
      const status = (await environment.invoke('runtime.status')) as Status;
      if (cancelled) return;
      if (status?.state === 'running' && status.origin) {
        const frame = document.createElement('iframe');
        frame.title = 'Open Connector';
        frame.src = `${String(status.origin).replace(/\/$/, '')}/`;
        frame.style.cssText =
          'border:0;width:100%;height:100%;background:transparent;display:block;';
        root.replaceChildren(frame);
        return;
      }
      const starting = status?.state === 'starting';
      setPlaceholder(
        root,
        starting ? 'Open Connector' : 'Open Connector 未就绪',
        starting
          ? '正在启动本机连接器…'
          : status?.lastError || '到插件配置查看原因。首次启用需要下载运行时。',
      );
    } catch (error) {
      if (cancelled) return;
      setPlaceholder(
        root,
        'Open Connector 未就绪',
        error instanceof Error ? error.message : String(error),
      );
    }
  };
  void paint();
  const timer = window.setInterval(() => {
    if (!root.querySelector('iframe')) void paint();
  }, 1500);
  return () => {
    cancelled = true;
    window.clearInterval(timer);
    root.replaceChildren();
  };
}

export default function OpenConnectorConsole({
  environment,
}: {
  environment?: Environment;
}) {
  const rootRef = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const node = rootRef.current;
    if (!node) return;
    return mount(node, environment);
  }, [environment]);
  return <div ref={rootRef} style={{ height: '100%', minHeight: 0 }} />;
}
