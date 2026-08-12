import js from '@eslint/js'
import globals from 'globals'
import reactHooks from 'eslint-plugin-react-hooks'
import reactRefresh from 'eslint-plugin-react-refresh'
import tseslint from 'typescript-eslint'

export default tseslint.config(
  { ignores:['dist','data','.tmp-visual-qa'] },
  js.configs.recommended,
  ...tseslint.configs.recommended,
  {
    files:['src/**/*.{ts,tsx}'],
    languageOptions:{ ecmaVersion:2022, globals:globals.browser },
    plugins:{ 'react-hooks':reactHooks, 'react-refresh':reactRefresh },
    rules:{
      ...reactHooks.configs.recommended.rules,
      ...reactRefresh.configs.vite.rules,
      '@typescript-eslint/no-explicit-any':'off',
      'react-hooks/exhaustive-deps':'off',
      'react-hooks/set-state-in-effect':'off',
    },
  },
  {
    files:['server/**/*.ts','tests/**/*.mjs','extension-mv2/**/*.js'],
    languageOptions:{ ecmaVersion:2022, globals:{...globals.node,...globals.browser,...globals.webextensions} },
    rules:{ '@typescript-eslint/no-explicit-any':'off' },
  },
)
