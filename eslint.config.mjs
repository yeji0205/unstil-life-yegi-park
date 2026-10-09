import js from '@eslint/js';
import globals from 'globals';

// Code checks: `npm run lint`. ESLint's recommended rules (bugs, unused code)
// plus limits on line length, function size and complexity.
export default [
    { ignores: ['dist/', 'node_modules/', 'public/', 'source/'] },
    js.configs.recommended,
    {
        files: ['**/*.js', '**/*.mjs'],
        languageOptions: {
            ecmaVersion: 2022,
            sourceType: 'module',
            globals: { ...globals.browser },
        },
        rules: {
            // Unused code, including every function parameter and caught error.
            // ignoreRestSiblings: `const { name, ...rest } = obj` is the usual way to
            // drop a property, so `name` counts as used there.
            'no-unused-vars': ['error', { args: 'all', caughtErrors: 'all', ignoreRestSiblings: true }],
            'prefer-const': 'error',
            'no-var': 'error',
            eqeqeq: ['error', 'always'],
            // Shader code lives in template literals; their lines are GLSL, not JS.
            'max-len': ['warn', { code: 120, ignoreUrls: true, ignoreTemplateLiterals: true }],
            complexity: ['warn', 15],
            'max-depth': ['warn', 4],
            'max-lines-per-function': ['warn', { max: 80, skipBlankLines: true, skipComments: true }],
            'max-lines': ['warn', { max: 400, skipBlankLines: true, skipComments: true }],
        },
    },
    // Node scripts (not run in the browser).
    { files: ['eslint.config.mjs', 'vite.config.js'], languageOptions: { globals: { ...globals.node } } },
];
