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

function label(text) {
  return `<span class="oc-copy"><strong>${escapeText(text)}</strong></span>`;
}

function chip(text, tone) {
  return `<span class="oc-chip oc-chip--${tone}">${escapeText(text)}</span>`;
}

function statusChip(state) {
  return `<span class="oc-chip oc-chip--${stateTone(state)}">
    <span class="oc-lamp" aria-hidden="true"></span>
    ${escapeText(stateLabel(state))}
  </span>`;
}

function field(text, action) {
  const value = String(text || '').trim();
  return `<div class="oc-control">
    <code class="oc-field" data-copy="${escapeText(action)}">${escapeText(value || '—')}</code>
    ${value ? `<button type="button" class="oc-ghost" data-action="${escapeText(action)}">复制</button>` : ''}
  </div>`;
}

function row(title, control) {
  return `<div class="oc-row">${label(title)}${control}</div>`;
}

export async function mountConfigPanel(root, invoke) {
  const render = (status) => {
    const origin = String(status?.origin || '').trim();
    const dataDir = String(status?.dataDir || '').trim();
    const error = String(status?.lastError || '').trim();
    root.innerHTML = `
      <section class="oc-config">
        <div class="oc-card">
          ${row('状态', statusChip(status?.state))}
          ${row('本机地址', field(origin, 'copy-origin'))}
          ${row('数据目录', field(dataDir, 'copy-path'))}
          ${row('最近错误', error ? chip(error, 'bad') : chip('无', 'idle'))}
          <div class="oc-footer">
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
    if (action === 'copy-origin' || action === 'copy-path') {
      const value = root
        .querySelector(`[data-copy="${action}"]`)
        ?.textContent?.trim();
      const button = event.target?.closest?.('[data-action]');
      if (!value || value === '—' || !button) return;
      void navigator.clipboard.writeText(value).then(() => {
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
