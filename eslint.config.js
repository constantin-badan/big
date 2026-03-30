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
          depConstraints: [
            { sourceTag: 'scope:types', onlyDependOnLibsWithTags: [] },
            { sourceTag: 'scope:event-bus', onlyDependOnLibsWithTags: ['scope:types',  'scope:test-utils'] },
            { sourceTag: 'scope:exchange-client', onlyDependOnLibsWithTags: ['scope:types',  'scope:test-utils'] },
            { sourceTag: 'scope:indicators', onlyDependOnLibsWithTags: ['scope:types',  'scope:test-utils'] },
            { sourceTag: 'scope:data-feed', onlyDependOnLibsWithTags: ['scope:types',  'scope:test-utils'] },
            { sourceTag: 'scope:position-manager', onlyDependOnLibsWithTags: ['scope:types',  'scope:test-utils'] },
            { sourceTag: 'scope:risk-manager', onlyDependOnLibsWithTags: ['scope:types',  'scope:test-utils'] },
            { sourceTag: 'scope:margin-guard', onlyDependOnLibsWithTags: ['scope:types',  'scope:test-utils'] },
            { sourceTag: 'scope:order-executor', onlyDependOnLibsWithTags: ['scope:types',  'scope:test-utils'] },
            { sourceTag: 'scope:scanner', onlyDependOnLibsWithTags: ['scope:types',  'scope:test-utils'] },
            { sourceTag: 'scope:strategy', onlyDependOnLibsWithTags: ['scope:types',  'scope:test-utils'] },
            { sourceTag: 'scope:backtest-engine', onlyDependOnLibsWithTags: ['scope:types',  'scope:test-utils', 'scope:event-bus', 'scope:data-feed', 'scope:order-executor', 'scope:strategy', 'scope:reporting'] },
            { sourceTag: 'scope:sweep-engine', onlyDependOnLibsWithTags: ['scope:types',  'scope:test-utils', 'scope:backtest-engine', 'scope:strategy', 'scope:storage'] },
            { sourceTag: 'scope:storage', onlyDependOnLibsWithTags: ['scope:types',  'scope:test-utils'] },
            { sourceTag: 'scope:pine-gen', onlyDependOnLibsWithTags: ['scope:types'] },
            { sourceTag: 'scope:dashboard', onlyDependOnLibsWithTags: ['scope:types', 'scope:test-utils', 'scope:event-bus'] },
            { sourceTag: 'scope:alerting', onlyDependOnLibsWithTags: ['scope:types', 'scope:test-utils', 'scope:event-bus'] },
            { sourceTag: 'scope:metrics', onlyDependOnLibsWithTags: ['scope:types', 'scope:test-utils', 'scope:event-bus'] },
            { sourceTag: 'scope:live-runner', onlyDependOnLibsWithTags: ['scope:types',  'scope:test-utils', 'scope:event-bus', 'scope:exchange-client', 'scope:data-feed', 'scope:order-executor', 'scope:strategy', 'scope:dashboard', 'scope:alerting', 'scope:metrics'] },
            { sourceTag: 'scope:arena', onlyDependOnLibsWithTags: ['scope:types',  'scope:test-utils', 'scope:event-bus', 'scope:exchange-client', 'scope:data-feed', 'scope:order-executor', 'scope:strategy', 'scope:reporting', 'scope:backtest-engine'] },
            { sourceTag: 'scope:evolver', onlyDependOnLibsWithTags: ['scope:types',  'scope:test-utils', 'scope:arena'] },
            { sourceTag: 'scope:parity-checker', onlyDependOnLibsWithTags: ['scope:types',  'scope:test-utils', 'scope:backtest-engine', 'scope:storage', 'scope:strategy'] },
            { sourceTag: 'scope:reporting', onlyDependOnLibsWithTags: ['scope:types',  'scope:test-utils'] },
            { sourceTag: 'scope:test-utils', onlyDependOnLibsWithTags: ['scope:types'] },
            { sourceTag: 'scope:strategies', onlyDependOnLibsWithTags: ['scope:types', 'scope:indicators', 'scope:position-manager', 'scope:risk-manager', 'scope:scanner', 'scope:strategy'] },
            { sourceTag: 'scope:runner', onlyDependOnLibsWithTags: ['scope:types', 'scope:strategies', 'scope:storage', 'scope:backtest-engine', 'scope:sweep-engine', 'scope:exchange-client', 'scope:live-runner'] },
            { sourceTag: 'scope:e2e', onlyDependOnLibsWithTags: ['scope:types', 'scope:test-utils', 'scope:event-bus', 'scope:exchange-client', 'scope:indicators', 'scope:scanner', 'scope:risk-manager', 'scope:position-manager', 'scope:margin-guard', 'scope:order-executor', 'scope:data-feed', 'scope:strategy', 'scope:reporting', 'scope:backtest-engine', 'scope:arena', 'scope:evolver', 'scope:parity-checker', 'scope:storage', 'scope:live-runner', 'scope:sweep-engine'] },
          ],
        },
      ],
    },
  },
];
