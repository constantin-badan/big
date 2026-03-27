const nxPlugin = require('@nx/eslint-plugin');
const tsParser = require('@typescript-eslint/parser');

module.exports = [
  ...nxPlugin.configs['flat/base'],
  {
    files: ['**/*.ts'],
    languageOptions: {
      parser: tsParser,
    },
    rules: {
      '@nx/enforce-module-boundaries': [
        'error',
        {
          enforceBuildableLibDependency: true,
          allow: ['@trading-bot/test-utils'],
          depConstraints: [
            { sourceTag: 'scope:types', onlyDependOnLibsWithTags: [] },
            { sourceTag: 'scope:event-bus', onlyDependOnLibsWithTags: ['scope:types'] },
            { sourceTag: 'scope:exchange-client', onlyDependOnLibsWithTags: ['scope:types'] },
            { sourceTag: 'scope:indicators', onlyDependOnLibsWithTags: ['scope:types'] },
            { sourceTag: 'scope:data-feed', onlyDependOnLibsWithTags: ['scope:types', 'scope:event-bus', 'scope:exchange-client'] },
            { sourceTag: 'scope:position-manager', onlyDependOnLibsWithTags: ['scope:types', 'scope:event-bus', 'scope:order-executor', 'scope:risk-manager'] },
            { sourceTag: 'scope:risk-manager', onlyDependOnLibsWithTags: ['scope:types', 'scope:event-bus'] },
            { sourceTag: 'scope:order-executor', onlyDependOnLibsWithTags: ['scope:types', 'scope:event-bus', 'scope:exchange-client'] },
            { sourceTag: 'scope:scanner', onlyDependOnLibsWithTags: ['scope:types', 'scope:event-bus', 'scope:indicators'] },
            { sourceTag: 'scope:strategy', onlyDependOnLibsWithTags: ['scope:types', 'scope:event-bus', 'scope:exchange-client', 'scope:order-executor', 'scope:scanner', 'scope:position-manager', 'scope:risk-manager'] },
            { sourceTag: 'scope:backtest-engine', onlyDependOnLibsWithTags: ['scope:types', 'scope:event-bus', 'scope:exchange-client', 'scope:data-feed', 'scope:order-executor', 'scope:strategy', 'scope:reporting'] },
            { sourceTag: 'scope:sweep-engine', onlyDependOnLibsWithTags: ['scope:types', 'scope:backtest-engine', 'scope:strategy'] },
            { sourceTag: 'scope:storage', onlyDependOnLibsWithTags: ['scope:types'] },
            { sourceTag: 'scope:live-runner', onlyDependOnLibsWithTags: ['scope:types', 'scope:event-bus', 'scope:exchange-client', 'scope:data-feed', 'scope:order-executor', 'scope:strategy', 'scope:storage'] },
            { sourceTag: 'scope:arena', onlyDependOnLibsWithTags: ['scope:types', 'scope:event-bus', 'scope:exchange-client', 'scope:data-feed', 'scope:order-executor', 'scope:strategy', 'scope:reporting'] },
            { sourceTag: 'scope:evolver', onlyDependOnLibsWithTags: ['scope:types', 'scope:arena'] },
            { sourceTag: 'scope:parity-checker', onlyDependOnLibsWithTags: ['scope:types', 'scope:backtest-engine', 'scope:reporting', 'scope:storage'] },
            { sourceTag: 'scope:reporting', onlyDependOnLibsWithTags: ['scope:types'] },
            { sourceTag: 'scope:test-utils', onlyDependOnLibsWithTags: ['scope:types', 'scope:event-bus', 'scope:exchange-client', 'scope:order-executor', 'scope:position-manager', 'scope:risk-manager'] },
          ],
        },
      ],
    },
  },
];
