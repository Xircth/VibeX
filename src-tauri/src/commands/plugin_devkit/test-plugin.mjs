#!/usr/bin/env node
/**
 * VibeX 插件可用性测试程序（零依赖，Node >= 18）。
 *
 * 模拟 VibeX 的插件契约，对一份 vibex-plugin.json 依次执行：
 *   1. manifest 结构校验（必填字段 / 类型 / 占位符一致性 / URL 约束）
 *   2. 环境检查（node / npx）
 *   3. [--run-install] 真实执行 skill 安装命令（skills add 自动补 -y）
 *   4. 控制台探活：分配空闲端口 → 渲染 {{port}} → 真实拉起 console_command
 *      → 轮询 console_url 的 TCP 可达性 → 清理进程
 *   5. Hook 渲染预览
 *
 * 用法：
 *   node test-plugin.mjs <vibex-plugin.json> [--run-install] [--skip-console]
 *                        [--timeout <秒>] [--cwd <目录>]
 *
 * 退出码：0 = 全部通过；1 = 存在失败项。
 */

import { readFileSync } from 'node:fs';
import { createServer } from 'node:net';
import net from 'node:net';
import { spawn, spawnSync } from 'node:child_process';
import process from 'node:process';

// ── CLI 参数 ────────────────────────────────────────────────────────────────

const args = process.argv.slice(2);
const manifestPath = args.find((a) => !a.startsWith('--'));
const flags = {
  runInstall: args.includes('--run-install'),
  skipConsole: args.includes('--skip-console'),
  timeoutSec: Number(args[args.indexOf('--timeout') + 1]) || 120,
  cwd: args.includes('--cwd') ? args[args.indexOf('--cwd') + 1] : process.cwd(),
};

if (!manifestPath) {
  console.error(
    '用法: node test-plugin.mjs <vibex-plugin.json> [--run-install] [--skip-console] [--timeout <秒>] [--cwd <目录>]'
  );
  process.exit(1);
}

// ── 报告工具 ────────────────────────────────────────────────────────────────

let failures = 0;
const pass = (msg) => console.log(`  ✔ ${msg}`);
const warn = (msg) => console.log(`  ⚠ ${msg}`);
const fail = (msg) => {
  failures += 1;
  console.log(`  ✘ ${msg}`);
};
const section = (title) => console.log(`\n[${title}]`);

// ── 1. manifest 校验 ────────────────────────────────────────────────────────

section('manifest 校验');

let manifest;
try {
  manifest = JSON.parse(readFileSync(manifestPath, 'utf8'));
  pass(`已解析 ${manifestPath}`);
} catch (error) {
  fail(`无法解析 manifest：${error.message}`);
  report();
}

const REQUIRED = [
  'name',
  'skill_name',
  'install_command',
  'console_command',
  'hook_message',
];
const OPTIONAL = ['$schema', 'console_url', 'author', 'icon', 'expires_at', 'notes'];

for (const key of REQUIRED) {
  if (typeof manifest[key] === 'string' && manifest[key].trim()) {
    pass(`必填字段 ${key}`);
  } else {
    fail(`必填字段 ${key} 缺失或为空`);
  }
}
for (const key of Object.keys(manifest)) {
  if (!REQUIRED.includes(key) && !OPTIONAL.includes(key)) {
    warn(`未知字段 ${key}（VibeX 导入时会忽略）`);
  }
}

const consoleUrlTemplate =
  typeof manifest.console_url === 'string' && manifest.console_url.trim()
    ? manifest.console_url.trim()
    : null;
const hook = String(manifest.hook_message ?? '');
const consoleCommand = String(manifest.console_command ?? '');

// 占位符一致性
if (hook.includes('{{consoleUrl}}') && !consoleUrlTemplate) {
  warn('hook 引用了 {{consoleUrl}} 但未配置 console_url —— 激活时会渲染为“未指定”提示，且预览无法自动打开');
}
if (!hook.includes('{{consoleCommand}}')) {
  warn('hook 未引用 {{consoleCommand}} —— Agent 将不知道如何启动控制台，请确认 skill 本身会启动服务');
}
const usesPort = [consoleCommand, consoleUrlTemplate ?? '', hook].some((s) =>
  s.includes('{{port}}')
);
if (consoleUrlTemplate?.includes('{{port}}') && !consoleCommand.includes('{{port}}') && !hook.includes('{{port}}')) {
  warn('console_url 使用了 {{port}} 但命令与 hook 都没有 —— Agent 无从得知约定端口');
}

// URL 约束
if (consoleUrlTemplate) {
  try {
    const probeUrl = new URL(consoleUrlTemplate.replaceAll('{{port}}', '65535'));
    const host = probeUrl.hostname;
    if (host === '127.0.0.1' || host === 'localhost' || host === '[::1]') {
      pass(`console_url host 为本机回环地址（${host}）`);
    } else {
      fail(`console_url host 必须是 127.0.0.1/localhost，当前为 ${host}`);
    }
  } catch (error) {
    fail(`console_url 不是合法 URL：${error.message}`);
  }
}

// 可选字段约束
if (manifest.icon && String(manifest.icon).startsWith('data:') && String(manifest.icon).length > 200 * 1024) {
  fail('icon data URL 超过 200KB 上限');
}
if (manifest.expires_at) {
  const expiry = new Date(manifest.expires_at);
  if (Number.isNaN(expiry.getTime())) {
    fail(`expires_at 不是合法时间戳：${manifest.expires_at}`);
  } else if (expiry.getTime() <= Date.now()) {
    warn('expires_at 已是过去时间，导入后插件立即处于过期禁用状态');
  } else {
    pass('expires_at 合法');
  }
}

// ── 2. 环境检查 ─────────────────────────────────────────────────────────────

section('环境检查');
pass(`node ${process.version}`);
const npx = spawnSync('npx --version', { shell: true, encoding: 'utf8' });
if (npx.status === 0) {
  pass(`npx ${npx.stdout.trim()}`);
} else {
  fail('npx 不可用 —— VibeX 保存插件时的环境检查将失败');
}

// ── 3. 安装命令（可选） ─────────────────────────────────────────────────────

// 与 VibeX 行为一致：skills add 命令自动补 -y
function withAutoYes(command) {
  const hasYes = command.split(/\s+/).some((t) => t === '-y' || t === '--yes');
  return command.includes('skills add') && !hasYes ? `${command} -y` : command;
}

if (flags.runInstall) {
  section('skill 安装（真实执行）');
  const command = withAutoYes(manifest.install_command);
  console.log(`  $ ${command}`);
  const result = spawnSync(command, {
    shell: true,
    stdio: 'inherit',
    timeout: 300_000,
    cwd: flags.cwd,
  });
  if (result.status === 0) {
    pass('安装命令执行成功');
  } else {
    fail(`安装命令失败（exit ${result.status ?? 'timeout'}）`);
  }
} else {
  section('skill 安装');
  warn('未执行（加 --run-install 可真实执行安装命令）');
}

// ── 4. 控制台探活 ───────────────────────────────────────────────────────────

function allocatePort() {
  return new Promise((resolve, reject) => {
    const server = createServer();
    server.listen(0, '127.0.0.1', () => {
      const { port } = server.address();
      server.close(() => resolve(port));
    });
    server.on('error', reject);
  });
}

function tcpProbe(host, port, timeoutMs = 1500) {
  return new Promise((resolve) => {
    const socket = net.connect({ host, port });
    const done = (ok) => {
      socket.destroy();
      resolve(ok);
    };
    socket.setTimeout(timeoutMs, () => done(false));
    socket.on('connect', () => done(true));
    socket.on('error', () => done(false));
  });
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

async function testConsole() {
  section('控制台探活（真实拉起）');

  if (!consoleUrlTemplate) {
    warn('未配置 console_url，跳过探活 —— 请人工验证控制台可启动，且 hook 已要求 Agent 回报地址');
    return;
  }

  const port = usesPort ? await allocatePort() : null;
  const command = consoleCommand.replaceAll('{{port}}', String(port ?? ''));
  const url = new URL(consoleUrlTemplate.replaceAll('{{port}}', String(port ?? '')));
  const targetPort = Number(url.port) || (url.protocol === 'https:' ? 443 : 80);

  console.log(`  $ ${command}`);
  console.log(`  探活目标: ${url.hostname}:${targetPort}（超时 ${flags.timeoutSec}s）`);

  const child = spawn(command, {
    shell: true,
    cwd: flags.cwd,
    detached: true,
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let output = '';
  child.stdout.on('data', (d) => (output += d));
  child.stderr.on('data', (d) => (output += d));
  let exited = false;
  child.on('exit', () => (exited = true));

  const deadline = Date.now() + flags.timeoutSec * 1000;
  let reachable = false;
  while (Date.now() < deadline) {
    if (exited) break;
    if (await tcpProbe(url.hostname, targetPort)) {
      reachable = true;
      break;
    }
    await sleep(2000);
  }

  if (reachable) {
    pass(`控制台在 ${url} 可达 —— VibeX 将自动打开 Web Preview`);
  } else if (exited) {
    fail('控制台进程提前退出，末尾输出：');
    console.log(
      output.split('\n').slice(-15).map((l) => `      ${l}`).join('\n')
    );
  } else {
    fail(`${flags.timeoutSec}s 内未探测到 ${url.hostname}:${targetPort} 可达，末尾输出：`);
    console.log(
      output.split('\n').slice(-15).map((l) => `      ${l}`).join('\n')
    );
  }

  // 清理整个进程组（detached 后 child.pid 即组长）
  if (!exited && child.pid) {
    try {
      process.kill(-child.pid, 'SIGTERM');
    } catch {
      try {
        child.kill('SIGTERM');
      } catch {
        /* 已退出 */
      }
    }
  }
  return port;
}

// ── 5. Hook 渲染预览 ────────────────────────────────────────────────────────

function previewHook(port) {
  section('Hook 渲染预览');
  const renderedCommand = consoleCommand.replaceAll('{{port}}', String(port ?? '<port>'));
  const renderedUrl = consoleUrlTemplate
    ? consoleUrlTemplate.replaceAll('{{port}}', String(port ?? '<port>'))
    : '（未指定，请你启动控制台后把访问地址告诉我）';
  const rendered = hook
    .replaceAll('{{pluginName}}', String(manifest.name ?? ''))
    .replaceAll('{{skillName}}', String(manifest.skill_name ?? ''))
    .replaceAll('{{consoleCommand}}', renderedCommand)
    .replaceAll('{{consoleUrl}}', renderedUrl)
    .replaceAll('{{port}}', String(port ?? '<port>'));
  console.log(rendered.split('\n').map((l) => `  │ ${l}`).join('\n'));
  if (/\{\{\w+\}\}/.test(rendered)) {
    fail(`渲染后仍残留未知占位符：${rendered.match(/\{\{\w+\}\}/g).join(' ')}`);
  } else {
    pass('无残留占位符');
  }
}

function report() {
  console.log(
    failures === 0
      ? '\n✅ 全部通过 —— 该 manifest 可交付，用户可在 VibeX 设置 → 插件 → 导入 manifest 中使用。'
      : `\n❌ ${failures} 项失败 —— 请修复后重跑。`
  );
  process.exit(failures === 0 ? 0 : 1);
}

let allocatedPort = null;
if (!flags.skipConsole) {
  allocatedPort = await testConsole();
} else {
  section('控制台探活');
  warn('已通过 --skip-console 跳过，请向用户说明未验证项');
}
previewHook(allocatedPort);
report();
