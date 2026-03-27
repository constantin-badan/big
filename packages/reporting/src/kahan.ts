// Re-export from types — KahanSum lives there so packages that can't
// depend on reporting (e.g. risk-manager) can still use it.
export { KahanSum } from '@trading-bot/types';
