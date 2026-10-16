const path = require('path');

module.exports = {
  root: true,
  env: {
    browser: true,
    es2020: true,
  },
  extends: [
    'eslint:recommended',
    'plugin:@typescript-eslint/recommended',
    'plugin:react-hooks/recommended',
    'plugin:eslint-comments/recommended',
    'prettier',
  ],
  ignorePatterns: ['dist', '.eslintrc.cjs'],
  parser: '@typescript-eslint/parser',
  plugins: [
    'react-refresh',
    '@typescript-eslint',
    'unused-imports',
    'eslint-comments',
    'check-file',
    'deprecation',
  ],
  parserOptions: {
    ecmaVersion: 'latest',
    sourceType: 'module',
    project: path.join(__dirname, 'tsconfig.json'),
  },
  rules: {
    'eslint-comments/no-use': ['error', { allow: [] }],
    'react-refresh/only-export-components': 'off',
    'unused-imports/no-unused-imports': 'error',
    'unused-imports/no-unused-vars': [
      'error',
      {
        vars: 'all',
        args: 'after-used',
        varsIgnorePattern: '^_',
        argsIgnorePattern: '^_',
        ignoreRestSiblings: false,
      },
    ],
    '@typescript-eslint/no-unused-vars': 'off',
    '@typescript-eslint/no-explicit-any': 'warn',
    '@typescript-eslint/switch-exhaustiveness-check': 'error',
    // Enforce typesafe modal pattern
    'no-restricted-imports': [
      'error',
      {
        paths: [
          {
            name: '@ebay/nice-modal-react',
            importNames: ['default'],
            message:
              'Import NiceModal only in lib/modals.ts or dialog component files. Use DialogName.show(props) instead.',
          },
          {
            name: '@/lib/modals',
            importNames: ['showModal', 'hideModal', 'removeModal'],
            message:
              'Do not import showModal/hideModal/removeModal. Use DialogName.show(props) and DialogName.hide() instead.',
          },
        ],
      },
    ],
    'no-restricted-syntax': [
      'error',
      {
        selector:
          'CallExpression[callee.object.name="NiceModal"][callee.property.name="show"]',
        message:
          'Do not use NiceModal.show() directly. Use DialogName.show(props) instead.',
      },
      {
        selector:
          'CallExpression[callee.object.name="NiceModal"][callee.property.name="register"]',
        message:
          'Do not use NiceModal.register(). Dialogs are registered automatically.',
      },
      {
        selector: 'CallExpression[callee.name="showModal"]',
        message: 'Do not use showModal(). Use DialogName.show(props) instead.',
      },
      {
        selector: 'CallExpression[callee.name="hideModal"]',
        message: 'Do not use hideModal(). Use DialogName.hide() instead.',
      },
      {
        selector: 'CallExpression[callee.name="removeModal"]',
        message: 'Do not use removeModal(). Use DialogName.remove() instead.',
      },
    ],
    // File naming conventions
    'check-file/filename-naming-convention': [
      'error',
      {
        // React components (tsx) should be PascalCase
        'src/**/*.tsx': 'PASCAL_CASE',
        // Hooks should be camelCase starting with 'use'
        'src/**/use*.ts': 'CAMEL_CASE',
        // Utils should be camelCase
        'src/utils/**/*.ts': 'CAMEL_CASE',
        // Lib/config/constants should be camelCase
        'src/lib/**/*.ts': 'CAMEL_CASE',
        'src/config/**/*.ts': 'CAMEL_CASE',
        'src/constants/**/*.ts': 'CAMEL_CASE',
      },
      {
        ignoreMiddleExtensions: true,
      },
    ],
  },
  overrides: [
    {
      files: ['tests-e2e/**/*.ts'],
      parserOptions: {
        project: path.join(__dirname, 'tsconfig.e2e.json'),
      },
      rules: {
        'check-file/filename-naming-convention': 'off',
      },
    },
    {
      // Entry point exception - main.tsx can stay lowercase
      files: ['src/main.tsx', 'src/vite-env.d.ts'],
      rules: {
        'check-file/filename-naming-convention': 'off',
      },
    },
    {
      // Shadcn UI components are an exception - keep kebab-case
      files: ['src/components/ui/**/*.{ts,tsx}'],
      rules: {
        'check-file/filename-naming-convention': [
          'error',
          {
            'src/components/ui/**/*.{ts,tsx}': 'KEBAB_CASE',
          },
          {
            ignoreMiddleExtensions: true,
          },
        ],
      },
    },
    {
      files: ['**/*.test.{ts,tsx}', '**/*.stories.{ts,tsx}'],
      rules: {
        // Test/story file names follow the subject under test (e.g. a camelCase
        // hook like useFollowUpSend needs a `.test.tsx` JSX wrapper), so the
        // component PascalCase filename convention does not apply here.
        'check-file/filename-naming-convention': 'off',
      },
    },
    {
      // Disable type-aware linting for config files
      files: ['*.config.{ts,js,cjs,mjs}', '.eslintrc.cjs'],
      parserOptions: {
        project: null,
      },
      rules: {
        '@typescript-eslint/switch-exhaustiveness-check': 'off',
      },
    },
    {
      // Allow NiceModal usage in lib/modals.ts, design scope files (for Provider), and dialog component files
      files: [
        'src/lib/modals.ts',
        'src/components/legacy-design/LegacyDesignScope.tsx',
        'src/components/dialogs/**/*.{ts,tsx}',
        'src/pages/settings/AgentUpdateConfirmDialog.tsx',
      ],
      rules: {
        'no-restricted-imports': 'off',
        'no-restricted-syntax': 'off',
      },
    },
  ],
};
