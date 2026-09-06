import { definePluginApp } from '@vibex/plugin-sdk/app';

import {
  formatHistoryWhen,
  friendlyError,
  historyIdentity,
  historyStatusLabel,
  historyTitle,
  jobElapsed,
  jobHeadline,
  jobProgress,
  jobStageState,
  localeBundle,
  stepView,
} from './ui.mjs';
import './app.css';

const POLL_MS = 280;

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

function row(id, title, hint, control) {
  return `
    <label class="row" for="${id}">
      <span class="copy">
        <strong>${escapeText(title)}</strong>
        <small>${escapeText(hint)}</small>
      </span>
      ${control}
    </label>
  `;
}

function eyeButton(label) {
  return `
    <button type="button" class="secret-toggle" data-reveal aria-label="${escapeText(label)}">
      <svg viewBox="0 0 16 16" width="16" height="16" aria-hidden="true">
        <path d="M1.5 8s2.6-4.5 6.5-4.5S14.5 8 14.5 8 11.9 12.5 8 12.5 1.5 8 1.5 8z" fill="none" stroke="currentColor" stroke-width="1.3"/>
        <circle cx="8" cy="8" r="2" fill="none" stroke="currentColor" stroke-width="1.3"/>
      </svg>
    </button>
  `;
}

function historyField(index, field, title, value, extra = '') {
  const id = `history-${index}-${field}`;
  return `
    <label class="row" for="${id}">
      <span class="copy"><strong>${escapeText(title)}</strong></span>
      <input id="${id}" class="control ${extra}" data-field="${field}" type="${field === 'port' ? 'number' : 'text'}" value="${escapeText(value)}" autocomplete="off" spellcheck="false" ${field === 'port' ? 'min="1" max="65535"' : ''}/>
    </label>
  `;
}

export default definePluginApp(async ({ bridge, root, signal }) => {
  const bundle = localeBundle(navigator.language);
  const { copy } = bundle;
  const state = {
    jobId: null,
    job: null,
    history: [],
    openHistory: null,
    revealPassword: false,
    historyNote: '',
    historyBusy: '',
    busy: false,
    logSeen: 0,
    pollTimer: 0,
  };

  root.innerHTML = `
    <div class="ssh">
    <form id="form" class="panel" novalidate>
      <header class="section-head">
        <strong>${escapeText(copy.newConnection)}</strong>
      </header>
      <fieldset id="fields" class="fields">
        ${row(
          'displayName',
          copy.name,
          copy.nameHint,
          `<input id="displayName" name="displayName" class="control" type="text" autocomplete="off" spellcheck="false" />`
        )}
        ${row(
          'host',
          copy.host,
          copy.hostHint,
          `<input id="host" name="host" class="control" type="text" autocomplete="off" spellcheck="false" required />`
        )}
        ${row(
          'port',
          copy.port,
          copy.portHint,
          `<input id="port" name="port" class="control control-port" type="number" min="1" max="65535" value="22" required />`
        )}
        ${row(
          'user',
          copy.user,
          copy.userHint,
          `<input id="user" name="user" class="control" type="text" autocomplete="username" spellcheck="false" required />`
        )}
        ${row(
          'password',
          copy.password,
          copy.passwordHint,
          `<span class="secret">
            <input id="password" name="password" class="control" type="password" autocomplete="current-password" />
            ${eyeButton(copy.showPassword)}
          </span>`
        )}
        ${row(
          'jump',
          copy.jump,
          copy.jumpHint,
          `<input id="jump" name="jump" class="control" type="text" autocomplete="off" spellcheck="false" />`
        )}
        <label class="row" for="remember">
          <span class="copy">
            <strong>${escapeText(copy.remember)}</strong>
            <small>${escapeText(copy.rememberHint)}</small>
          </span>
          <span class="switch">
            <input id="remember" name="remember" type="checkbox" />
            <span class="switch-ui" aria-hidden="true"></span>
          </span>
        </label>
      </fieldset>
      <div class="row actions">
        <span class="copy">
          <strong id="status" aria-live="polite"></strong>
          <small id="elapsed" class="elapsed"></small>
        </span>
        <span class="controls">
          <button type="button" class="btn ghost" id="cancel" hidden>${escapeText(copy.cancel)}</button>
          <button type="submit" class="btn primary" id="connect">${escapeText(copy.connect)}</button>
        </span>
      </div>
      <section class="session" id="session" hidden>
        <div class="progress" id="progress">
          <div class="progress-heading">
            <div class="progress-copy">
              <span class="progress-spinner" id="progress-spinner" aria-hidden="true"></span>
              <div>
                <strong id="progress-title">${escapeText(copy.progress)}</strong>
                <span id="progress-hint"></span>
              </div>
            </div>
            <span class="progress-value" id="progress-value">0%</span>
          </div>
          <div
            class="progress-track"
            id="progress-track"
            role="progressbar"
            aria-valuemin="0"
            aria-valuemax="100"
            aria-valuenow="0"
            aria-label="${escapeText(copy.progress)}"
          >
            <div class="progress-fill" id="progress-fill"></div>
          </div>
          <ol class="progress-stages" id="track"></ol>
        </div>
        <pre class="log" id="log" role="log" aria-live="polite" aria-label="${escapeText(copy.logLabel)}"></pre>
        <p class="error" id="error" hidden></p>
      </section>
    </form>
    <section class="panel history" aria-labelledby="history-title">
      <header class="section-head">
        <strong id="history-title">${escapeText(copy.history)}</strong>
      </header>
      <ul class="history-list" id="history"></ul>
    </section>
    </div>
  `;

  const els = {
    shell: root.querySelector('.ssh'),
    form: root.querySelector('#form'),
    fields: root.querySelector('#fields'),
    displayName: root.querySelector('#displayName'),
    host: root.querySelector('#host'),
    port: root.querySelector('#port'),
    user: root.querySelector('#user'),
    password: root.querySelector('#password'),
    jump: root.querySelector('#jump'),
    remember: root.querySelector('#remember'),
    status: root.querySelector('#status'),
    elapsed: root.querySelector('#elapsed'),
    hint: root.querySelector('#progress-hint'),
    progress: root.querySelector('#progress'),
    progressTitle: root.querySelector('#progress-title'),
    progressValue: root.querySelector('#progress-value'),
    progressFill: root.querySelector('#progress-fill'),
    progressTrack: root.querySelector('#progress-track'),
    progressSpinner: root.querySelector('#progress-spinner'),
    connect: root.querySelector('#connect'),
    cancel: root.querySelector('#cancel'),
    session: root.querySelector('#session'),
    track: root.querySelector('#track'),
    log: root.querySelector('#log'),
    error: root.querySelector('#error'),
    history: root.querySelector('#history'),
  };

  const readFields = () => ({
    name: els.displayName.value.trim(),
    host: els.host.value.trim(),
    port: Number(els.port.value || 22),
    user: els.user.value.trim(),
    password: els.password.value,
    jump: els.jump.value.trim(),
    rememberPassword: Boolean(els.remember.checked),
  });

  const stopPoll = () => {
    if (state.pollTimer) {
      window.clearTimeout(state.pollTimer);
      state.pollTimer = 0;
    }
  };

  const paintLog = (job) => {
    const entries = Array.isArray(job?.log) ? job.log : [];
    if (entries.length < state.logSeen) {
      els.log.textContent = '';
      state.logSeen = 0;
    }
    if (entries.length === state.logSeen) return;
    const next = entries.slice(state.logSeen);
    const prefix = els.log.textContent ? '\n' : '';
    els.log.textContent += prefix + next.map((entry) => entry.text).join('\n');
    state.logSeen = entries.length;
    const stick =
      els.log.scrollHeight - els.log.scrollTop - els.log.clientHeight < 48;
    if (stick) els.log.scrollTop = els.log.scrollHeight;
  };

  const paintTrack = (job) => {
    const steps = stepView(job, bundle);
    if (els.track.children.length !== steps.length) {
      els.track.innerHTML = steps
        .map(
          (step) => `
            <li data-step="${escapeText(step.id)}" data-state="upcoming">
              <span aria-hidden="true"></span>
              ${escapeText(step.title)}
            </li>`
        )
        .join('');
    }
    for (const step of steps) {
      const rowEl = els.track.querySelector(`[data-step="${step.id}"]`);
      if (!rowEl) continue;
      rowEl.dataset.state = jobStageState(step);
      rowEl.title = step.detail || step.title;
    }
  };

  const paintProgress = (job, busy) => {
    const percent = jobProgress(job);
    const headline = jobHeadline(job, bundle);
    const current = stepView(job, bundle).find((step) => step.state === 'running');
    els.progressTitle.textContent = current?.title || headline || copy.progress;
    els.hint.textContent = current?.detail || jobElapsed(job) || headline;
    els.progressValue.textContent = `${percent}%`;
    els.progressFill.style.transform = `scaleX(${percent / 100})`;
    els.progressTrack.setAttribute('aria-valuenow', String(percent));
    els.progressTrack.setAttribute(
      'aria-valuetext',
      `${els.progressTitle.textContent} · ${percent}%`
    );
    els.progressSpinner.hidden = !busy;
    els.progress.classList.toggle('is-running', busy);
    els.progress.classList.toggle('is-failed', job?.status === 'failed');
    els.progress.classList.toggle('is-complete', job?.status === 'completed');
    paintTrack(job);
  };

  const readHistoryCard = (card) => {
    const field = (name) =>
      card.querySelector(`[data-field="${name}"]`)?.value ?? '';
    return {
      name: field('name').trim(),
      host: field('host').trim(),
      port: Number(field('port') || 22),
      user: field('user').trim(),
      password: field('password'),
      jump: field('jump').trim(),
      profileId: card.dataset.profileId ?? '',
      origin: card.dataset.origin ?? '',
    };
  };

  const snapshotOpenHistory = () => {
    const card = els.history.querySelector('.history-card.is-open');
    if (!card) return;
    const index = Number(card.dataset.index);
    if (!state.history[index]) return;
    Object.assign(state.history[index], readHistoryCard(card));
  };

  const paintHistory = () => {
    const entries = state.history;
    if (!Array.isArray(entries) || entries.length === 0) {
      els.history.innerHTML = `<li class="history-empty">${escapeText(copy.historyEmpty)}</li>`;
      return;
    }
    els.history.innerHTML = entries
      .map((entry, index) => {
        const title = historyTitle(entry);
        const identity = historyIdentity(entry);
        const when = formatHistoryWhen(entry.at, Date.now(), bundle.zh);
        const status = historyStatusLabel(entry.status, bundle);
        const meta = [identity !== title ? identity : '', when, status].filter(
          Boolean
        );
        const open = state.openHistory === index;
        const reveal = open && state.revealPassword;
        const editor = open
          ? `
            <div class="history-editor">
              ${historyField(index, 'name', copy.name, entry.name ?? '')}
              ${historyField(index, 'host', copy.host, entry.host ?? '')}
              ${historyField(index, 'port', copy.port, String(entry.port ?? 22), 'control-port')}
              ${historyField(index, 'user', copy.user, entry.user ?? '')}
              <label class="row" for="history-${index}-password">
                <span class="copy"><strong>${escapeText(copy.password)}</strong></span>
                <span class="secret">
                  <input id="history-${index}-password" class="control" data-field="password" type="${reveal ? 'text' : 'password'}" value="${escapeText(entry.password ?? '')}" autocomplete="off"/>
                  ${eyeButton(reveal ? copy.hidePassword : copy.showPassword)}
                </span>
              </label>
              ${historyField(index, 'jump', copy.jump, entry.jump ?? '')}
              <p class="history-note" data-note>${escapeText(state.historyNote)}</p>
              <div class="history-actions">
                <button type="button" class="btn ghost" data-test ${state.historyBusy ? 'disabled' : ''}>${escapeText(state.historyBusy === 'test' ? copy.testing : copy.test)}</button>
                <button type="button" class="btn primary" data-save ${state.historyBusy ? 'disabled' : ''}>${escapeText(copy.save)}</button>
              </div>
            </div>`
          : '';
        return `
          <li class="history-card${open ? ' is-open' : ''}" data-index="${index}" data-profile-id="${escapeText(entry.profileId ?? '')}" data-origin="${escapeText(entry.origin ?? '')}">
            <button type="button" class="history-item" data-toggle>
              <span class="copy">
                <strong>${escapeText(title)}</strong>
                <small>${escapeText(meta.join(' · '))}</small>
              </span>
            </button>
            ${editor}
          </li>`;
      })
      .join('');
  };

  const loadHistory = async () => {
    try {
      const history = await bridge.invoke('session.history');
      state.history = Array.isArray(history) ? history : [];
    } catch {
      state.history = [];
    }
    paintHistory();
  };

  const paint = () => {
    const job = state.job;
    const busy = Boolean(state.busy);
    els.fields.disabled = busy;
    els.shell.classList.toggle('is-busy', busy);
    els.connect.disabled = busy;
    els.connect.textContent = busy
      ? copy.connecting
      : job?.status === 'completed'
        ? copy.reconnect
        : copy.connect;
    els.cancel.hidden = !busy;
    const headline = jobHeadline(job, bundle);
    if (els.status.textContent !== headline) els.status.textContent = headline;
    const elapsed = jobElapsed(job);
    els.elapsed.textContent = elapsed;
    const showSession = Boolean(job?.steps?.length || job?.log?.length);
    els.session.hidden = !showSession;
    if (showSession) {
      els.session.setAttribute('aria-busy', busy ? 'true' : 'false');
      paintProgress(job, busy);
      paintLog(job);
    }
    const errorText =
      job?.status === 'failed' ? friendlyError(job.error, bundle.zh) : '';
    if (errorText && els.status.textContent !== errorText) {
      els.status.textContent = errorText;
    }
    els.error.hidden = !(showSession && errorText);
    els.error.textContent = showSession ? errorText : '';
  };

  const poll = async () => {
    if (!state.jobId || signal.aborted) return;
    try {
      const job = await bridge.invoke('session.status', { jobId: state.jobId });
      state.job = job;
      state.busy = job?.status === 'running';
      paint();
      if (state.busy) {
        state.pollTimer = window.setTimeout(() => void poll(), POLL_MS);
      } else {
        void loadHistory();
      }
    } catch (error) {
      state.busy = false;
      state.job = {
        status: 'failed',
        error: error?.message ?? String(error),
        steps: state.job?.steps ?? [],
        log: state.job?.log ?? [],
      };
      paint();
      void loadHistory();
    }
  };

  els.form.addEventListener('click', (event) => {
    const toggle = event.target.closest('[data-reveal]');
    if (!toggle || toggle.closest('.history-card')) return;
    event.preventDefault();
    const reveal = els.password.type === 'password';
    els.password.type = reveal ? 'text' : 'password';
    toggle.setAttribute(
      'aria-label',
      reveal ? copy.hidePassword : copy.showPassword
    );
  });

  els.form.addEventListener('submit', (event) => {
    event.preventDefault();
    void (async () => {
      const target = readFields();
      if (!target.host || !target.user) {
        state.job = {
          status: 'failed',
          error: copy.required,
          steps: [],
          log: [],
        };
        state.busy = false;
        paint();
        return;
      }
      stopPoll();
      state.busy = true;
      state.logSeen = 0;
      els.log.textContent = '';
      state.job = {
        status: 'running',
        step: 'probe',
        steps: stepView(null, bundle).map((step) => ({
          id: step.id,
          state: 'pending',
          detail: '',
        })),
        log: [],
        startedAt: Date.now(),
      };
      paint();
      const started = await bridge.invoke('session.start', target);
      state.jobId = started.jobId;
      state.job = started.job;
      state.busy = started.job?.status === 'running';
      paint();
      await poll();
    })().catch((error) => {
      state.busy = false;
      state.job = {
        status: 'failed',
        error: error?.message ?? String(error),
        steps: state.job?.steps ?? [],
        log: state.job?.log ?? [],
      };
      paint();
    });
  });

  els.cancel.addEventListener('click', () => {
    if (!state.jobId) return;
    void bridge.invoke('session.cancel', { jobId: state.jobId }).then(() => {
      stopPoll();
      state.busy = false;
      if (state.job) {
        state.job = { ...state.job, status: 'cancelled', error: 'cancelled' };
      }
      paint();
      void loadHistory();
    });
  });

  els.history.addEventListener('click', (event) => {
    const card = event.target.closest('.history-card');
    if (!card) return;
    const index = Number(card.dataset.index);
    if (event.target.closest('[data-reveal]')) {
      event.preventDefault();
      snapshotOpenHistory();
      state.revealPassword = !state.revealPassword;
      paintHistory();
      return;
    }
    if (event.target.closest('[data-test]')) {
      event.preventDefault();
      if (state.busy || state.historyBusy) return;
      const target = readHistoryCard(card);
      if (!target.host || !target.user) {
        state.historyNote = copy.required;
        paintHistory();
        return;
      }
      state.historyBusy = 'test';
      state.historyNote = '';
      snapshotOpenHistory();
      paintHistory();
      void bridge
        .invoke('session.test', target)
        .then(() => {
          state.historyNote = copy.testOk;
        })
        .catch((error) => {
          state.historyNote = friendlyError(
            error?.message ?? String(error),
            bundle.zh
          );
        })
        .finally(() => {
          state.historyBusy = '';
          paintHistory();
        });
      return;
    }
    if (event.target.closest('[data-save]')) {
      event.preventDefault();
      if (state.busy || state.historyBusy) return;
      const target = readHistoryCard(card);
      if (!target.host || !target.user) {
        state.historyNote = copy.required;
        paintHistory();
        return;
      }
      state.historyBusy = 'save';
      state.historyNote = '';
      snapshotOpenHistory();
      paintHistory();
      void bridge
        .invoke('session.historySave', { index, ...target })
        .then((history) => {
          state.history = Array.isArray(history) ? history : state.history;
          state.openHistory = 0;
          state.historyNote = copy.saved;
        })
        .catch((error) => {
          state.historyNote = friendlyError(
            error?.message ?? String(error),
            bundle.zh
          );
        })
        .finally(() => {
          state.historyBusy = '';
          paintHistory();
        });
      return;
    }
    if (!event.target.closest('[data-toggle]')) return;
    snapshotOpenHistory();
    state.openHistory = state.openHistory === index ? null : index;
    state.revealPassword = false;
    state.historyNote = '';
    paintHistory();
  });

  paint();
  paintHistory();
  bridge.ready();
  try {
    const saved = await bridge.invoke('session.load');
    if (saved && typeof saved === 'object') {
      els.displayName.value = saved.name ?? '';
      els.host.value = saved.host ?? '';
      els.port.value = String(saved.port ?? 22);
      els.user.value = saved.user ?? '';
      els.jump.value = saved.jump ?? '';
      els.remember.checked = Boolean(saved.rememberPassword);
    }
  } catch {
    // First open.
  }
  await loadHistory();

  signal.addEventListener('abort', stopPoll);
});
