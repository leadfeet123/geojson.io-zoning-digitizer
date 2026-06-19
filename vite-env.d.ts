/// <reference types="vite/client" />

interface ViteTypeOptions {
  strictImportMetaEnv: unknown;
}

interface ImportMetaEnv {
  readonly VITE_PUBLIC_MAPBOX_TOKEN: string;
  readonly VITE_GEOREF_SUGGESTION_PROXY_URL?: string;
}

interface ImportMeta {
  readonly env: ImportMetaEnv;
}
