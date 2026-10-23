export const LOG_CAP = 300;
export const LINE_CAP = 400;

export function sanitizeRemoteOutput(text) {
  return String(text ?? '')
    .replace(/\x1b\[[0-9;?]*[ -/]*[@-~]/g, '')
    .replace(/\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)/g, '')
    .split(/\r\n|\n|\r/)
    .map((line) =>
      line.replace(/[\x00-\x08\x0b\x0c\x0e-\x1f]/g, '').trimEnd()
    )
    .filter(
      (line) =>
        line.length > 0 &&
        !/^#=#=#/.test(line) &&
        !/^[\s#=*]+$/.test(line)
    );
}

export function appendJobLog(job, text, meta = {}) {
  if (!job || typeof job !== 'object') return [];
  if (!Array.isArray(job.log)) job.log = [];
  const lines = sanitizeRemoteOutput(text);
  const step = meta.step ?? job.step ?? null;
  const stream = meta.stream ?? 'stdout';
  const now = Date.now();
  for (const line of lines) {
    job.log.push({
      t: now,
      step,
      stream,
      text: line.slice(0, LINE_CAP),
    });
  }
  if (job.log.length > LOG_CAP) {
    job.log.splice(0, job.log.length - LOG_CAP);
  }
  job.updatedAt = now;
  const item = Array.isArray(job.steps)
    ? job.steps.find((entry) => entry.id === job.step)
    : null;
  if (item?.state === 'running' && job.log.length) {
    item.detail = job.log[job.log.length - 1].text;
  }
  return lines;
}

export function formatElapsed(ms) {
  const seconds = Math.max(0, Math.floor((Number(ms) || 0) / 1000));
  if (seconds < 60) return `${seconds}s`;
  const minutes = Math.floor(seconds / 60);
  const rest = seconds % 60;
  return `${minutes}m ${rest}s`;
}
