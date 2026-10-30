// Lint catches the mistakes that matter for an AI-maintained codebase: hook dependencies, unused code and unsafe types.
import js from '@eslint/js';
import tseslint from 'typescript-eslint';
import reactHooks from 'eslint-plugin-react-hooks';

export default tseslint.config(
  {
    ignores: [
      'dist',
      'deliverables',
      'runtime',
      'resources',
      'src-tauri',
      'node_modules',
      'videos',
      'design',
      'scripts',
    ],
  },
  js.configs.recommended,
  ...tseslint.configs.recommended,
  {
    files: ['**/*.{ts,tsx}'],
    plugins: { 'react-hooks': reactHooks },
    rules: {
      'react-hooks/rules-of-hooks': 'error',
      'react-hooks/exhaustive-deps': 'warn',
      '@typescript-eslint/no-unused-vars': ['error', { argsIgnorePattern: '^_', varsIgnorePattern: '^_' }],
    },
  },
  {
    files: ['tests/**/*.mjs'],
    languageOptions: {
      globals: {
        window: 'readonly',
        document: 'readonly',
        performance: 'readonly',
        process: 'readonly',
        console: 'readonly',
        setTimeout: 'readonly',
        setInterval: 'readonly',
        clearInterval: 'readonly',
        PerformanceObserver: 'readonly',
        Response: 'readonly',
        URL: 'readonly',
        structuredClone: 'readonly',
        innerWidth: 'readonly',
        Event: 'readonly',
        getComputedStyle: 'readonly',
      },
    },
  },
);
