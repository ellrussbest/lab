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

import alias from '@rollup/plugin-alias';
import typescript from '@rollup/plugin-typescript';
import { defineConfig, type RollupOptions } from 'rollup';
import dts from 'rollup-plugin-dts';
import { parse } from 'jsonc-parser';

// --------------------
// Types
// --------------------

interface PackageManifest {
  dependencies?: Record<string, string>;
  peerDependencies?: Record<string, string>;
}

interface TSConfig {
  compilerOptions?: {
    paths?: Record<string, string[]>;
    baseUrl?: string;
  };
}

interface Alias {
  find: RegExp;
  replacement: string;
}

interface EntryMetadata {
  path: string;
  externals: string[];
  aliases: Alias[];
  tsconfigPath: string;
}

// --------------------
// Constants
// --------------------

const SUPPORTED_EXTENSIONS = [
  '.ts',
  '.tsx',
  '.mts',
  '.cts',
  '.js',
  '.jsx',
  '.mjs',
  '.cjs',
];

// --------------------
// Helpers
// --------------------

function safeReadJSON<T>(file: string): T | null {
  try {
    return JSON.parse(readFileSync(file, 'utf-8')) as T;
  } catch {
    return null;
  }
}

function safeReadTSConfig(file: string): TSConfig | null {
  try {
    return parse(readFileSync(file, 'utf-8')) as TSConfig;
  } catch {
    return null;
  }
}

/**
 * Convert TS path alias → Rollup alias (regex-based, correct semantics)
 */
function createAlias(find: string, target: string): Alias {
  const hasWildcard = find.endsWith('/*');

  if (hasWildcard) {
    const prefix = find.slice(0, -2);
    return {
      find: new RegExp(`^${prefix}/(.+)$`),
      replacement: `${target}/$1`,
    };
  }

  return {
    find: new RegExp(`^${find}$`),
    replacement: target,
  };
}

/**
 * Walk upward and merge metadata consistently
 */
function getMetadata(startDir: string): {
  externals: string[];
  aliases: Alias[];
  tsconfigPath: string;
} {
  const externals = new Set<string>();
  const aliasMap = new Map<string, Alias>();
  let tsconfigPath: string | null = null;

  let dir = startDir;
  const root = process.cwd();

  while (true) {
    // ---- package.json (MERGED: deps + peerDeps) ----
    const pkgPath = join(dir, 'package.json');
    if (existsSync(pkgPath)) {
      const pkg = safeReadJSON<PackageManifest>(pkgPath);

      const allDeps = {
        ...pkg?.dependencies,
        ...pkg?.peerDependencies,
      };

      for (const dep of Object.keys(allDeps ?? {})) {
        externals.add(dep);
      }
    }

    // ---- tsconfig.json (merged with override) ----
    const tsPath = join(dir, 'tsconfig.json');
    if (existsSync(tsPath)) {
      if (!tsconfigPath) {
        tsconfigPath = tsPath; // nearest tsconfig for compiler
      }

      const tsconfig = safeReadTSConfig(tsPath);
      const paths = tsconfig?.compilerOptions?.paths ?? {};
      const baseUrl = tsconfig?.compilerOptions?.baseUrl ?? '.';
      const absoluteBase = resolve(dir, baseUrl);

      for (const [key, values] of Object.entries(paths)) {
        const first = values?.[0];
        if (!first) continue;

        if (!aliasMap.has(key)) {
          const target = resolve(
            absoluteBase,
            first.replace('/*', ''),
          );
          aliasMap.set(key, createAlias(key, target));
        }
      }
    }

    if (dir === root) break;
    dir = dirname(dir);
  }

  const aliases = Array.from(aliasMap.values()).sort(
    (a, b) => b.find.source.length - a.find.source.length,
  );

  return {
    externals: Array.from(externals),
    aliases,
    tsconfigPath: tsconfigPath ?? join(root, 'tsconfig.json'),
  };
}

// --------------------
// Entry discovery
// --------------------

function discoverEntryPoints(
  dir: string,
  map: Map<string, EntryMetadata> = new Map(),
): Map<string, EntryMetadata> {
  for (const file of readdirSync(dir)) {
    const fullPath = join(dir, file);

    if (statSync(fullPath).isDirectory()) {
      if (
        file !== 'node_modules' &&
        file !== 'dist' &&
        !file.startsWith('.')
      ) {
        discoverEntryPoints(fullPath, map);
      }
      continue;
    }

    const ext = extname(file);
    if (!SUPPORTED_EXTENSIONS.includes(ext)) continue;

    if (file.replace(ext, '') !== 'index') continue;

    const relativePath = relative(process.cwd(), fullPath);
    const key = relativePath
      .replace(ext, '')
      .split(sep)
      .join('/');

    if (map.has(key)) {
      throw new Error(
        `Duplicate entry detected for "${key}" (conflicting index files).`,
      );
    }

    const meta = getMetadata(dirname(fullPath));

    map.set(key, {
      path: `./${relativePath}`,
      aliases: meta.aliases,
      externals: meta.externals,
      tsconfigPath: meta.tsconfigPath,
    });
  }

  return map;
}

// --------------------
// Build config
// --------------------

const entryPoints = discoverEntryPoints(process.cwd());

export const rollupConfig: RollupOptions[] = Array.from(
  entryPoints.entries(),
).flatMap(([key, meta]) => {
  const isExternal = (id: string): boolean => {
    if (id.startsWith('node:')) return true;

    return meta.externals.some(
      (dep) => id === dep || id.startsWith(`${dep}/`),
    );
  };

  const sharedPlugins = [
    alias({ entries: meta.aliases }),
  ];

  return [
    // ---- Code ----
    defineConfig({
      input: { [key]: meta.path },
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
        ...sharedPlugins,
        typescript({
          tsconfig: meta.tsconfigPath,
          declaration: false,
        }),
      ],
    }),

    // ---- Types ----
    defineConfig({
      input: { [key]: meta.path },
      external: isExternal,
      output: {
        dir: 'dist',
        entryFileNames: '[name].d.ts',
        format: 'es',
      },
      plugins: [
        ...sharedPlugins,
        dts(),
      ],
    }),
  ];
});