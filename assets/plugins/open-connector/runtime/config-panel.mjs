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

function stateLabel(state) {
  if (state === 'running') return '运行中';
  if (state === 'starting') return '启动中';
  if (state === 'unhealthy') return '不健康';
  return '已停止';
}

export async function mountConfigPanel(root, invoke) {
  const render = (status) => {
    root.innerHTML = `
      <section class="surface config">
        <h1>Open Connector</h1>
        <dl class="rows">
          <dt>状态</dt><dd>${escapeText(stateLabel(status?.state))}</dd>
          <dt>地址</dt><dd>${escapeText(status?.origin || '—')}</dd>
          <dt>数据目录</dt><dd>${escapeText(status?.dataDir || '—')}</dd>
          <dt>最近错误</dt><dd>${escapeText(status?.lastError || '无')}</dd>
        </dl>
        <div class="actions">
          <button type="button" data-action="restart">重启</button>
          <button type="button" data-action="wipe">清除数据</button>
        </div>
        <p>清除数据会删除本机连接和密钥，且不可恢复。卸载插件不会自动删除这些文件。</p>
      </section>
    `;
  };

  const refresh = async () => {
    try {
      render(await invoke('runtime.status'));
    } catch (error) {
      render({
        state: 'unhealthy',
        lastError: error instanceof Error ? error.message : String(error),
      });
    }
  };

  root.addEventListener('click', (event) => {
    const action = event.target?.dataset?.action;
    if (action === 'restart') {
      void invoke('runtime.restart').then(refresh, refresh);
    }
    if (action === 'wipe') {
      if (!window.confirm('清除本机连接和密钥？此操作不能撤销。')) return;
      void invoke('runtime.wipeData').then(refresh, refresh);
    }
  });

  await refresh();
  return () => {
    root.innerHTML = '';
  };
}
