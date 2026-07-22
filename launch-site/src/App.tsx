import { useEffect, useState } from 'react';
import {
  ArrowDown,
  ArrowLeft,
  ArrowRight,
  ArrowUpRight,
  Check,
  ChevronRight,
  CircleDot,
  Code2,
  Eye,
  GitBranch,
  Layers3,
  Play,
  ShieldCheck,
  Sparkles,
  TerminalSquare,
} from 'lucide-react';
import workspacePreview from '../../frontend/public/beta-workspaces-preview.png';
import diffPreview from '../../frontend/public/guide-images/diffs.png';

type VariantKey = 'A' | 'B' | 'C';

const repositoryUrl = 'https://github.com/Xircth/VibeX';
const downloadUrl = `${repositoryUrl}/releases`;

const variants: Array<{ key: VariantKey; name: string }> = [
  { key: 'A', name: '飞行甲板' },
  { key: 'B', name: '证据链' },
  { key: 'C', name: '工具编队' },
];

function getVariant(): VariantKey {
  const value = new URLSearchParams(window.location.search).get('variant');
  return value === 'B' || value === 'C' ? value : 'A';
}

export function App() {
  const [variant, setVariant] = useState<VariantKey>(getVariant);

  const changeVariant = (next: VariantKey) => {
    const url = new URL(window.location.href);
    url.searchParams.set('variant', next);
    window.history.replaceState({}, '', url);
    setVariant(next);
    window.scrollTo({ top: 0, behavior: 'smooth' });
  };

  if (variant === 'B') {
    return (
      <>
        <VariantB />
        <PrototypeSwitcher current={variant} onChange={changeVariant} />
      </>
    );
  }

  if (variant === 'C') {
    return (
      <>
        <VariantC />
        <PrototypeSwitcher current={variant} onChange={changeVariant} />
      </>
    );
  }

  return (
    <>
      <VariantA />
      <PrototypeSwitcher current={variant} onChange={changeVariant} />
    </>
  );
}

function BrandMark() {
  return (
    <a className="brand" href="#top" aria-label="VibeX 首页">
      <span className="brand-glyph" aria-hidden="true">
        V
      </span>
      <span>VibeX</span>
    </a>
  );
}

function SiteHeader({ inverse = false }: { inverse?: boolean }) {
  return (
    <header className={inverse ? 'site-header inverse' : 'site-header'}>
      <BrandMark />
      <nav aria-label="主导航">
        <a href="#workflow">工作流</a>
        <a href="#agents">Agents</a>
        <a href="#local">本地优先</a>
      </nav>
      <a className="header-action" href={downloadUrl}>
        获取 VibeX <ArrowUpRight aria-hidden="true" />
      </a>
    </header>
  );
}

function HeroActions() {
  return (
    <div className="hero-actions">
      <a className="button primary" href={downloadUrl}>
        下载桌面版 <ArrowDown aria-hidden="true" />
      </a>
      <a className="button secondary" href={repositoryUrl}>
        查看源代码 <ArrowUpRight aria-hidden="true" />
      </a>
    </div>
  );
}

function FlightDeck() {
  return (
    <div className="flight-deck" aria-label="VibeX 工作区界面示意">
      <div className="deck-titlebar">
        <span className="traffic"><i /><i /><i /></span>
        <span>VibeX / auth-refactor</span>
        <span className="live-state"><CircleDot /> 运行中</span>
      </div>
      <div className="deck-body">
        <aside className="deck-rail">
          <span className="rail-active">V</span>
          <span>⌘</span>
          <span>△</span>
          <span>◈</span>
        </aside>
        <div className="deck-tasks">
          <div className="deck-label">并行任务</div>
          <button className="task-row active" type="button">
            <span className="status-dot running" />
            <span><b>重构登录流程</b><small>Codex · 2m 41s</small></span>
          </button>
          <button className="task-row" type="button">
            <span className="status-dot done" />
            <span><b>补齐支付测试</b><small>Claude · 已完成</small></span>
          </button>
          <button className="task-row" type="button">
            <span className="status-dot queued" />
            <span><b>更新产品文档</b><small>Gemini · 等待中</small></span>
          </button>
        </div>
        <div className="deck-center">
          <div className="prompt-line"><span>你</span>把认证状态收口到一个可测试的状态机。</div>
          <div className="agent-line">
            <div className="agent-meta"><span>CO</span><b>Codex</b><small>正在实现</small></div>
            <p>我会先确认现有状态边界，再将副作用移出 reducer。</p>
            <div className="plan-line done"><Check />定位状态入口</div>
            <div className="plan-line current"><Play />提取 auth machine</div>
            <div className="plan-line"><span />运行定向测试</div>
          </div>
          <div className="composer">继续说明要求… <kbd>⌘ ↵</kbd></div>
        </div>
        <aside className="deck-inspector">
          <div className="inspector-tabs"><b>变更</b><span>预览</span><span>终端</span></div>
          <div className="diff-file"><span>authMachine.ts</span><em>+84 −31</em></div>
          <pre><code><span className="del">- if (loading) return;</span>{'\n'}<span className="add">+ send({'{'} type: 'SUBMIT' {'}'});</span>{'\n'}{'  '}return transition(state);</code></pre>
          <div className="review-ready"><ShieldCheck /><span><b>可以审查</b><small>测试 18/18 通过</small></span></div>
        </aside>
      </div>
      <div className="task-trace" aria-hidden="true"><span /><span /><span /><span /></div>
    </div>
  );
}

export function VariantA() {
  return (
    <main id="top" className="variant variant-a">
      <SiteHeader />
      <section className="hero hero-a">
        <div className="hero-copy">
          <p className="single-kicker"><span /> 本地优先的 AI 编程工作台</p>
          <h1>把每一个 Agent，放回<span>可控的开发流程。</span></h1>
          <p className="hero-lede">项目、工作区、会话、终端、预览与代码审查——VibeX 把一次 AI 编程任务需要的全部证据，留在同一个桌面。</p>
          <HeroActions />
          <p className="platform-note">适用于 macOS · Windows · Linux</p>
        </div>
        <FlightDeck />
      </section>

      <section className="agent-ribbon" id="agents" aria-label="支持的编码代理">
        <p>用你已经信任的 Agent</p>
        {['Claude Code', 'Codex', 'OpenCode', 'Gemini', 'Cursor Agent', 'Amp'].map((agent) => (
          <span key={agent}>{agent}</span>
        ))}
      </section>

      <section className="workflow-a" id="workflow">
        <div className="section-statement">
          <h2>不是多开几个终端。<br />是让任务始终有上下文。</h2>
          <p>从需求到合并，每一步都能回看、验证、继续。Agent 可以更换，工作流不会丢失。</p>
        </div>
        <div className="workflow-track">
          <article><GitBranch /><b>隔离</b><p>每个任务进入独立 worktree，修改互不污染。</p></article>
          <ChevronRight className="track-arrow" />
          <article><TerminalSquare /><b>执行</b><p>实时查看计划、工具调用与终端输出。</p></article>
          <ChevronRight className="track-arrow" />
          <article><Eye /><b>验证</b><p>在同一窗口预览、比较 diff、留下审查意见。</p></article>
          <ChevronRight className="track-arrow" />
          <article><Check /><b>交付</b><p>确认测试与变更后，再由你决定合并。</p></article>
        </div>
      </section>

      <section className="proof-section" id="local">
        <div className="proof-image">
          <img src={workspacePreview} alt="VibeX 中同时管理多个隔离工作区的界面" />
        </div>
        <div className="proof-copy">
          <span className="proof-index">LOCAL / YOUR MACHINE</span>
          <h2>代码留在本机，判断留给你。</h2>
          <p>VibeX 连接本地 Agent CLI、Git 仓库和开发服务器。它不替你隐藏过程，而是把运行状态、文件变更和验证结果摊开给你看。</p>
          <ul>
            <li><Check /> 本地会话与配置可检查</li>
            <li><Check /> 独立 worktree 并行执行</li>
            <li><Check /> 中断、失败与完成状态明确区分</li>
          </ul>
        </div>
      </section>

      <ClosingCallout />
      <SiteFooter />
    </main>
  );
}

export function VariantB() {
  return (
    <main id="top" className="variant variant-b">
      <SiteHeader inverse />
      <section className="hero-b">
        <div className="hero-b-main">
          <p>一个任务，从一句要求开始。</p>
          <h1>让 AI 写代码。<br /><span>让证据决定是否合并。</span></h1>
          <HeroActions />
        </div>
        <div className="hero-b-aside">
          <p>VibeX 把 Agent 的计划、终端输出、预览和 diff 组织成一条可以审查的任务记录。</p>
          <div className="signal-stack"><span>PLAN</span><span>RUN</span><span>PREVIEW</span><span>REVIEW</span></div>
        </div>
      </section>

      <section className="evidence-journey" id="workflow">
        <div className="journey-copy"><span>任务记录 / auth-refactor</span><h2>过程不是黑盒。</h2><p>每个阶段都有明确状态与下一步，不靠猜测理解 Agent 现在做到哪里。</p></div>
        <div className="journey-line">
          <article><small>09:41</small><div><b>任务已隔离</b><p>创建 worktree <code>auth-refactor</code></p></div><Check /></article>
          <article className="active"><small>09:43</small><div><b>Agent 正在执行</b><p>Codex · 提取认证状态机</p></div><CircleDot /></article>
          <article><small>下一步</small><div><b>等待你的审查</b><p>检查变更、预览与测试结果</p></div><Eye /></article>
        </div>
      </section>

      <section className="split-proof" id="agents">
        <div className="split-window"><FlightDeck /></div>
        <div className="split-message"><h2>Agent 可以换。<br />上下文不必重来。</h2><p>Claude Code、Codex、OpenCode、Gemini 与更多 CLI，都在同一种任务语言里工作。</p><a href={repositoryUrl}>查看支持列表 <ArrowRight /></a></div>
      </section>

      <section className="local-manifesto" id="local">
        <p>LOCAL FIRST</p>
        <h2>你的仓库不是演示数据。<br />所以工具应该靠近它运行。</h2>
        <div><span>代码在本机</span><span>会话可恢复</span><span>配置可检查</span><span>合并由你确认</span></div>
      </section>
      <ClosingCallout dark />
      <SiteFooter dark />
    </main>
  );
}

export function VariantC() {
  return (
    <main id="top" className="variant variant-c">
      <SiteHeader />
      <section className="hero-c">
        <div className="hero-c-copy">
          <span className="coordinate">DESKTOP CONTROL SURFACE / 2026</span>
          <h1>一张桌面，<br />编排你的<br /><i>Agent 编队。</i></h1>
          <p>同时推进多个编码任务，而不丢失分支、上下文、终端与审查证据。</p>
          <HeroActions />
        </div>
        <div className="orbit-map" aria-label="多个 Agent 围绕 VibeX 工作区协作的示意图">
          <div className="orbit-ring ring-one" />
          <div className="orbit-ring ring-two" />
          <div className="orbit-core"><span>V</span><b>VibeX</b><small>3 tasks active</small></div>
          <div className="orbit-node node-claude"><b>Claude</b><small>reviewing</small></div>
          <div className="orbit-node node-codex"><b>Codex</b><small>running</small></div>
          <div className="orbit-node node-gemini"><b>Gemini</b><small>queued</small></div>
          <div className="orbit-pulse" />
        </div>
      </section>

      <section className="command-strip" id="agents">
        <span><Code2 /> 多 Agent</span><span><GitBranch /> 多 Worktree</span><span><Layers3 /> 单一上下文</span><span><ShieldCheck /> 人工确认</span>
      </section>

      <section className="mission-control" id="workflow">
        <div className="mission-heading"><span>MISSION CONTROL</span><h2>并行，但不混乱。</h2></div>
        <div className="mission-list">
          <article><span className="mission-state">ACTIVE</span><h3>重构认证流程</h3><p>Codex 正在运行定向测试</p><div className="mission-progress"><i /></div></article>
          <article><span className="mission-state complete">READY</span><h3>修复移动端布局</h3><p>Claude 已提交 7 个文件变更</p><div className="mission-progress complete"><i /></div></article>
          <article><span className="mission-state waiting">QUEUED</span><h3>更新 API 文档</h3><p>Gemini 等待工作区就绪</p><div className="mission-progress waiting"><i /></div></article>
        </div>
      </section>

      <section className="control-proof" id="local">
        <div><h2>真正的控制，来自可见。</h2><p>VibeX 不替 Agent 制造一个更漂亮的黑盒。它让你看到代理属于哪个工作区、改了什么、是否通过测试，以及谁来做最终决定。</p></div>
        <img src={diffPreview} alt="VibeX 的代码差异审查界面" />
      </section>
      <ClosingCallout />
      <SiteFooter />
    </main>
  );
}

function ClosingCallout({ dark = false }: { dark?: boolean }) {
  return (
    <section className={dark ? 'closing-callout dark' : 'closing-callout'}>
      <div><Sparkles /><span>现在，把下一项任务交给 VibeX。</span></div>
      <h2>少切换窗口。<br />多掌握过程。</h2>
      <a className="button primary" href={downloadUrl}>获取最新版本 <ArrowUpRight /></a>
    </section>
  );
}

function SiteFooter({ dark = false }: { dark?: boolean }) {
  return (
    <footer className={dark ? 'site-footer dark' : 'site-footer'}>
      <BrandMark />
      <p>本地优先的 AI 编程工作台</p>
      <div><a href={repositoryUrl}>GitHub</a><a href={`${repositoryUrl}/issues`}>反馈问题</a></div>
      <a className="icp" href="https://beian.miit.gov.cn/" target="_blank" rel="noreferrer">蜀ICP备2026003253号-1</a>
    </footer>
  );
}

function PrototypeSwitcher({ current, onChange }: { current: VariantKey; onChange: (next: VariantKey) => void }) {
  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      const target = event.target as HTMLElement;
      if (target.matches('input, textarea, [contenteditable="true"]')) return;
      if (event.key !== 'ArrowLeft' && event.key !== 'ArrowRight') return;
      const index = variants.findIndex((item) => item.key === current);
      const direction = event.key === 'ArrowRight' ? 1 : -1;
      const next = variants[(index + direction + variants.length) % variants.length];
      onChange(next.key);
    };
    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, [current, onChange]);

  if (import.meta.env.PROD) return null;
  const index = variants.findIndex((item) => item.key === current);
  const previous = variants[(index - 1 + variants.length) % variants.length];
  const next = variants[(index + 1) % variants.length];

  return (
    <aside className="prototype-switcher" aria-label="发布页视觉方案切换器">
      <button type="button" onClick={() => onChange(previous.key)} aria-label={`切换到方案 ${previous.key}`}><ArrowLeft /></button>
      <span><small>原型方案</small><b>{current} — {variants[index].name}</b></span>
      <button type="button" onClick={() => onChange(next.key)} aria-label={`切换到方案 ${next.key}`}><ArrowRight /></button>
    </aside>
  );
}
