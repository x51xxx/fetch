'use strict'

const js = require('@eslint/js')
const globals = require('globals')

module.exports = [
  {
    ignores: [
      'node_modules/**',
      'target/**',
      'npm/**',
      'binding.js',
      'binding.d.ts',
      '*.node',
      'bench/report-data.json',
      'bench/results/**',
      'docs/benchmark-report.html',
      'bench/report-template.html',
    ],
  },
  js.configs.recommended,
  {
    languageOptions: {
      ecmaVersion: 2023,
      sourceType: 'commonjs',
      globals: {
        ...globals.node,
      },
    },
    rules: {
      'no-unused-vars': ['error', { argsIgnorePattern: '^_' }],
    },
  },
  {
    // k6 scenario scripts run inside k6's own goja/ES-module runtime, not
    // Node — `import ... from 'k6/http'` etc. are k6-virtual modules.
    files: ['bench/k6-scenario.js'],
    languageOptions: {
      sourceType: 'module',
      globals: {
        __ENV: 'readonly',
      },
    },
  },
]
