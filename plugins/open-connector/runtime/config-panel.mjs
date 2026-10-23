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

function copyIcon() {
  return `<svg viewBox="0 0 16 16" width="14" height="14" aria-hidden="true"><rect x="5.5" y="1.75" width="7.5" height="9.5" rx="1.25" fill="none" stroke="currentColor" stroke-width="1.25"/><path d="M3 4.75h6.5v9.5H3a1.25 1.25 0 0 1-1.25-1.25V6A1.25 1.25 0 0 1 3 4.75z" fill="none" stroke="currentColor" stroke-width="1.25"/></svg>`;
}

function checkIcon() {
  return `<svg viewBox="0 0 16 16" width="14" height="14" aria-hidden="true"><path d="M3.5 8.5 6.5 11.5 12.5 4.5" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"/></svg>`;
}

function label(text) {
  return `<span class="oc-copy"><strong>${escapeText(text)}</strong></span>`;
}

function statusChip(state) {
  return `<span class="oc-chip oc-chip--${stateTone(state)}">
    <span class="oc-lamp" aria-hidden="true"></span>
    ${escapeText(stateLabel(state))}
  </span>`;
}

function field(text, action) {
  const value = String(text || '').trim();
  return `<div class="oc-field">
    <code data-copy="${escapeText(action)}">${escapeText(value || '—')}</code>
    ${
      value
        ? `<button type="button" class="oc-icon-btn" data-action="${escapeText(action)}" aria-label="复制">${copyIcon()}</button>`
        : ''
    }
  </div>`;
}

function row(title, control) {
  return `<div class="oc-row">${label(title)}${control}</div>`;
}

export async function mountConfigPanel(root, invoke) {
  const render = (status) => {
    const origin = String(status?.origin || '').trim();
    const dataDir = String(status?.dataDir || '').trim();
    root.innerHTML = `
      <section class="oc-config">
        <div class="oc-card">
          ${row('状态', statusChip(status?.state))}
          ${row('本机地址', field(origin, 'copy-origin'))}
          ${row('数据目录', field(dataDir, 'copy-path'))}
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
      const button = event.target?.closest?.('[data-action]');
      const value = root
        .querySelector(`[data-copy="${action}"]`)
        ?.textContent?.trim();
      if (!value || value === '—' || !button) return;
      void navigator.clipboard.writeText(value).then(() => {
        button.innerHTML = checkIcon();
        window.setTimeout(() => {
          if (button.isConnected) button.innerHTML = copyIcon();
        }, 1200);
      });
    }
  });

  await refresh();
  return () => {
    root.innerHTML = '';
  };
}
