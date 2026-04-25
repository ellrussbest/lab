import { defineConfig } from 'rollup';
import rollupgPluginCss from 'rollup-plugin-css-only';

// Rollup config for a single-entry, single-format (CJS) bundle
export const singleEntryCjsConfig = defineConfig({
  // Root file Rollup starts tracing dependencies from
  input: 'src/main.js',

  output: {
    // Final bundled artifact
    file: 'build/bundle.js',

    // CommonJS output (Node.js-friendly)
    // Swap to 'es' if targeting modern bundlers instead
    format: 'cjs',
  },
});

// Rollup config for a single-entry with multiple output formats
export const multipleFormatBundleConfig = defineConfig({
  // Root file Rollup starts tracing dependencies from
  input: 'src/main.js',

  output: [
    {
      // Final bundled artifact (CommonJS)
      file: 'build/bundle.js',

      // CommonJS output (Node.js-friendly)
      format: 'cjs',
    },
    {
      // Final bundled artifact (ESM)
      file: 'build/bundle-b2.js',

      // ES module output (modern bundlers)
      format: 'es',
    },
  ],
});

// 1. Allows you to customize Rollup's behavior
// 2. Transpiling code before bundling
// 3. Finding third-party modules your node_modules folder
export const rollupWithPlugins = defineConfig({
  // Root file Rollup starts tracing dependencies from
  input: 'src/main.js',

  output: [
    {
      // Final bundled artifact (CommonJS)
      file: 'build/bundle.js',

      // CommonJS output (Node.js-friendly)
      format: 'cjs',

      // for dynamic imports e.g. await {} import // etc.
      inlineDynamicImports: true,
    },
    {
      // Final bundled artifact (ESM)
      file: 'build/bundle-b2.js',

      // ES module output (modern bundlers)
      format: 'es',

      // for dynamic imports
      inlineDynamicImports: true,
    },
    {
      // Final bundled artifact (IIFE for browsers)
      file: 'build/bundle-b2.js',

      // IIFE output (browser-ready, self-executing)
      format: 'iife',

      // for dynamic imports
      inlineDynamicImports: true,
    },
  ],

  plugins: [
    rollupgPluginCss({
      // Extracts all imported CSS into a separate file
      output: 'bundle.css',
    }),
  ],
});

export function rollupConfig() {}
