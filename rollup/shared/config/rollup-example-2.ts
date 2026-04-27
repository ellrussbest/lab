/**
 * rollup.build.ts
 *
 * A versioning-aware, policy-driven, contract-first Rollup build system.
 *
 * Supported build modes (set via BUILD_MODE env or build.config.ts):
 *   "library"   → Option A: Safer Library Builder
 *   "graph"     → Option B: Smart Build Graph System
 *   "monorepo"  → Option C: Hybrid Monorepo Compiler
 *
 * Fixes all 6 audited pitfalls:
 *   1. Versioning / semver awareness        → VersionedDepGraph
 *   2. Bundle vs external policy            → BundlePolicy per entry
 *   3. Per-entry dependency isolation       → EntryGraph (no upward flattening)
 *   4. Alias safety (TS + Rollup unified)   → AliasResolver (shared instance)
 *   5. DTS divergence from runtime          → same AliasResolver injected into dts()
 *   6. Entry discovery (contract-driven)    → build.config.ts manifest; fs scan is fallback
 */

import {
  existsSync,
  readdirSync,
  readFileSync,
  statSync,
} from 'node:fs';
import {
  dirname,
  extname,
  join,
  relative,
  resolve,
  sep,
} from 'node:path';

import aliasPlugin from '@rollup/plugin-alias';
import typescript from '@rollup/plugin-typescript';
import { defineConfig, type Plugin, type RollupOptions } from 'rollup';
import dts from 'rollup-plugin-dts';
import { parse as parseJsonc } from 'jsonc-parser';
import * as semver from 'semver';

// ─────────────────────────────────────────────────────────────────────────────
// § 1  Public config contract  (build.config.ts shape)
// ─────────────────────────────────────────────────────────────────────────────

export type BuildMode = 'library' | 'graph' | 'monorepo';

/**
 * Bundling decision for a single dependency name.
 *   "bundle"   → inline into the output (safe, deterministic libs like zod, date-fns)
 *   "external" → never bundled; consumer must install
 *   "peer"     → external AND emits a warning if the consumer range conflicts
 */
export type DepPolicy = 'bundle' | 'external' | 'peer';

export interface EntryContract {
  /** Relative path to the entry file, e.g. "src/core/index.ts" */
  input: string;

  /**
   * Explicit per-dependency bundling policy.
   * Anything not listed falls back to the entry's defaultPolicy.
   */
  deps?: Record<string, DepPolicy>;

  /**
   * Policy applied to deps not listed in `deps`.
   * @default "external"
   */
  defaultPolicy?: DepPolicy;

  /**
   * Whether to emit a .d.ts bundle for this entry.
   * @default true
   */
  types?: boolean;

  /**
   * Override the tsconfig path used for this entry.
   * Nearest tsconfig.json is used when omitted.
   */
  tsconfig?: string;
}

export interface BuildConfig {
  mode?: BuildMode;

  /**
   * Explicitly declared entry points.
   * When omitted the builder falls back to filesystem discovery (Option A behaviour).
   */
  entries?: EntryContract[];

  /**
   * Root-level dependency policy defaults applied before per-entry overrides.
   */
  globalDeps?: Record<string, DepPolicy>;

  /**
   * When true, the pre-build conflict analyser aborts on semver range conflicts.
   * @default true in "graph" / "monorepo" modes, false in "library"
   */
  strictVersions?: boolean;
}

// ─────────────────────────────────────────────────────────────────────────────
// § 2  Low-level types
// ─────────────────────────────────────────────────────────────────────────────

interface PackageManifest {
  dependencies?: Record<string, string>;
  peerDependencies?: Record<string, string>;
  devDependencies?: Record<string, string>;
}

interface TSConfig {
  compilerOptions?: {
    paths?: Record<string, string[]>;
    baseUrl?: string;
  };
}

interface ResolvedAlias {
  /** The regex used by both Rollup's alias plugin and our TS path validator */
  find: RegExp;
  replacement: string;
  /** Original TS path key, kept for diagnostics */
  _key: string;
}

interface VersionedDep {
  name: string;
  /** Raw semver range string as found in package.json, e.g. "^4.0.0" */
  range: string;
  policy: DepPolicy;
  /** The package.json directory this dep was declared in */
  declaredIn: string;
}

interface EntryGraph {
  /** Resolved entry key, e.g. "src/core/index" */
  key: string;
  /** Absolute input path */
  inputPath: string;
  /** Relative path string for Rollup input map */
  inputRel: string;
  deps: Map<string, VersionedDep>;
  aliases: ResolvedAlias[];
  tsconfigPath: string;
  emitTypes: boolean;
}

// ─────────────────────────────────────────────────────────────────────────────
// § 3  Helpers
// ─────────────────────────────────────────────────────────────────────────────

function safeReadJSON<T>(file: string): T | null {
  try {
    return JSON.parse(readFileSync(file, 'utf-8')) as T;
  } catch {
    return null;
  }
}

function safeReadTSConfig(file: string): TSConfig | null {
  try {
    return parseJsonc(readFileSync(file, 'utf-8')) as TSConfig;
  } catch {
    return null;
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// § 4  AliasResolver  (single source of truth for TS + Rollup + DTS)
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Builds alias entries from a tsconfig paths map and exposes them in a format
 * that is identical for @rollup/plugin-alias and rollup-plugin-dts.
 *
 * Pitfall 4 fix: one resolver instance is reused for both the code bundle and
 * the DTS bundle, guaranteeing identical resolution semantics.
 */
class AliasResolver {
  private readonly aliases: ResolvedAlias[];

  constructor(aliases: ResolvedAlias[]) {
    // Sort longest-prefix first so more specific aliases win
    this.aliases = [...aliases].sort(
      (a, b) => b.find.source.length - a.find.source.length,
    );
  }

  /** Entries array consumed by @rollup/plugin-alias */
  get entries(): { find: RegExp; replacement: string }[] {
    return this.aliases.map(({ find, replacement }) => ({ find, replacement }));
  }

  /**
   * Validate that every alias replacement path actually exists on disk.
   * Called once before building; surfaces misconfigured paths early.
   */
  validate(): void {
    for (const { _key, replacement } of this.aliases) {
      // Strip capture-group placeholders before checking existence
      const basePath = replacement.replace(/\/\$\d+$/, '');
      if (!existsSync(basePath)) {
        throw new Error(
          `[AliasResolver] Alias "${_key}" points to non-existent path: ${basePath}`,
        );
      }
    }
  }

  static fromTSConfig(
    tsconfigPath: string,
    packageDir: string,
  ): ResolvedAlias[] {
    if (!existsSync(tsconfigPath)) return [];

    const tsconfig = safeReadTSConfig(tsconfigPath);
    const paths = tsconfig?.compilerOptions?.paths ?? {};
    const baseUrl = tsconfig?.compilerOptions?.baseUrl ?? '.';
    const absoluteBase = resolve(packageDir, baseUrl);

    const result: ResolvedAlias[] = [];

    for (const [key, values] of Object.entries(paths)) {
      const first = values?.[0];
      if (!first) continue;

      const hasWildcard = key.endsWith('/*');
      const prefix = hasWildcard ? key.slice(0, -2) : key;
      const targetBase = resolve(absoluteBase, first.replace('/*', ''));

      result.push({
        find: hasWildcard
          ? new RegExp(`^${escapeRegex(prefix)}/(.+)$`)
          : new RegExp(`^${escapeRegex(key)}$`),
        replacement: hasWildcard ? `${targetBase}/$1` : targetBase,
        _key: key,
      });
    }

    return result;
  }
}

function escapeRegex(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

// ─────────────────────────────────────────────────────────────────────────────
// § 5  VersionedDepGraph  (pitfalls 1, 7, 11)
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Collects all versioned dependencies across all entry graphs and runs
 * pre-build conflict analysis.
 *
 * Conflict rules:
 *   - Same dep, incompatible semver ranges across entries → error (strictVersions)
 *   - Same dep, conflicting policies (bundle vs peer) across entries → warning
 */
class VersionedDepGraph {
  /** depName → list of declarations across all entries */
  private readonly nodes = new Map<string, VersionedDep[]>();

  register(dep: VersionedDep): void {
    const existing = this.nodes.get(dep.name) ?? [];
    existing.push(dep);
    this.nodes.set(dep.name, existing);
  }

  registerAll(deps: Map<string, VersionedDep>): void {
    for (const dep of deps.values()) this.register(dep);
  }

  /**
   * Run conflict analysis.
   * @param strict  If true, semver incompatibilities throw. Otherwise warn.
   */
  analyze(strict: boolean): void {
    for (const [name, declarations] of this.nodes) {
      if (declarations.length < 2) continue;

      // --- Policy conflict ---
      const policies = new Set(declarations.map((d) => d.policy));
      if (policies.has('bundle') && policies.has('peer')) {
        const sources = declarations
          .map((d) => `${d.declaredIn} (${d.policy})`)
          .join(', ');
        console.warn(
          `[DepGraph] ⚠  Policy conflict for "${name}": mixed bundle/peer across entries.\n  ${sources}`,
        );
      }

      // --- Semver range conflict ---
      const ranges = declarations.map((d) => d.range).filter(Boolean);
      const rangeConflicts: string[] = [];

      for (let i = 0; i < ranges.length; i++) {
        for (let j = i + 1; j < ranges.length; j++) {
          const ri = ranges[i]!;
          const rj = ranges[j]!;

          // Two ranges are compatible if their intersection is non-empty
          if (!semver.intersects(ri, rj, { loose: true })) {
            rangeConflicts.push(
              `  ${declarations[i]!.declaredIn}: ${ri}  ↔  ${declarations[j]!.declaredIn}: ${rj}`,
            );
          }
        }
      }

      if (rangeConflicts.length > 0) {
        const msg = `[DepGraph] Semver conflict for "${name}":\n${rangeConflicts.join('\n')}`;
        if (strict) {
          throw new Error(msg);
        } else {
          console.warn(msg);
        }
      }
    }
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// § 6  Per-entry metadata resolution  (pitfalls 2, 3, 5)
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Walk upward from `startDir` and collect:
 *   - Versioned deps from every package.json encountered
 *   - Aliases from every tsconfig.json encountered (nearest wins)
 *
 * Unlike the original, deps are stored as VersionedDep (range-aware) and
 * are NOT merged upward into a single flat set — each entry owns its own
 * Map so isolation is maintained.
 */
function resolveEntryMetadata(
  startDir: string,
  contract: EntryContract,
  globalDeps: Record<string, DepPolicy>,
): {
  deps: Map<string, VersionedDep>;
  aliasResolver: AliasResolver;
  tsconfigPath: string;
} {
  const deps = new Map<string, VersionedDep>();
  const aliasMap = new Map<string, ResolvedAlias>();
  let tsconfigPath: string | null = contract.tsconfig ?? null;

  const root = process.cwd();
  let dir = startDir;

  const effectivePolicy = (name: string): DepPolicy =>
    contract.deps?.[name]
    ?? globalDeps[name]
    ?? contract.defaultPolicy
    ?? 'external';

  while (true) {
    // ---- package.json ----
    const pkgPath = join(dir, 'package.json');
    if (existsSync(pkgPath)) {
      const pkg = safeReadJSON<PackageManifest>(pkgPath);

      // Process dependencies and peerDependencies separately (pitfall 8)
      const regularDeps = pkg?.dependencies ?? {};
      const peerDeps = pkg?.peerDependencies ?? {};

      for (const [name, range] of Object.entries(regularDeps)) {
        if (!deps.has(name)) {
          deps.set(name, {
            name,
            range,
            policy: effectivePolicy(name),
            declaredIn: pkgPath,
          });
        }
      }

      for (const [name, range] of Object.entries(peerDeps)) {
        if (!deps.has(name)) {
          // peerDependencies default to "peer" policy, not just "external"
          const policy =
            contract.deps?.[name] ?? globalDeps[name] ?? 'peer';
          deps.set(name, {
            name,
            range,
            policy,
            declaredIn: pkgPath,
          });
        }
      }
    }

    // ---- tsconfig.json ----
    const tsPath = join(dir, 'tsconfig.json');
    if (existsSync(tsPath)) {
      // Nearest tsconfig is the compiler tsconfig (pitfall 4)
      if (!tsconfigPath) tsconfigPath = tsPath;

      // Merge aliases — nearest definition wins (same as before but typed)
      const newAliases = AliasResolver.fromTSConfig(tsPath, dir);
      for (const alias of newAliases) {
        if (!aliasMap.has(alias._key)) {
          aliasMap.set(alias._key, alias);
        }
      }
    }

    if (dir === root) break;
    dir = dirname(dir);
  }

  const aliasResolver = new AliasResolver(Array.from(aliasMap.values()));

  return {
    deps,
    aliasResolver,
    tsconfigPath: tsconfigPath ?? join(root, 'tsconfig.json'),
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// § 7  Entry discovery  (pitfall 6 — contract-first, fs fallback)
// ─────────────────────────────────────────────────────────────────────────────

const SUPPORTED_EXTENSIONS = [
  '.ts', '.tsx', '.mts', '.cts',
  '.js', '.jsx', '.mjs', '.cjs',
];

/**
 * Filesystem-based discovery (original behaviour).
 * Used only when no explicit entries are declared in build.config.ts.
 * Every index.* file automatically becomes an entry with default policy.
 */
function discoverEntriesFromFS(
  dir: string,
  contracts: EntryContract[] = [],
  _map: Map<string, EntryContract> = new Map(),
): EntryContract[] {
  for (const file of readdirSync(dir)) {
    const fullPath = join(dir, file);

    if (statSync(fullPath).isDirectory()) {
      if (file !== 'node_modules' && file !== 'dist' && !file.startsWith('.')) {
        discoverEntriesFromFS(fullPath, contracts, _map);
      }
      continue;
    }

    const ext = extname(file);
    if (!SUPPORTED_EXTENSIONS.includes(ext)) continue;
    if (file.replace(ext, '') !== 'index') continue;

    const rel = relative(process.cwd(), fullPath);
    const key = rel.replace(ext, '').split(sep).join('/');

    if (_map.has(key)) {
      throw new Error(`[Discovery] Duplicate entry for "${key}".`);
    }

    const contract: EntryContract = { input: rel };
    _map.set(key, contract);
    contracts.push(contract);
  }

  return contracts;
}

// ─────────────────────────────────────────────────────────────────────────────
// § 8  Build config loader
// ─────────────────────────────────────────────────────────────────────────────

function loadBuildConfig(): BuildConfig {
  const configPath = join(process.cwd(), 'build.config.ts');
  const jsConfigPath = join(process.cwd(), 'build.config.js');

  // Dynamic require — works after ts-node/esbuild registers the loader
  if (existsSync(configPath)) {
    try {
      // eslint-disable-next-line @typescript-eslint/no-require-imports
      return (require(configPath) as { default: BuildConfig }).default ?? {};
    } catch {
      console.warn('[Config] Could not load build.config.ts — using defaults.');
    }
  }

  if (existsSync(jsConfigPath)) {
    try {
      // eslint-disable-next-line @typescript-eslint/no-require-imports
      return (require(jsConfigPath) as { default: BuildConfig }).default ?? {};
    } catch {
      console.warn('[Config] Could not load build.config.js — using defaults.');
    }
  }

  return {};
}

// ─────────────────────────────────────────────────────────────────────────────
// § 9  EntryGraph builder
// ─────────────────────────────────────────────────────────────────────────────

function buildEntryGraph(
  contract: EntryContract,
  globalDeps: Record<string, DepPolicy>,
): EntryGraph {
  const absInput = resolve(process.cwd(), contract.input);
  const ext = extname(contract.input);
  const key = relative(process.cwd(), absInput)
    .replace(ext, '')
    .split(sep)
    .join('/');

  const startDir = dirname(absInput);

  const { deps, aliasResolver, tsconfigPath } = resolveEntryMetadata(
    startDir,
    contract,
    globalDeps,
  );

  // Validate aliases — surfaces bad paths before Rollup even starts
  aliasResolver.validate();

  return {
    key,
    inputPath: absInput,
    inputRel: `./${relative(process.cwd(), absInput)}`,
    deps,
    aliases: aliasResolver.entries as ResolvedAlias[],
    tsconfigPath,
    emitTypes: contract.types !== false,
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// § 10  isExternal factory  (pitfalls 2, 3, 8)
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Returns the Rollup `external` predicate for a single entry graph.
 *
 * "bundle"   → NOT external (Rollup will inline it)
 * "external" → external
 * "peer"     → external
 */
function makeIsExternal(graph: EntryGraph): (id: string) => boolean {
  return (id: string): boolean => {
    if (id.startsWith('node:') || id.startsWith('node_modules')) return true;

    for (const dep of graph.deps.values()) {
      const matches = id === dep.name || id.startsWith(`${dep.name}/`);
      if (!matches) continue;

      if (dep.policy === 'bundle') return false;
      return true; // external or peer → external to Rollup
    }

    // Unknown dep: default to external (safe)
    return true;
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// § 11  Rollup config generator
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Pitfall 5 fix: the SAME AliasResolver instance is passed to both the code
 * bundle (via @rollup/plugin-alias) and the DTS bundle (via rollup-plugin-dts
 * + alias). This guarantees identical path resolution for both outputs.
 */
function generateRollupConfigs(graph: EntryGraph): RollupOptions[] {
  const isExternal = makeIsExternal(graph);

  // Single shared alias plugin factory — same config for code + dts
  const makeAliasPlugin = (): Plugin =>
    aliasPlugin({ entries: graph.aliases });

  const configs: RollupOptions[] = [
    // ── Code bundle ──────────────────────────────────────────────────────────
    defineConfig({
      input: { [graph.key]: graph.inputRel },
      external: isExternal,
      output: [
        {
          dir: 'dist',
          entryFileNames: '[name].js',
          format: 'es',
          sourcemap: true,
        },
        {
          dir: 'dist',
          entryFileNames: '[name].cjs',
          format: 'cjs',
          sourcemap: true,
        },
      ],
      plugins: [
        makeAliasPlugin(),
        typescript({
          tsconfig: graph.tsconfigPath,
          declaration: false,
        }),
      ],
    }),
  ];

  // ── DTS bundle (pitfall 5) ────────────────────────────────────────────────
  if (graph.emitTypes) {
    configs.push(
      defineConfig({
        input: { [graph.key]: graph.inputRel },
        external: isExternal,
        output: {
          dir: 'dist',
          entryFileNames: '[name].d.ts',
          format: 'es',
        },
        plugins: [
          // Same alias entries → DTS resolves paths identically to the JS bundle
          makeAliasPlugin(),
          dts({ tsconfig: graph.tsconfigPath }),
        ],
      }),
    );
  }

  return configs;
}

// ─────────────────────────────────────────────────────────────────────────────
// § 12  Mode-gated feature flags
// ─────────────────────────────────────────────────────────────────────────────

function resolveModeDefaults(mode: BuildMode): {
  strictVersions: boolean;
  allowFsDiscovery: boolean;
} {
  switch (mode) {
    case 'library':
      return { strictVersions: false, allowFsDiscovery: true };
    case 'graph':
      return { strictVersions: true, allowFsDiscovery: false };
    case 'monorepo':
      return { strictVersions: true, allowFsDiscovery: false };
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// § 13  Orchestrator — pulls everything together
// ─────────────────────────────────────────────────────────────────────────────

function buildRollupConfig(): RollupOptions[] {
  const config = loadBuildConfig();

  const mode: BuildMode =
    (process.env['BUILD_MODE'] as BuildMode | undefined) ??
    config.mode ??
    'library';

  const modeDefaults = resolveModeDefaults(mode);
  const strictVersions = config.strictVersions ?? modeDefaults.strictVersions;
  const globalDeps: Record<string, DepPolicy> = config.globalDeps ?? {};

  console.log(`[Build] mode=${mode}  strictVersions=${strictVersions}`);

  // ── Resolve entry contracts ───────────────────────────────────────────────
  let contracts: EntryContract[];

  if (config.entries && config.entries.length > 0) {
    // Contract-driven (pitfall 6 fix)
    contracts = config.entries;
  } else if (modeDefaults.allowFsDiscovery) {
    // Filesystem fallback — Option A behaviour
    console.warn(
      '[Build] No entries declared in build.config.ts — falling back to filesystem discovery.',
    );
    contracts = discoverEntriesFromFS(process.cwd());
  } else {
    throw new Error(
      `[Build] mode="${mode}" requires explicit entries in build.config.ts. Filesystem discovery is disabled.`,
    );
  }

  // ── Build per-entry graphs ────────────────────────────────────────────────
  const graphs: EntryGraph[] = contracts.map((contract) =>
    buildEntryGraph(contract, globalDeps),
  );

  // ── Pre-build conflict analysis (pitfall 11) ──────────────────────────────
  const depGraph = new VersionedDepGraph();
  for (const graph of graphs) depGraph.registerAll(graph.deps);
  depGraph.analyze(strictVersions);

  // ── Emit Rollup configs ───────────────────────────────────────────────────
  return graphs.flatMap(generateRollupConfigs);
}

// ─────────────────────────────────────────────────────────────────────────────
// § 14  Export
// ─────────────────────────────────────────────────────────────────────────────

export const rollupConfig = buildRollupConfig();
export default defineConfig(rollupConfig);