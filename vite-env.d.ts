/// <reference types="vite/client" />

interface ViteTypeOptions {
  strictImportMetaEnv: unknown;
}

interface ImportMetaEnv {
  readonly VITE_PUBLIC_MAPBOX_TOKEN: string;
  readonly VITE_GEOREF_SUGGESTION_API_URL?: string;
  readonly VITE_GEOREF_SUGGESTION_API_KEY?: string;
}

interface ImportMeta {
  readonly env: ImportMetaEnv;
}
