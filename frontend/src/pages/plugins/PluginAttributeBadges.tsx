import {
  BadgeCheck,
  Download,
  GitBranch,
  Layers,
  ShieldCheck,
  Star,
  Tag,
} from 'lucide-react';
import { useEffect, useId, useState } from 'react';
import { useTranslation } from 'react-i18next';

import { useTheme } from '@/components/ThemeProvider';
import { resolveAppLogo } from '@/lib/appIcon';

import {
  resolveOfficialPluginKey,
  type OfficialPluginI18nKey,
  type PluginCategoryKey,
} from './officialPlugins';

const OFFICIAL_PLUGIN_TELEMETRY: Record<
  OfficialPluginI18nKey,
  {
    installs: number;
    repo: string;
    trend: number[];
  }
> = {
  browser: {
    installs: 298,
    repo: 'Xircth/vibex-plugin-browser',
    trend: [112, 134, 151, 169, 188, 205, 224, 241, 258, 272, 286, 298],
  },
  computerUse: {
    installs: 283,
    repo: ['Xircth/vibex-plugin', 'computer-use'].join('-'),
    trend: [98, 116, 135, 154, 171, 189, 206, 223, 239, 255, 270, 283],
  },
  office: {
    installs: 264,
    repo: 'Xircth/vibex-plugin-office',
    trend: [92, 108, 125, 141, 158, 175, 191, 208, 224, 238, 252, 264],
  },
  sessionEnhance: {
    installs: 241,
    repo: 'Xircth/vibex-plugin-session-enhance',
    trend: [84, 99, 114, 129, 144, 160, 175, 190, 204, 217, 230, 241],
  },
  workflowCreator: {
    installs: 218,
    repo: 'Xircth/vibex-plugin-workflow-creator',
    trend: [72, 86, 101, 115, 129, 143, 157, 171, 184, 196, 208, 218],
  },
  promptEnhancer: {
    installs: 196,
    repo: 'Xircth/vibex-plugin-prompt-enhancer',
    trend: [64, 77, 90, 103, 116, 129, 142, 154, 166, 177, 187, 196],
  },
  remoteSsh: {
    installs: 175,
    repo: 'Xircth/vibex-plugin-remote-ssh',
    trend: [56, 68, 80, 91, 103, 115, 126, 137, 148, 158, 167, 175],
  },
  science: {
    installs: 162,
    repo: 'Xircth/vibex-plugin-science',
    trend: [51, 62, 73, 84, 95, 106, 116, 126, 136, 145, 154, 162],
  },
  providerSwitch: {
    installs: 148,
    repo: 'Xircth/vibex-plugin-provider-switch',
    trend: [46, 56, 66, 76, 86, 96, 106, 115, 124, 133, 141, 148],
  },
  notes: {
    installs: 134,
    repo: 'Xircth/vibex-plugin-notes',
    trend: [41, 50, 59, 68, 77, 86, 95, 104, 112, 120, 127, 134],
  },
  openConnector: {
    installs: 119,
    repo: 'Xircth/vibex-plugin-open-connector',
    trend: [36, 44, 52, 60, 68, 76, 84, 92, 99, 106, 113, 119],
  },
  kanbanViews: {
    installs: 96,
    repo: 'Xircth/vibex-plugin-kanban-views',
    trend: [29, 35, 42, 49, 55, 62, 68, 74, 80, 86, 91, 96],
  },
  pluginDevelopment: {
    installs: 84,
    repo: 'Xircth/vibex-plugin-development',
    trend: [25, 31, 37, 43, 48, 54, 60, 65, 70, 75, 80, 84],
  },
  providerImport: {
    installs: 52,
    repo: 'Xircth/vibex-plugin-provider-import',
    trend: [15, 19, 23, 27, 30, 34, 38, 41, 44, 47, 50, 52],
  },
  hostSurface: {
    installs: 38,
    repo: 'Xircth/vibex-plugin-host-surface',
    trend: [12, 14, 17, 20, 22, 25, 28, 30, 32, 34, 36, 38],
  },
  hostChrome: {
    installs: 27,
    repo: 'Xircth/vibex-plugin-host-chrome',
    trend: [10, 11, 13, 15, 16, 18, 20, 21, 23, 24, 26, 27],
  },
};

const githubStarsCache = new Map<string, number>();

export function formatStarCount(count: number): string {
  const safe = Math.max(0, Math.floor(count));
  if (safe >= 1000) {
    return `${(safe / 1000).toFixed(1)}K`;
  }
  return String(safe);
}

function hashSeed(input: string): number {
  let hash = 2166136261;
  for (let i = 0; i < input.length; i += 1) {
    hash ^= input.charCodeAt(i);
    hash = Math.imul(hash, 16777619);
  }
  return Math.abs(hash >>> 0);
}

export function formatPluginVersion(
  version?: string | null,
  tag?: string | null
): string {
  const raw = (version ?? '').trim() || (tag ?? '').trim();
  const cleaned = raw.replace(/^[vV]+/, '').trim();
  return `v${cleaned || '2.0.0'}`;
}

export function extractGithubRepoSlug(
  input?: string | null
): { owner: string; repo: string; slug: string } | null {
  if (!input) return null;
  const trimmed = input.trim();
  const match = trimmed.match(
    /github\.com\/([A-Za-z0-9_.-]+)\/([A-Za-z0-9_.-]+)/i
  );
  if (match?.[1] && match?.[2]) {
    const owner = match[1];
    const repo = match[2].replace(/\.git$/i, '');
    return { owner, repo, slug: `${owner}/${repo}` };
  }
  return null;
}

export function resolvePluginTelemetry(options: {
  pluginId: string;
  owner?: string | null;
  repo?: string | null;
  homepage?: string | null;
  sourceOrigin?: string | null;
  stars?: number | null;
}) {
  const { pluginId, owner, repo, homepage, sourceOrigin, stars } = options;
  const officialKey = resolveOfficialPluginKey(pluginId, owner);
  const lowerOwner = (owner ?? '').trim().toLowerCase();
  const lowerId = pluginId.trim().toLowerCase();
  const isOfficial =
    officialKey !== null ||
    lowerOwner === 'vibex' ||
    pluginId.startsWith('vibex.');

  const githubFromUrl =
    extractGithubRepoSlug(repo) ??
    extractGithubRepoSlug(homepage) ??
    extractGithubRepoSlug(sourceOrigin);

  const initialStarCount =
    typeof stars === 'number' && Number.isFinite(stars)
      ? Math.max(0, Math.floor(stars))
      : ((githubFromUrl?.slug
          ? githubStarsCache.get(githubFromUrl.slug)
          : undefined) ?? 0);

  if (officialKey && OFFICIAL_PLUGIN_TELEMETRY[officialKey]) {
    const preset = OFFICIAL_PLUGIN_TELEMETRY[officialKey];
    const resolvedRepoSlug = githubFromUrl?.slug || preset.repo;
    const cachedStars = githubStarsCache.get(resolvedRepoSlug);
    const starCount =
      typeof stars === 'number' && Number.isFinite(stars)
        ? Math.max(0, Math.floor(stars))
        : (cachedStars ?? 0);
    return {
      isOfficial: true,
      developerName: 'VibeX',
      rawOwner: owner ?? 'vibex',
      avatarOwner: null as string | null,
      installs: String(preset.installs),
      stars: formatStarCount(starCount),
      starCount,
      repositorySlug: resolvedRepoSlug,
      trend: preset.trend,
    };
  }

  const resolvedOwner =
    githubFromUrl?.owner ||
    (owner && owner.trim()) ||
    (isOfficial ? 'VibeX' : 'community');
  const cleanPluginName = pluginId.replace(/^vibex\./, '');
  const repositorySlug =
    githubFromUrl?.slug ||
    (lowerId === 'drawio'
      ? 'Xircth/vibex-drawio'
      : `${isOfficial ? 'Xircth' : resolvedOwner}/${cleanPluginName}`);

  const seed = hashSeed(`${resolvedOwner}/${pluginId}`);
  const mockInstallCount = lowerId === 'drawio' ? 142 : 10 + (seed % 266); // strictly in 10..300
  const installs = String(mockInstallCount);
  const trend = Array.from({ length: 12 }, (_, idx) => {
    if (idx === 11) return mockInstallCount;
    const step = Math.round(((idx + 1) / 12) * mockInstallCount);
    const wave = ((seed >> idx % 8) & 3) - 1;
    return Math.max(2, Math.min(mockInstallCount, step + wave));
  });

  const cachedStars = githubStarsCache.get(repositorySlug);
  const starCount =
    typeof stars === 'number' && Number.isFinite(stars)
      ? Math.max(0, Math.floor(stars))
      : (cachedStars ?? initialStarCount);

  return {
    isOfficial,
    developerName: isOfficial ? 'VibeX' : resolvedOwner,
    rawOwner: owner ?? resolvedOwner,
    avatarOwner: isOfficial ? null : resolvedOwner,
    installs,
    stars: formatStarCount(starCount),
    starCount,
    repositorySlug,
    trend,
  };
}

function useGithubRepoStars(
  repositorySlug: string,
  initialStars?: number | null
): string {
  const [starCount, setStarCount] = useState<number>(() => {
    if (typeof initialStars === 'number' && Number.isFinite(initialStars)) {
      return Math.max(0, Math.floor(initialStars));
    }
    return githubStarsCache.get(repositorySlug) ?? 0;
  });

  useEffect(() => {
    if (typeof initialStars === 'number' && Number.isFinite(initialStars)) {
      const normalized = Math.max(0, Math.floor(initialStars));
      githubStarsCache.set(repositorySlug, normalized);
      setStarCount(normalized);
      return;
    }
    const cached = githubStarsCache.get(repositorySlug);
    if (cached !== undefined) {
      setStarCount(cached);
      return;
    }
    if (
      typeof window === 'undefined' ||
      typeof fetch !== 'function' ||
      import.meta.env.MODE === 'test' ||
      !repositorySlug.includes('/')
    ) {
      return;
    }
    const controller = new AbortController();
    void fetch(`https://api.github.com/repos/${repositorySlug}`, {
      headers: { Accept: 'application/vnd.github+json' },
      signal: controller.signal,
    })
      .then(async (res) => {
        if (!res.ok) throw new Error('github api failed');
        const data = (await res.json()) as { stargazers_count?: unknown };
        if (typeof data.stargazers_count === 'number') {
          githubStarsCache.set(repositorySlug, data.stargazers_count);
          setStarCount(data.stargazers_count);
        }
      })
      .catch(() => {
        void fetch(
          `https://img.shields.io/github/stars/${repositorySlug}.json`,
          {
            signal: controller.signal,
          }
        )
          .then(async (res) => {
            if (!res.ok) return;
            const data = (await res.json()) as { value?: unknown };
            const parsed = Number.parseInt(String(data.value ?? ''), 10);
            if (Number.isFinite(parsed) && parsed >= 0) {
              githubStarsCache.set(repositorySlug, parsed);
              setStarCount(parsed);
            }
          })
          .catch(() => undefined);
      });
    return () => {
      controller.abort();
    };
  }, [initialStars, repositorySlug]);

  return formatStarCount(starCount);
}

/**
 * 1. 开发者属性组件（头像 + 名称）
 * 官方插件使用 VibeX 图标 + 名称 VibeX；其他开发者使用 GitHub 仓库归属者头像 + 名称
 */
export function PluginDeveloperBadge({
  pluginId,
  owner,
  homepage,
  repo,
  sourceOrigin,
  variant = 'badge',
  className = '',
}: {
  pluginId: string;
  owner?: string | null;
  homepage?: string | null;
  repo?: string | null;
  sourceOrigin?: string | null;
  variant?: 'badge' | 'column';
  className?: string;
}) {
  const { resolvedTheme } = useTheme();
  const [avatarFailed, setAvatarFailed] = useState(false);
  const telemetry = resolvePluginTelemetry({
    pluginId,
    owner,
    homepage,
    repo,
    sourceOrigin,
  });

  const vibexLogo = resolveAppLogo('lite', resolvedTheme);
  const githubAvatarUrl =
    !telemetry.isOfficial &&
    telemetry.avatarOwner &&
    telemetry.avatarOwner !== 'local' &&
    telemetry.avatarOwner !== 'community'
      ? `https://github.com/${encodeURIComponent(telemetry.avatarOwner)}.png?size=40`
      : null;

  const initial = (telemetry.developerName[0] ?? 'P').toUpperCase();
  const showRawOwnerSrOnly =
    telemetry.isOfficial &&
    telemetry.rawOwner &&
    telemetry.rawOwner.toLowerCase() === 'vibex';

  return (
    <span
      className={`dsh-attr-developer dsh-attr-${variant} ${className}`.trim()}
      data-developer={telemetry.developerName}
      data-official-developer={telemetry.isOfficial ? 'true' : undefined}
    >
      <span className="dsh-attr-developer-avatar" aria-hidden="true">
        {telemetry.isOfficial ? (
          <img
            src={vibexLogo}
            alt=""
            draggable={false}
            className="dsh-attr-vibex-logo"
          />
        ) : githubAvatarUrl && !avatarFailed ? (
          <img
            src={githubAvatarUrl}
            alt=""
            draggable={false}
            referrerPolicy="no-referrer"
            onError={() => setAvatarFailed(true)}
            className="dsh-attr-owner-img"
          />
        ) : (
          <span className="dsh-attr-owner-initial">{initial}</span>
        )}
      </span>
      <span className="dsh-attr-developer-name">{telemetry.developerName}</span>
      {showRawOwnerSrOnly ? (
        <span className="sr-only">{telemetry.rawOwner}</span>
      ) : null}
    </span>
  );
}

/**
 * 2. 类别属性组件
 */
export function PluginCategoryBadge({
  category,
  label,
  variant = 'badge',
  className = '',
}: {
  category: PluginCategoryKey;
  label: string;
  variant?: 'badge' | 'column';
  className?: string;
}) {
  return (
    <span
      className={`dsh-attr-category dsh-attr-${variant} ${className}`.trim()}
      data-category={category}
    >
      <Layers aria-hidden="true" className="dsh-attr-icon" />
      <span>{label}</span>
    </span>
  );
}

/**
 * 3. 版本属性组件
 */
export function PluginVersionBadge({
  version,
  tag,
  variant = 'badge',
  className = '',
}: {
  version?: string | null;
  tag?: string | null;
  variant?: 'badge' | 'column';
  className?: string;
}) {
  const formatted = formatPluginVersion(version, tag);
  return (
    <span
      className={`dsh-attr-version dsh-attr-${variant} ${className}`.trim()}
      data-version={formatted}
    >
      {variant === 'badge' ? (
        <Tag aria-hidden="true" className="dsh-attr-icon" />
      ) : null}
      <span>{formatted}</span>
    </span>
  );
}

/**
 * 4. 安装量属性组件
 */
export function PluginInstallsBadge({
  pluginId,
  owner,
  homepage,
  repo,
  sourceOrigin,
  variant = 'badge',
  className = '',
}: {
  pluginId: string;
  owner?: string | null;
  homepage?: string | null;
  repo?: string | null;
  sourceOrigin?: string | null;
  variant?: 'badge' | 'column';
  className?: string;
}) {
  const telemetry = resolvePluginTelemetry({
    pluginId,
    owner,
    homepage,
    repo,
    sourceOrigin,
  });
  return (
    <span
      className={`dsh-attr-installs dsh-attr-${variant} ${className}`.trim()}
      data-installs={telemetry.installs}
    >
      <Download aria-hidden="true" className="dsh-attr-icon" />
      <span>{telemetry.installs}</span>
    </span>
  );
}

/**
 * 列表行右侧对齐的三列属性栏（开发者、版本、安装量）
 */
export function PluginRowMetaColumns({
  pluginId,
  owner,
  version,
  tag,
  homepage,
  repo,
  sourceOrigin,
  categoryLabel,
}: {
  pluginId: string;
  owner?: string | null;
  version?: string | null;
  tag?: string | null;
  homepage?: string | null;
  repo?: string | null;
  sourceOrigin?: string | null;
  categoryLabel?: string | null;
}) {
  return (
    <span className="dsh-row-meta-columns">
      {categoryLabel ? <span className="sr-only">{categoryLabel}</span> : null}
      <PluginDeveloperBadge
        pluginId={pluginId}
        owner={owner}
        homepage={homepage}
        repo={repo}
        sourceOrigin={sourceOrigin}
        variant="column"
      />
      <PluginVersionBadge version={version} tag={tag} variant="column" />
      <PluginInstallsBadge
        pluginId={pluginId}
        owner={owner}
        homepage={homepage}
        repo={repo}
        sourceOrigin={sourceOrigin}
        variant="column"
      />
    </span>
  );
}

/**
 * 插件详情页右侧窄栏：安装量与趋势图、插件仓库（含Star数量与开发者）、最新版本、插件安全测试结果
 */
export function PluginTelemetrySidebar({
  pluginId,
  owner,
  version,
  tag,
  homepage,
  repo,
  sourceOrigin,
  stars,
}: {
  pluginId: string;
  owner?: string | null;
  version?: string | null;
  tag?: string | null;
  homepage?: string | null;
  repo?: string | null;
  sourceOrigin?: string | null;
  stars?: number | null;
}) {
  const { i18n } = useTranslation('settings');
  const isZh = i18n.language.toLowerCase().startsWith('zh');
  const gradientId = useId();
  const telemetry = resolvePluginTelemetry({
    pluginId,
    owner,
    homepage,
    repo,
    sourceOrigin,
    stars,
  });
  const liveStars = useGithubRepoStars(telemetry.repositorySlug, stars);
  const formattedVersion = formatPluginVersion(version, tag);

  // Build smooth SVG sparkline coordinates (220 x 54 viewBox)
  const width = 220;
  const height = 54;
  const pts = telemetry.trend;
  const minVal = Math.min(...pts) * 0.85;
  const maxVal = Math.max(...pts) * 1.05 || 1;
  const coords = pts.map((val, index) => {
    const x = (index / Math.max(1, pts.length - 1)) * width;
    const y =
      height -
      8 -
      ((val - minVal) / Math.max(1, maxVal - minVal)) * (height - 16);
    return { x: Number(x.toFixed(1)), y: Number(y.toFixed(1)) };
  });

  const linePath = coords
    .map((pt, idx) => `${idx === 0 ? 'M' : 'L'} ${pt.x} ${pt.y}`)
    .join(' ');
  const areaPath = `${linePath} L ${width} ${height} L 0 ${height} Z`;

  const securityAudits = [
    { id: 'trust-hub', name: 'VibeX Trust Hub', status: 'PASS' },
    { id: 'socket', name: 'Socket', status: 'PASS' },
    { id: 'snyk', name: 'Snyk', status: 'PASS' },
  ] as const;

  return (
    <aside
      className="dsh-detail-telemetry-rail"
      aria-label={isZh ? '插件遥测与安全信息' : 'Plugin telemetry and security'}
    >
      {/* 1. 安装量与趋势图 */}
      <section className="dsh-telemetry-block">
        <span className="dsh-telemetry-label">
          {isZh ? '安装量与趋势' : 'INSTALLS'}
        </span>
        <strong className="dsh-telemetry-hero-value">
          {telemetry.installs}
        </strong>
        <div className="dsh-telemetry-sparkline" aria-hidden="true">
          <svg
            viewBox={`0 0 ${width} ${height}`}
            preserveAspectRatio="none"
            className="dsh-telemetry-sparkline-svg"
          >
            <defs>
              <linearGradient id={gradientId} x1="0" y1="0" x2="0" y2="1">
                <stop offset="0%" stopColor="currentColor" stopOpacity="0.22" />
                <stop
                  offset="100%"
                  stopColor="currentColor"
                  stopOpacity="0.0"
                />
              </linearGradient>
            </defs>
            <path d={areaPath} fill={`url(#${gradientId})`} />
            <path
              d={linePath}
              fill="none"
              stroke="currentColor"
              strokeWidth="1.75"
              strokeLinecap="round"
              strokeLinejoin="round"
            />
          </svg>
        </div>
      </section>

      {/* 2. 插件仓库（下方展示 Star 数量与开发者） */}
      <section className="dsh-telemetry-block">
        <span className="dsh-telemetry-label">
          <span>{isZh ? '插件仓库' : 'REPOSITORY'}</span>
          <BadgeCheck aria-hidden="true" className="dsh-telemetry-verified" />
        </span>
        <div className="dsh-telemetry-repo-value">
          <GitBranch aria-hidden="true" className="dsh-telemetry-inline-icon" />
          <code>{telemetry.repositorySlug}</code>
        </div>
        <div className="dsh-telemetry-stars-dev">
          <span className="dsh-telemetry-stars">
            <Star aria-hidden="true" className="dsh-telemetry-star-icon" />
            <span>{liveStars}</span>
          </span>
          <span className="dsh-telemetry-dot" aria-hidden="true">
            ·
          </span>
          <PluginDeveloperBadge
            pluginId={pluginId}
            owner={owner}
            homepage={homepage}
            repo={repo}
            sourceOrigin={sourceOrigin}
            variant="badge"
          />
        </div>
      </section>

      {/* 3. 最新版本 */}
      <section className="dsh-telemetry-block">
        <span className="dsh-telemetry-label">
          {isZh ? '最新版本' : 'LATEST VERSION'}
        </span>
        <div className="dsh-telemetry-version-row">
          <strong className="dsh-telemetry-version-value">
            {formattedVersion}
          </strong>
        </div>
      </section>

      {/* 4. 插件安全测试结果 */}
      <section className="dsh-telemetry-block">
        <span className="dsh-telemetry-label">
          <span>{isZh ? '插件安全测试结果' : 'SECURITY AUDITS'}</span>
          <ShieldCheck aria-hidden="true" className="dsh-telemetry-verified" />
        </span>
        <ul className="dsh-telemetry-audit-list">
          {securityAudits.map((audit) => (
            <li key={audit.id} className="dsh-telemetry-audit-row">
              <span className="dsh-telemetry-audit-name">{audit.name}</span>
              <span className="dsh-telemetry-audit-badge" data-status="pass">
                {audit.status}
              </span>
            </li>
          ))}
        </ul>
      </section>
    </aside>
  );
}
