function escapeText(value) {
  return String(value ?? '').replace(/[&<>"']/g, (character) =>
    ({
      '&': '&amp;',
      '<': '&lt;',
      '>': '&gt;',
      '"': '&quot;',
      "'": '&#39;',
    })[character],
  );
}

function placeholder(title, detail) {
  return `<section class="surface"><h1>${escapeText(title)}</h1><p>${escapeText(detail)}</p></section>`;
}

export async function mountConsoleEmbed(root, invoke) {
  const render = (html) => {
    root.innerHTML = html;
  };
  render(placeholder('Open Connector', '正在启动本机连接器…'));
  const paint = async () => {
    try {
      const status = await invoke('runtime.status');
      if (status?.state === 'running' && status.origin) {
        root.innerHTML = '';
        const frame = document.createElement('iframe');
        frame.setAttribute('aria-label', 'Open Connector');
        frame.src = `${String(status.origin).replace(/\/$/, '')}/`;
        frame.setAttribute(
          'style',
          'border:0;width:100%;height:100%;background:transparent;display:block;',
        );
        frame.addEventListener('error', () => {
          render(
            placeholder(
              '无法打开控制台',
              '本机页面没有加载。到插件配置查看地址，或关掉再打开插件。',
            ),
          );
        });
        root.append(frame);
        return;
      }
      if (status?.state === 'starting') {
        render(placeholder('Open Connector', '正在启动本机连接器…'));
        return;
      }
      render(
        placeholder(
          'Open Connector 未就绪',
          status?.lastError || '到插件配置查看原因。首次启用需要下载运行时。',
        ),
      );
    } catch (error) {
      render(
        placeholder(
          'Open Connector 未就绪',
          error instanceof Error ? error.message : String(error),
        ),
      );
    }
  };
  await paint();
  const timer = setInterval(() => {
    if (!root.isConnected) {
      clearInterval(timer);
      return;
    }
    if (root.querySelector('iframe')) return;
    void paint();
  }, 1500);
  return () => {
    clearInterval(timer);
    root.innerHTML = '';
  };
}
