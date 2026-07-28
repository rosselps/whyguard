/// <reference types="vite/client" />

interface ImportMetaEnv {
  readonly VITE_WHYGUARD_API_URL?: string;
  /** Bearer token for an API that requires one. Inlined into the bundle — see `api.ts`. */
  readonly VITE_WHYGUARD_API_TOKEN?: string;
}

interface ImportMeta {
  readonly env: ImportMetaEnv;
}
