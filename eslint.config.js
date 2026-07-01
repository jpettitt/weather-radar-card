// @ts-check
import tseslint from 'typescript-eslint';

// Flat-config equivalent of the old .eslintrc.cjs: just
// @typescript-eslint's recommended rules, same parser options, same
// invocation (`eslint src/*.ts` — the shell glob, not this config's
// `files`, decides what gets linted).
export default tseslint.config(
  ...tseslint.configs.recommended,
  {
    languageOptions: {
      parserOptions: {
        ecmaVersion: 2020,
        sourceType: 'module',
      },
    },
    rules: {
      // Place to specify ESLint rules. Can be used to overwrite rules
      // specified from the extended configs, e.g.
      // '@typescript-eslint/explicit-function-return-type': 'off',
    },
  },
);
