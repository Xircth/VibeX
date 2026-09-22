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

function stateTone(state) {
  if (state === 'running') return 'ok';
  if (state === 'unhealthy') return 'bad';
  if (state === 'starting') return 'busy';
  return 'idle';
}

export async function mountConfigPanel(root, invoke) {
  const render = (status) => {
    const origin = String(status?.origin || '').trim();
    const dataDir = String(status?.dataDir || '').trim();
    const error = String(status?.lastError || '').trim();
    root.innerHTML = `
      <section class="oc-config">
        <div class="oc-card">
          <h2>本机连接器</h2>
          <div class="oc-row">
            <div class="oc-copy">
              <strong>状态</strong>
            </div>
            <span class="oc-status" data-tone="${stateTone(status?.state)}">
              <span class="oc-lamp" aria-hidden="true"></span>
              ${escapeText(stateLabel(status?.state))}
            </span>
          </div>
          <div class="oc-row">
            <div class="oc-copy">
              <strong>本机地址</strong>
            </div>
            <div class="oc-control">
              <code class="oc-field" data-origin>${escapeText(origin || '—')}</code>
              ${origin ? `<button type="button" class="oc-ghost" data-action="copy">复制</button>` : ''}
            </div>
          </div>
          <div class="oc-row oc-row--stack">
            <div class="oc-copy">
              <strong>数据目录</strong>
              <small class="oc-path">${escapeText(dataDir || '—')}</small>
            </div>
          </div>
          <div class="oc-row">
            <div class="oc-copy">
              <strong>最近错误</strong>
            </div>
            <span class="${error ? 'oc-error' : 'oc-quiet'}">${escapeText(error || '无')}</span>
          </div>
          <div class="oc-footer">
            <p class="oc-hint">清除数据会删除本机连接和密钥，且不可恢复。</p>
            <div class="oc-bar">
              <button type="button" class="oc-btn" data-action="restart">重启</button>
              <button type="button" class="oc-btn oc-btn--danger" data-action="wipe">清除数据</button>
            </div>
          </div>
        </div>
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
    const action = event.target?.closest?.('[data-action]')?.dataset?.action;
    if (action === 'restart') {
      void invoke('runtime.restart').then(refresh, refresh);
    }
    if (action === 'wipe') {
      if (!window.confirm('清除本机连接和密钥？此操作不能撤销。')) return;
      void invoke('runtime.wipeData').then(refresh, refresh);
    }
    if (action === 'copy') {
      const origin = root.querySelector('[data-origin]')?.textContent?.trim();
      const button = event.target?.closest?.('[data-action="copy"]');
      if (!origin || origin === '—' || !button) return;
      void navigator.clipboard.writeText(origin).then(() => {
        button.textContent = '已复制';
        window.setTimeout(() => {
          if (button.isConnected) button.textContent = '复制';
        }, 1200);
      });
    }
  });

  await refresh();
  return () => {
    root.innerHTML = '';
  };
}
