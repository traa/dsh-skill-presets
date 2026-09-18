/**
 * Browser bundle for the skill-presets client half.
 *
 * The web boot graph fetches `/plugins/<pkg>/client.js` and expects a
 * closure-factory artifact — `window.__ModuleLoader__.load({ id, factory })` —
 * not plain ESM. A `tsc` output serves HTTP 200, appears in the boot graph, and
 * is never executed. `platform: 'browser'` + `format: 'cjs'` + the
 * banner/footer/intro trio reproduce the shape the in-tree client packages emit.
 * React arrives through the injected `require`, so nothing from `@deepseek-ai/*`
 * is imported at runtime.
 */
import type { UserConfig } from 'tsdown'

const ID = 'dsh-skill-presets'

const config: UserConfig = {
  name: `${ID}/client`,
  entry: { client: 'src/client/index.ts' },
  outDir: 'lib',
  format: 'cjs',
  platform: 'browser',
  target: 'es2024',
  dts: false,
  clean: false,
  // React MUST stay a `require('react')` for the page's loader to satisfy.
  // The stage (`stage/`) added react/react-dom to devDependencies, and the
  // moment they were resolvable the bundler inlined a second React — whose
  // hooks then ran against a null dispatcher inside the page's React tree.
  // Nothing in @deepseek-ai/* is imported at runtime either.
  external: ['react', 'react-dom', /^@deepseek-ai\//u],
  sourcemap: true,
  define: {
    'process.env.NODE_ENV': JSON.stringify('production'),
  },
  outputOptions: {
    entryFileNames: 'client.js',
    banner: `window.__ModuleLoader__.load({ id: ${JSON.stringify(ID)}, factory: (require) => {`,
    footer: 'return module.exports; } });',
    intro: 'var module = { exports: {} }; var exports = module.exports;',
  },
}

export default config
