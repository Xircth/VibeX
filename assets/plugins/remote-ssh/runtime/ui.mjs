import { formatElapsed } from './log.mjs';

const STEP_IDS = [
  'probe',
  'install',
  'start',
  'tunnel',
  'pair',
  'save',
  'connect',
];

export const STEP_COPY = {
  zh: {
    probe: {
      title: '探测主机',
      running: '正在登录并读取系统信息',
      done: '已确认远端环境',
    },
    install: {
      title: '安装 Host',
      running: '正在下载并安装 Host family',
      done: '已安装',
    },
    start: {
      title: '启动服务',
      running: '正在启动远端服务',
      done: '服务已就绪',
    },
    tunnel: {
      title: '建立隧道',
      running: '正在把远端端口转到本机',
      done: '隧道已建立',
    },
    pair: {
      title: '配对',
      running: '正在申请接入码',
      done: '已配对',
    },
    save: {
      title: '保存',
      running: '正在保存远程连接',
      done: '已保存',
    },
    connect: {
      title: '接入',
      running: '正在打开远端 Host 窗口',
      done: '已接入',
    },
  },
  en: {
    probe: {
      title: 'Probe host',
      running: 'Signing in and reading the remote system',
      done: 'Remote environment confirmed',
    },
    install: {
      title: 'Install Host',
      running: 'Downloading and installing Host family',
      done: 'Installed',
    },
    start: {
      title: 'Start server',
      running: 'Starting the remote server',
      done: 'Server ready',
    },
    tunnel: {
      title: 'Open tunnel',
      running: 'Forwarding the remote port locally',
      done: 'Tunnel ready',
    },
    pair: {
      title: 'Pair',
      running: 'Requesting an access code',
      done: 'Paired',
    },
    save: {
      title: 'Save',
      running: 'Saving the remote connection',
      done: 'Saved',
    },
    connect: {
      title: 'Connect',
      running: 'Opening a window for the remote Host',
      done: 'Connected',
    },
  },
};

export const COPY = {
  zh: {
    name: '名称',
    nameHint: '已保存列表里的名字，可留空',
    host: '主机',
    hostHint: '远端 IP 或主机名',
    port: '端口',
    portHint: '默认 22',
    user: '用户',
    userHint: '登录名，大小写敏感',
    password: '密码',
    passwordHint: '没有本机密钥时填这个；有密钥也可以留空',
    jump: '跳板',
    jumpHint: '可选，格式 user@bastion',
    remember: '记住密码',
    rememberHint: '仅在插件启用期间保存在本机',
    connect: '连接',
    cancel: '取消',
    connecting: '连接中',
    reconnect: '重新连接',
    required: '请填写主机和用户',
    progress: '连接进度',
    newConnection: '新建连接',
    history: '连接历史',
    historyEmpty: '还没有记录',
    test: '测试连接',
    testing: '测试中',
    testOk: 'SSH 已连通',
    save: '保存',
    saved: '已保存',
    showPassword: '显示密码',
    hidePassword: '隐藏密码',
    logLabel: '安装输出',
    pending: '等待',
    running: '进行中',
    done: '完成',
    idle: '',
    completed: '已接入',
    cancelled: '已取消',
    failed: '失败',
  },
  en: {
    name: 'Name',
    nameHint: 'Shown in the saved Host list; optional',
    host: 'Host',
    hostHint: 'Remote IP or hostname',
    port: 'Port',
    portHint: 'Default 22',
    user: 'User',
    userHint: 'Login name, case-sensitive',
    password: 'Password',
    passwordHint: 'Required when this machine has no SSH key',
    jump: 'Jump host',
    jumpHint: 'Optional, user@bastion',
    remember: 'Remember password',
    rememberHint: 'Stored locally while this plugin is enabled',
    connect: 'Connect',
    cancel: 'Cancel',
    connecting: 'Connecting',
    reconnect: 'Connect again',
    required: 'Host and user are required',
    progress: 'Connection',
    newConnection: 'New connection',
    history: 'Connection history',
    historyEmpty: 'No history yet',
    test: 'Test connection',
    testing: 'Testing',
    testOk: 'SSH reachable',
    save: 'Save',
    saved: 'Saved',
    showPassword: 'Show password',
    hidePassword: 'Hide password',
    logLabel: 'Install output',
    pending: 'Waiting',
    running: 'In progress',
    done: 'Done',
    idle: '',
    completed: 'Connected',
    cancelled: 'Cancelled',
    failed: 'Failed',
  },
};

export function localeBundle(locale) {
  const zh = String(locale ?? '').toLowerCase().startsWith('zh');
  return {
    zh,
    copy: zh ? COPY.zh : COPY.en,
    steps: zh ? STEP_COPY.zh : STEP_COPY.en,
  };
}

export function friendlyError(message, zh) {
  const text = String(message ?? '').trim();
  if (!text) return '';
  if (/cancelled/i.test(text)) {
    return zh ? '已取消' : 'Cancelled';
  }
  if (/permission denied/i.test(text)) {
    return zh
      ? 'SSH 拒绝登录。核对用户名大小写、密码或密钥。'
      : 'SSH refused the login. Check username case, password, or key.';
  }
  if (
    /REMOTE HOST IDENTIFICATION HAS CHANGED/i.test(text) ||
    /Host key verification failed/i.test(text)
  ) {
    return zh
      ? '这台机器的 SSH 主机密钥变了，不是密码问题。确认是你自己重装或换机后，在本机执行 ssh-keygen -R <主机>，再连接。'
      : 'The SSH host key changed. This is not a password problem. After you confirm the server was reinstalled, run ssh-keygen -R <host> locally and connect again.';
  }
  if (/empty reply|curl: \(52\)/i.test(text)) {
    return zh
      ? 'GitHub 下载失败，远端暂时拿不到安装包。稍后重试。'
      : 'GitHub returned an empty download. Retry in a moment.';
  }
  if (/could not resolve the latest release/i.test(text) || /HTTP 403/i.test(text)) {
    return zh
      ? '无法读取 GitHub 最新版本。稍后重试，或设置 VIBEX_VERSION 指定版本。'
      : 'Could not read the latest GitHub release. Retry later, or set VIBEX_VERSION.';
  }
  if (/GLIBC_\d/i.test(text) || /glibc 2\.\d+ is too old/i.test(text)) {
    return zh
      ? '远端系统过旧。官方 Linux Host 需要 glibc 2.34+（Ubuntu 22.04 或 RHEL 9）。'
      : 'The remote OS is too old. The Linux Host needs glibc 2.34+ (Ubuntu 22.04 or RHEL 9).';
  }
  if (/tunnel closed before|tunnel exited/i.test(text)) {
    return zh
      ? 'SSH 隧道没有建立。请再连一次。'
      : 'The SSH tunnel did not stay open. Connect again.';
  }
  if (/timed out|timeout/i.test(text)) {
    return zh
      ? 'SSH 连接超时。检查主机、端口和网络。'
      : 'SSH timed out. Check the host, port, and network.';
  }
  if (/host and user are required/i.test(text)) {
    return zh ? '请填写主机和用户' : 'Host and user are required';
  }
  if (/could not reach Host/i.test(text)) {
    return zh
      ? '本机连不上这台 Host。请再连一次。'
      : 'This computer could not reach the Host. Connect again.';
  }
  return text;
}

export function jobElapsed(job, now = Date.now()) {
  if (!job || job.status !== 'running' || !job.startedAt) return '';
  return formatElapsed(now - job.startedAt);
}

export function jobHeadline(job, bundle) {
  const { copy, steps } = bundle;
  if (!job || job.status === 'unknown') return copy.idle;
  if (job.status === 'completed') {
    const origin = String(job.origin ?? '').replace(/^https?:\/\//, '');
    return origin ? `${copy.completed} ${origin}` : copy.completed;
  }
  if (job.status === 'cancelled') return copy.cancelled;
  if (job.status === 'failed') {
    return friendlyError(job.error, bundle.zh) || copy.failed;
  }
  const current = steps[job.step] ?? steps.probe;
  return current?.running ?? copy.connecting;
}

export function stepView(job, bundle) {
  const ids = job?.steps?.length
    ? job.steps.map((entry) => entry.id)
    : STEP_IDS;
  return ids.map((id) => {
    const item = job?.steps?.find((entry) => entry.id === id);
    const state = item?.state ?? 'pending';
    const copy = bundle.steps[id] ?? { title: id, running: '', done: '' };
    let detail = '';
    if (state === 'running') {
      detail = item?.detail || copy.running;
    } else if (state === 'done') {
      detail = item?.detail || copy.done;
    } else if (state === 'failed') {
      detail = item?.detail || bundle.copy.failed;
    }
    return {
      id,
      title: copy.title,
      state,
      detail,
      stateLabel:
        state === 'running'
          ? bundle.copy.running
          : state === 'done'
            ? bundle.copy.done
            : state === 'failed'
              ? bundle.copy.failed
              : '',
    };
  });
}

export function logText(job) {
  if (!Array.isArray(job?.log) || job.log.length === 0) return '';
  return job.log.map((entry) => entry.text).join('\n');
}

export const HISTORY_KEY = 'config:history';
export const HISTORY_LIMIT = 12;

export function profileName(target) {
  const named = String(target?.name ?? '').trim();
  if (named) return named;
  const user = String(target?.user ?? '').trim();
  const host = String(target?.host ?? '').trim();
  if (user && host) return `${user}@${host}`;
  return host || user;
}

export function historyRecord(target, status, at = Date.now()) {
  return {
    name: profileName(target),
    host: String(target?.host ?? '').trim(),
    port: Number(target?.port ?? 22) || 22,
    user: String(target?.user ?? '').trim(),
    password: String(target?.password ?? ''),
    jump: String(target?.jump ?? '').trim(),
    profileId: String(target?.profileId ?? '').trim(),
    origin: String(target?.origin ?? '').trim(),
    status,
    at,
  };
}

export function sameHistoryTarget(left, right) {
  return (
    String(left?.host ?? '') === String(right?.host ?? '') &&
    Number(left?.port ?? 22) === Number(right?.port ?? 22) &&
    String(left?.user ?? '') === String(right?.user ?? '') &&
    String(left?.jump ?? '') === String(right?.jump ?? '')
  );
}

export function upsertHistory(list, record, limit = HISTORY_LIMIT) {
  if (!record?.host || !record?.user) return Array.isArray(list) ? list : [];
  const previous = (Array.isArray(list) ? list : []).find((entry) =>
    sameHistoryTarget(entry, record)
  );
  const merged = {
    ...record,
    password: record.password || previous?.password || '',
    profileId: record.profileId || previous?.profileId || '',
    origin: record.origin || previous?.origin || '',
  };
  const rest = (Array.isArray(list) ? list : []).filter(
    (entry) => !sameHistoryTarget(entry, merged)
  );
  return [merged, ...rest].slice(0, limit);
}

export function replaceHistory(list, index, record, limit = HISTORY_LIMIT) {
  if (!record?.host || !record?.user) return Array.isArray(list) ? list : [];
  const current = Array.isArray(list) ? list : [];
  const previous = current[index] ?? {};
  const merged = {
    ...record,
    password: record.password || previous.password || '',
    profileId: record.profileId || previous.profileId || '',
    origin: record.origin || previous.origin || '',
  };
  const rest = current.filter(
    (entry, entryIndex) =>
      entryIndex !== index && !sameHistoryTarget(entry, merged)
  );
  return [merged, ...rest].slice(0, limit);
}

export function matchingSavedProfile(profiles, entry) {
  const items = Array.isArray(profiles) ? profiles : [];
  if (entry?.profileId) {
    const byId = items.find((profile) => profile.id === entry.profileId);
    if (byId) return byId;
  }
  return items.find((profile) => {
    if (profile.provisionKind !== 'ssh' && profile.provision_kind !== 'ssh') {
      return false;
    }
    const provision = profile.provision ?? {};
    return sameHistoryTarget(provision, entry);
  });
}

export function historyIdentity(entry) {
  const port = Number(entry.port ?? 22) === 22 ? '' : `:${entry.port}`;
  const jump = entry.jump ? ` · ${entry.jump}` : '';
  return `${entry.user}@${entry.host}${port}${jump}`;
}

export function historyTitle(entry) {
  const named = String(entry?.name ?? '').trim();
  const identity = historyIdentity(entry);
  return named && named !== identity ? named : identity;
}

export function historyStatusLabel(status, bundle) {
  if (status === 'completed') return bundle.copy.completed;
  if (status === 'cancelled') return bundle.copy.cancelled;
  if (status === 'failed') return bundle.copy.failed;
  return '';
}

export function formatHistoryWhen(at, now = Date.now(), zh = false) {
  const time = Number(at);
  if (!Number.isFinite(time) || time <= 0) return '';
  const delta = Math.max(0, now - time);
  if (delta < 60_000) return zh ? '刚刚' : 'Just now';
  if (delta < 3_600_000) {
    const minutes = Math.floor(delta / 60_000);
    return zh ? `${minutes} 分钟前` : `${minutes}m ago`;
  }
  if (delta < 86_400_000) {
    const hours = Math.floor(delta / 3_600_000);
    return zh ? `${hours} 小时前` : `${hours}h ago`;
  }
  const days = Math.floor(delta / 86_400_000);
  if (days < 7) return zh ? `${days} 天前` : `${days}d ago`;
  return new Date(time).toLocaleDateString(zh ? 'zh-CN' : 'en', {
    month: 'short',
    day: 'numeric',
  });
}

export function jobProgress(job) {
  if (!job || job.status === 'unknown') return 0;
  if (job.status === 'completed') return 100;
  const steps = Array.isArray(job.steps) && job.steps.length > 0
    ? job.steps
    : STEP_IDS.map((id) => ({ id, state: 'pending' }));
  const weight = 1 / steps.length;
  let value = 0;
  for (const step of steps) {
    if (step.state === 'done') value += weight;
    else if (step.state === 'running' || step.state === 'failed') {
      value += weight * 0.55;
    }
  }
  const percent = Math.round(value * 100);
  if (job.status === 'running') return Math.min(99, Math.max(4, percent));
  return Math.min(99, percent);
}

export function jobStageState(step) {
  if (step.state === 'done') return 'complete';
  if (step.state === 'running' || step.state === 'failed') return 'current';
  return 'upcoming';
}
