import type {
  ExchangeConfig,
  ParamBounds,
  RiskConfig,
  ScannerTemplate,
  Symbol,
  Timeframe,
  TournamentStageConfig,
} from '@trading-bot/types';

/** Configuration for a full tournament run. */
export interface RunConfig {
  /** Scanner templates to compete. */
  templates: ScannerTemplate[];
  /** Random scanner-param candidates per template. */
  candidatesPerTemplate: number;
  /** Bounds for position-manager params. */
  pmParams: ParamBounds;
  /** Number of PM param samples per scanner-param set. */
  pmSamples: number;
  /** Fixed risk config applied to every candidate. */
  riskConfig: RiskConfig;
  /** Simulated exchange config. */
  exchangeConfig: ExchangeConfig;
  /** Candle timeframe. */
  timeframe: Timeframe;
  /** Coins available for random selection. If empty/omitted, fetched dynamically. */
  symbolPool?: Symbol[];
  /** Data range in the local candle store. */
  dataRange: { startTime: number; endTime: number };
  /** Progressive elimination stages. */
  stages: TournamentStageConfig[];
}
