import { definePluginApp } from '@vibex/plugin-sdk/app';
import './app.css';

/**
 * Rendered in both synthesized surfaces — the conversation timeline card and
 * the settings section. One App serves both because the Host gives them the
 * same session contract; only `allowedMethods` differs per contribution.
 */

function escapeText(value) {
  return String(value).replace(
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

function formatMoment(value) {
  if (!value) return '尚未刷新';
  const at = new Date(value);
  return Number.isNaN(at.getTime()) ? '尚未刷新' : at.toLocaleString();
}

export default definePluginApp(async ({ bridge, root, signal }) => {
  const render = (body) => {
    root.innerHTML = `<section class="digest">${body}</section>`;
  };

  render('<h1>工作区速览</h1><p class="hint">正在读取…</p>');
  bridge.ready();

  try {
    const digest = await bridge.invoke('digest.read');
    render(`
      <h1>工作区速览</h1>
      <dl class="rows">
        <dt>上次刷新</dt><dd>${escapeText(formatMoment(digest?.refreshedAt))}</dd>
        <dt>刷新次数</dt><dd>${escapeText(digest?.refreshCount ?? 0)}</dd>
      </dl>
      <p class="hint">工具栏的「刷新速览」和每 5 分钟的后台任务都会更新它。</p>
    `);
  } catch (error) {
    render(
      `<h1>工作区速览</h1><p class="hint">读取失败：${escapeText(
        error?.message ?? error
      )}</p>`
    );
  }

  signal.addEventListener(
    'abort',
    () => {
      root.innerHTML = '';
    },
    { once: true }
  );
});
