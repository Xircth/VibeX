/// <reference types="vite/client" />

declare const __APP_VERSION__: string;

interface ImportMetaEnv {
  readonly DIMO_SITE_URL?: string;
  readonly DIMO_MARKETPLACE_URL?: string;
  readonly DIMO_ONBOARDING_VIDEO_BASE_URL?: string;
  readonly VITE_DIMO_SITE_URL?: string;
  readonly VITE_DIMO_MARKETPLACE_URL?: string;
  readonly VITE_DIMO_ONBOARDING_VIDEO_BASE_URL?: string;
  readonly VITE_PARENT_ORIGIN?: string;
}

interface ImportMeta {
  readonly env: ImportMetaEnv;
}
