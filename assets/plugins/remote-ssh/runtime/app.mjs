import { definePluginApp } from '@vibex/plugin-sdk/app';
import './app.css';

const STEP_LABELS = {
  zh: {
    probe: '探测',
    install: '安装',
    start: '启动',
    tunnel: '隧道',
    pair: '配对',
    save: '保存',
    connect: '接入',
  },
  en: {
    probe: 'Probe',
    install: 'Install',
    start: 'Start',
    tunnel: 'Tunnel',
    pair: 'Pair',
    save: 'Save',
    connect: 'Connect',
  },
};

function zh() {
  return String(navigator.language || '').toLowerCase().startsWith('zh');
}

function copy() {
  return zh()
    ? {
        title: 'SSH 远端 Host',
        host: '主机',
        port: '端口',
        user: '用户',
        password: '密码',
        jump: '跳板（可选）',
        remember: '启用期间记住密码',
        connect: '连接',
        cancel: '取消',
        connecting: '连接中',
      }
    : {
        title: 'SSH remote Host',
        host: 'Host',
        port: 'Port',
        user: 'User',
        password: 'Password',
        jump: 'Jump host',
        remember: 'Remember while enabled',
        connect: 'Connect',
        cancel: 'Cancel',
        connecting: 'Connecting',
      };
}

function escapeText(value) {
  return String(value ?? '').replace(
    /[&<>"']/g,
    (character) =>
      ({
        '&': '&amp;',
        '<': '&lt;',
        '>': '&gt;',
        '"': '&quot;',
        "'": '&#39;',
      })[character]
  );
}

export default definePluginApp(async ({ bridge, root, signal }) => {
  const text = copy();
  const labels = zh() ? STEP_LABELS.zh : STEP_LABELS.en;
  const state = {
    host: '',
    port: 22,
    user: '',
    password: '',
    jump: '',
    rememberPassword: false,
    jobId: null,
    job: null,
    busy: false,
  };

  const render = () => {
    const job = state.job;
    const steps = job?.steps ?? [];
    root.innerHTML = `
      <section class="ssh">
        <h1>${escapeText(text.title)}</h1>
        <div class="grid">
          <label>${escapeText(text.host)}
            <input id="host" type="text" autocomplete="off" value="${escapeText(state.host)}" />
          </label>
          <label>${escapeText(text.port)}
            <input id="port" type="number" min="1" max="65535" value="${escapeText(state.port)}" />
          </label>
        </div>
        <label>${escapeText(text.user)}
          <input id="user" type="text" autocomplete="off" value="${escapeText(state.user)}" />
        </label>
        <label>${escapeText(text.password)}
          <input id="password" type="password" value="${escapeText(state.password)}" />
        </label>
        <label>${escapeText(text.jump)}
          <input id="jump" type="text" autocomplete="off" value="${escapeText(state.jump)}" />
        </label>
        <div class="row">
          <label class="remember">
            <input id="remember" type="checkbox" ${state.rememberPassword ? 'checked' : ''} />
            ${escapeText(text.remember)}
          </label>
          <div class="row">
            ${
              state.busy
                ? `<button class="ghost" id="cancel" type="button">${escapeText(text.cancel)}</button>`
                : ''
            }
            <button id="connect" type="button" ${state.busy ? 'disabled' : ''}>
              ${escapeText(state.busy ? text.connecting : text.connect)}
            </button>
          </div>
        </div>
        ${
          steps.length
            ? `<ul class="steps">${steps
                .map(
                  (step) =>
                    `<li class="${escapeText(step.state)}"><span class="dot"></span><span>${escapeText(
                      labels[step.id] ?? step.id
                    )}</span><span class="detail">${escapeText(step.detail)}</span></li>`
                )
                .join('')}</ul>`
            : ''
        }
        ${job?.error ? `<p class="error">${escapeText(job.error)}</p>` : ''}
      </section>
    `;
    bind();
  };

  const readFields = () => {
    state.host = root.querySelector('#host')?.value.trim() ?? '';
    state.port = Number(root.querySelector('#port')?.value ?? 22);
    state.user = root.querySelector('#user')?.value.trim() ?? '';
    state.password = root.querySelector('#password')?.value ?? '';
    state.jump = root.querySelector('#jump')?.value.trim() ?? '';
    state.rememberPassword = Boolean(root.querySelector('#remember')?.checked);
  };

  const poll = async () => {
    if (!state.jobId || signal.aborted) return;
    const job = await bridge.invoke('session.status', { jobId: state.jobId });
    state.job = job;
    state.busy = job?.status === 'running';
    render();
    if (state.busy) window.setTimeout(() => void poll(), 700);
  };

  const bind = () => {
    root.querySelector('#connect')?.addEventListener('click', () => {
      void (async () => {
        readFields();
        state.busy = true;
        render();
        const started = await bridge.invoke('session.start', {
          host: state.host,
          port: state.port,
          user: state.user,
          password: state.password,
          jump: state.jump,
          rememberPassword: state.rememberPassword,
        });
        state.jobId = started.jobId;
        state.job = started.job;
        render();
        await poll();
      })().catch((error) => {
        state.busy = false;
        state.job = {
          status: 'failed',
          error: error?.message ?? String(error),
          steps: [],
        };
        render();
      });
    });
    root.querySelector('#cancel')?.addEventListener('click', () => {
      void bridge.invoke('session.cancel', { jobId: state.jobId }).then(() => {
        state.busy = false;
        render();
      });
    });
  };

  try {
    const saved = await bridge.invoke('session.load');
    state.host = saved?.host ?? '';
    state.port = saved?.port ?? 22;
    state.user = saved?.user ?? '';
    state.jump = saved?.jump ?? '';
    state.rememberPassword = Boolean(saved?.rememberPassword);
  } catch {
    // First open.
  }
  render();
  bridge.ready();
});
