import { defineConfig } from 'vite'

export default defineConfig({
  // The Go server mounts the production bundle below /admin/.
  base: '/admin/',
  resolve: {
    // CodeMirror extensions rely on `instanceof` checks against classes from
    // @codemirror/state. Force every extension through one module instance,
    // including linked local dependencies and Vite's development pre-bundles.
    dedupe: [
      '@codemirror/state',
      '@codemirror/view',
      '@codemirror/language',
      '@lezer/common',
      '@lezer/highlight',
    ],
  },
})
