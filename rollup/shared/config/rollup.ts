import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { dirname, extname, join, relative, resolve, sep } from 'node:path';
import alias from '@rollup/plugin-alias';
import typescript from '@rollup/plugin-typescript';
import { defineConfig, type RollupOptions } from 'rollup';
import dts from 'rollup-plugin-dts';

interface PackageManifest {
  dependencies?: Record<string, string>;
}

interface TSConfig {
  compilerOptions?: {
    paths?: Record<string, string[]>;
    baseUrl?: string;
  };
}

interface Alias {
  find: string | RegExp;
  replacement: string;
}

interface EntryMetadata {
  path: string;
  externals: string[];
  aliases: Alias[];
}

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

/**
 * Strips comments from JSONC (tsconfig) files.
 */
function parseJSONC<T>(text: string): T {
  return JSON.parse(text.replace(/\/\/.*|\/\*[\s\S]*?\*\//g, '')) as T;
}

/**
 * Walks up the tree to merge dependencies and path aliases.
 */
function getMetadata(currentDir: string): {
  externals: string[];
  aliases: Alias[];
} {
  const externals: string[] = [];
  const aliasMap: Record<string, string> = {};

  let dir = currentDir;
  const root = process.cwd();

  while (dir !== dirname(dir)) {
    // 1. Collect Externals (Nearest Wins)
    const pkgPath = join(dir, 'package.json');
    if (externals.length === 0 && existsSync(pkgPath)) {
      try {
        const pkg = JSON.parse(
          readFileSync(pkgPath, 'utf-8'),
        ) as PackageManifest;
        externals.push(...Object.keys(pkg.dependencies ?? {}));
      } catch {
        /* skip */
      }
    }

    // 2. Collect Aliases (Recursive Merge - Submodule Overrides)
    const tsPath = join(dir, 'tsconfig.json');
    if (existsSync(tsPath)) {
      try {
        const tsconfig = parseJSONC<TSConfig>(readFileSync(tsPath, 'utf-8'));
        const paths = tsconfig.compilerOptions?.paths ?? {};
        const baseUrl = tsconfig.compilerOptions?.baseUrl ?? '.';
        const absoluteBase = resolve(dir, baseUrl);

        for (const [key, values] of Object.entries(paths)) {
          const cleanKey = key.replace('/*', '');
          // Only add if not already defined (Bottom-up priority)
          if (!aliasMap[cleanKey]) {
            const cleanValue = values[0].replace('/*', '');
            aliasMap[cleanKey] = resolve(absoluteBase, cleanValue);
          }
        }
      } catch {
        /* skip */
      }
    }

    if (dir === root) break;
    dir = dirname(dir);
  }

  const aliases = Object.entries(aliasMap).map(([find, replacement]) => ({
    find,
    replacement,
  }));

  return { aliases, externals };
}

function discoverEntryPoints(
  dir: string,
  entryMap: Record<string, EntryMetadata> = {},
): Record<string, EntryMetadata> {
  const files = readdirSync(dir);

  for (const file of files) {
    const fullPath = join(dir, file);
    if (statSync(fullPath).isDirectory()) {
      if (file !== 'node_modules' && file !== 'dist' && !file.startsWith('.')) {
        discoverEntryPoints(fullPath, entryMap);
      }
    } else {
      const extension = extname(file);
      if (
        file.replace(extension, '') === 'index' &&
        SUPPORTED_EXTENSIONS.includes(extension)
      ) {
        const relativePath = relative(process.cwd(), fullPath);
        const key = relativePath.replace(extension, '').split(sep).join('/');

        if (!entryMap[key]) {
          const meta = getMetadata(dirname(fullPath));
          entryMap[key] = {
            aliases: meta.aliases,
            externals: meta.externals,
            path: `./${relativePath}`,
          };
        }
      }
    }
  }
  return entryMap;
}

const entryPoints = discoverEntryPoints(process.cwd());

/**
 * Generate a specific configuration for every entry point
 * to ensure path alias isolation.
 */
export const rollupConfig: RollupOptions[] = Object.entries(
  entryPoints,
).flatMap(([key, meta]) => {
  const isExternal = (id: string): boolean => {
    if (id.startsWith('node:')) return true;
    return meta.externals.some((dep) => id === dep || id.startsWith(`${dep}/`));
  };

  const sharedPlugins = [alias({ entries: meta.aliases })];

  return [
    // Code Bundle
    defineConfig({
      external: isExternal,
      input: { [key]: meta.path },
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
        typescript({ declaration: false, tsconfig: './tsconfig.json' }),
      ],
    }),
    // Types Bundle
    defineConfig({
      external: isExternal,
      input: { [key]: meta.path },
      output: { dir: 'dist', entryFileNames: '[name].d.ts', format: 'es' },
      plugins: [...sharedPlugins, dts()],
    }),
  ];
});
