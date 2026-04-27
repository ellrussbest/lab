/**
 * build.config.ts
 *
 * Declarative build manifest consumed by rollup.build.ts.
 *
 * Switch BUILD_MODE (env var or `mode` field below) to change behaviour:
 *
 *   library   → Option A: Safer Library Builder
 *   graph     → Option B: Smart Build Graph System
 *   monorepo  → Option C: Hybrid Monorepo Compiler
 *
 * You can also run:
 *   BUILD_MODE=graph rollup -c rollup.build.ts
 */

import type { BuildConfig } from './rollup-example-2';

// ─────────────────────────────────────────────────────────────────────────────
// Shared dependency policy table
//
// "bundle"   → inlined into output (safe deterministic libs)
// "external" → consumer must install; never inlined
// "peer"     → external + conflict-checked against consumer's installed version
// ─────────────────────────────────────────────────────────────────────────────

const sharedGlobalDeps: BuildConfig['globalDeps'] = {
  // Safe to bundle — small, deterministic, no singleton requirement
  'zod': 'bundle',
  'date-fns': 'bundle',
  'uuid': 'bundle',

  // Ecosystem singletons — must be external
  'react': 'peer',
  'react-dom': 'peer',
  'next': 'peer',

  // Shared runtime libs — external but not peer-checked
  'lodash': 'external',
  'axios': 'external',
};

// ─────────────────────────────────────────────────────────────────────────────
// Option A — Safer Library Builder
// ─────────────────────────────────────────────────────────────────────────────
//
// • Filesystem discovery is allowed as fallback
// • Semver conflicts are warnings, not errors
// • All deps default to external unless overridden
//
// export default {
//   mode: 'library',
//   globalDeps: sharedGlobalDeps,
// } satisfies BuildConfig;

// ─────────────────────────────────────────────────────────────────────────────
// Option B — Smart Build Graph System
// ─────────────────────────────────────────────────────────────────────────────
//
// • Entries MUST be declared — filesystem discovery is disabled
// • Semver conflicts abort the build
// • Each entry can override per-dep policy
// • Unlisted deps default to "external"
//
// export default {
//   mode: 'graph',
//   strictVersions: true,
//   globalDeps: sharedGlobalDeps,
//   entries: [
//     {
//       input: 'src/core/index.ts',
//       defaultPolicy: 'external',
//       deps: {
//         'zod': 'bundle',       // override: inline zod here
//         'react': 'peer',
//       },
//     },
//     {
//       input: 'src/utils/index.ts',
//       defaultPolicy: 'bundle', // bundle everything not explicitly listed
//       deps: {
//         'react': 'peer',       // but react stays external
//       },
//     },
//     {
//       input: 'src/cli/index.ts',
//       types: false,            // no .d.ts for CLI entry
//       defaultPolicy: 'external',
//     },
//   ],
// } satisfies BuildConfig;

// ─────────────────────────────────────────────────────────────────────────────
// Option C — Hybrid Monorepo Compiler
// ─────────────────────────────────────────────────────────────────────────────
//
// • All entries explicitly declared with per-package resolution strategy
// • Strict semver — any range incompatibility aborts build
// • Each package can have its own tsconfig
// • Supports mixed bundling strategies across workspace packages
//
const config: BuildConfig = {
  mode: 'monorepo',
  strictVersions: true,

  // Global policy baseline — applied before per-entry overrides
  globalDeps: sharedGlobalDeps,

  entries: [
    // ── packages/core ─────────────────────────────────────────────────────
    {
      input: 'packages/core/src/index.ts',
      tsconfig: 'packages/core/tsconfig.json',
      defaultPolicy: 'external',
      deps: {
        'zod': 'bundle',      // core inlines its own schema validator
        'react': 'peer',
      },
    },

    // ── packages/ui ───────────────────────────────────────────────────────
    {
      input: 'packages/ui/src/index.ts',
      tsconfig: 'packages/ui/tsconfig.json',
      defaultPolicy: 'external',
      deps: {
        'react': 'peer',
        'react-dom': 'peer',
        // clsx is small + deterministic → safe to bundle
        'clsx': 'bundle',
      },
    },

    // ── packages/utils ────────────────────────────────────────────────────
    {
      input: 'packages/utils/src/index.ts',
      tsconfig: 'packages/utils/tsconfig.json',
      // utils bundles everything by default; only singletons stay external
      defaultPolicy: 'bundle',
      deps: {
        'react': 'peer',
      },
    },

    // ── packages/cli ──────────────────────────────────────────────────────
    {
      input: 'packages/cli/src/index.ts',
      tsconfig: 'packages/cli/tsconfig.json',
      types: false,             // CLIs don't ship type declarations
      defaultPolicy: 'bundle',  // bundle everything for a standalone binary
      deps: {
        // Nothing external — it's a self-contained executable
      },
    },
  ],
};

export default config;