/// <reference types="vite/client" />

declare const __APP_VERSION__: string;

interface ImportMetaEnv {
  readonly VIBEX_SITE_URL?: string;
  readonly VIBEX_MARKETPLACE_URL?: string;
  readonly VITE_VIBEX_SITE_URL?: string;
  readonly VITE_VIBEX_MARKETPLACE_URL?: string;
  readonly VITE_PARENT_ORIGIN?: string;
}

interface ImportMeta {
  readonly env: ImportMetaEnv;
}

