import {
  Cloud,
  FileText,
  FlaskConical,
  FolderCode,
  Globe,
  Layers,
  LayoutGrid,
  Link,
  MessageSquareWarning,
  Puzzle,
  Plug,
  Users,
  Workflow,
} from 'lucide-react';
import type { LucideIcon } from 'lucide-react';
import { useState } from 'react';

import { CONTRIBUTION_ICONS } from '@/components/plugins/contributionIcon';
import type { CatalogListing } from '@/lib/api/plugins';

import {
  listingPackageIds,
  type MarketplaceListingIdentity,
} from './marketplaceListing';
import {
  officialPluginI18nKey,
  type OfficialPluginI18nKey,
} from './officialPlugins';

export const OFFICIAL_GLYPHS: Record<OfficialPluginI18nKey, LucideIcon> = {
  office: FileText,
  workflowCreator: Workflow,
  sessionEnhance: MessageSquareWarning,
  multiAgent: Users,
  pluginDevelopment: FolderCode,
  hostChrome: Puzzle,
  hostSurface: Layers,
  providerImport: Plug,
  providerSwitch: LayoutGrid,
  remoteSsh: Cloud,
  science: FlaskConical,
  browser: Globe,
  openConnector: Link,
};

const MARKETPLACE_ICON_HOST = 'vibex.xforever.xin';
const INITIALS_PALETTE = [
  'color-mix(in srgb, var(--accent) 18%, var(--surface-raised))',
  'color-mix(in srgb, var(--text-primary) 18%, var(--surface-raised))',
  'color-mix(in srgb, hsl(var(--success)) 18%, var(--surface-raised))',
  'color-mix(in srgb, hsl(var(--warning)) 18%, var(--surface-raised))',
] as const;

export function officialGlyphForListing(
  listing: MarketplaceListingIdentity
): OfficialPluginI18nKey | null {
  for (const id of listingPackageIds(listing)) {
    const key = officialPluginI18nKey(id);
    if (key) return key;
  }
  return null;
}

export function allowedMarketplaceIconUrl(value: string): string | null {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    return null;
  }
  if (url.protocol !== 'https:') return null;
  if (url.username || url.password) return null;
  if (url.port !== '' && url.port !== '443') return null;
  if (url.hostname !== MARKETPLACE_ICON_HOST) return null;
  const path = url.pathname.toLowerCase();
  if (path.endsWith('.svg') || path.endsWith('.svgz')) return null;
  return url.href;
}

function fnv1a32(input: string): number {
  let hash = 2166136261;
  for (let i = 0; i < input.length; i++) {
    hash ^= input.charCodeAt(i);
    hash = Math.imul(hash, 16777619);
  }
  return hash >>> 0;
}

export function marketplaceLogoInitials(displayName: string): string {
  const cjk = displayName.match(/[\u3400-\u9fff]/);
  if (cjk) return cjk[0];
  const alnum = displayName.match(/[A-Za-z0-9]/g);
  if (alnum && alnum.length >= 2) {
    return `${alnum[0]}${alnum[1]}`.toUpperCase();
  }
  if (alnum && alnum.length === 1) return alnum[0].toUpperCase();
  return '?';
}

function contributionGlyph(icon: string | null | undefined): LucideIcon | null {
  if (!icon || !(icon in CONTRIBUTION_ICONS)) return null;
  return CONTRIBUTION_ICONS[icon];
}

export function PluginProductIcon({ pluginId }: { pluginId?: string }) {
  const official = pluginId ? officialPluginI18nKey(pluginId) : null;
  const Glyph = (official && OFFICIAL_GLYPHS[official]) || Puzzle;

  return (
    <span
      className="product-plugin-icon"
      data-official={official ?? undefined}
      aria-hidden="true"
    >
      <Glyph />
    </span>
  );
}

export function PluginMarketplaceLogo({
  listing,
  displayName,
}: {
  listing: CatalogListing;
  displayName: string;
}) {
  const official = officialGlyphForListing(listing);
  const OfficialGlyph = official ? OFFICIAL_GLYPHS[official] : null;
  const CatalogGlyph = contributionGlyph(listing.icon);
  const bitmap = listing.icon ? allowedMarketplaceIconUrl(listing.icon) : null;
  const [bitmapFailed, setBitmapFailed] = useState(false);
  const initials = marketplaceLogoInitials(displayName);
  const fill =
    INITIALS_PALETTE[
      fnv1a32(`${listing.owner}/${listing.pluginName}`) % INITIALS_PALETTE.length
    ];

  if (OfficialGlyph) {
    return (
      <span
        className="product-plugin-card-logo"
        data-official={official ?? undefined}
        aria-hidden="true"
      >
        <OfficialGlyph />
      </span>
    );
  }

  if (CatalogGlyph) {
    return (
      <span className="product-plugin-card-logo" aria-hidden="true">
        <CatalogGlyph />
      </span>
    );
  }

  if (bitmap && !bitmapFailed) {
    return (
      <span className="product-plugin-card-logo" aria-hidden="true">
        <img
          alt=""
          src={bitmap}
          referrerPolicy="no-referrer"
          onError={() => setBitmapFailed(true)}
        />
      </span>
    );
  }

  return (
    <span
      className="product-plugin-card-logo"
      aria-hidden="true"
      style={{ background: fill }}
    >
      <span className="product-plugin-card-initials">{initials}</span>
    </span>
  );
}
