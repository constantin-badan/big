/**
 * Testnet validation script — runs a LiveRunner against Binance futures testnet.
 *
 * Env vars:
 *   BINANCE_TESTNET_API_KEY    — API key from testnet.binancefuture.com
 *   BINANCE_TESTNET_PRIVATE_KEY — Ed25519 private key (PEM) for testnet signing
 *
 * CLI args:
 *   --symbol BTCUSDT       (default: BTCUSDT)
 *   --timeframe 5m         (default: 5m)
 *   --duration 3600000     (default: 1 hour in ms)
 *   --template ema-crossover (default: ema-crossover)
 */
import { LiveRunner } from '@trading-bot/live-runner';
import { TEMPLATES } from '@trading-bot/strategies';
import { toSymbol } from '@trading-bot/types';
import type { ExchangeConfig, RiskConfig, PositionManagerConfig, Timeframe } from '@trading-bot/types';

// === CLI arg parsing ===

const VALID_TIMEFRAMES: Record<string, Timeframe> = {
  '1m': '1m',
  '3m': '3m',
  '5m': '5m',
  '15m': '15m',
  '1h': '1h',
  '4h': '4h',
  '1d': '1d',
};

function toTimeframe(s: string): Timeframe {
  const tf = VALID_TIMEFRAMES[s];
  if (tf === undefined) {
    throw new Error(`Invalid timeframe: ${s}. Valid: ${Object.keys(VALID_TIMEFRAMES).join(', ')}`);
  }
  return tf;
}

function parseArgs(argv: string[]): {
  symbol: string;
  timeframe: Timeframe;
  duration: number;
  template: string;
} {
  let symbol = 'BTCUSDT';
  let timeframe: Timeframe = VALID_TIMEFRAMES['5m']!;
  let duration = 3_600_000;
  let template = 'ema-crossover';

  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    const next = argv[i + 1];
    if (arg === '--symbol' && next !== undefined) {
      symbol = next;
      i++;
    } else if (arg === '--timeframe' && next !== undefined) {
      timeframe = toTimeframe(next);
      i++;
    } else if (arg === '--duration' && next !== undefined) {
      duration = Number(next);
      i++;
    } else if (arg === '--template' && next !== undefined) {
      template = next;
      i++;
    }
  }

  return { symbol, timeframe, duration, template };
}

// === Main ===

export async function runTestnet(argv: string[]): Promise<void> {
  const args = parseArgs(argv);

  // 1. Validate env vars
  const apiKey = process.env.BINANCE_TESTNET_API_KEY;
  const privateKey = process.env.BINANCE_TESTNET_PRIVATE_KEY;

  if (!apiKey || !privateKey) {
    console.error('Missing required env vars:');
    if (!apiKey) console.error('  BINANCE_TESTNET_API_KEY');
    if (!privateKey) console.error('  BINANCE_TESTNET_PRIVATE_KEY');
    process.exit(1);
  }

  // 2. Resolve template
  const template = TEMPLATES.find((t) => t.name === args.template);
  if (!template) {
    console.error(`Unknown template: ${args.template}`);
    console.error(`Available: ${TEMPLATES.map((t) => t.name).join(', ')}`);
    process.exit(1);
  }

  // 3. Build exchange config
  const exchangeConfig: ExchangeConfig = {
    type: 'binance-testnet',
    apiKey,
    privateKey,
  };

  // 4. Build risk + PM config (conservative testnet defaults)
  const riskConfig: RiskConfig = {
    maxPositionSizePct: 2,
    maxConcurrentPositions: 1,
    maxDailyLossPct: 3,
    maxDrawdownPct: 10,
    maxDailyTrades: 20,
    cooldownAfterLossMs: 60_000,
    leverage: 1,
    initialBalance: 100, // testnet USDT balance — adjust to match your testnet account
  };

  const pmConfig: PositionManagerConfig = {
    defaultStopLossPct: 2,
    defaultTakeProfitPct: 4,
    trailingStopEnabled: false,
    trailingStopActivationPct: 0,
    trailingStopDistancePct: 0,
    maxHoldTimeMs: 30 * 60 * 1000, // 30 minutes
  };

  // 5. Build strategy factory from template with reasonable defaults
  const symbols = [toSymbol(args.symbol)];
  const timeframes: Timeframe[] = [args.timeframe];
  const factory = template.createFactory(symbols, args.timeframe, riskConfig, pmConfig);

  // Use midpoint of each param range as default
  const params: Record<string, number> = {};
  for (const [key, spec] of Object.entries(template.params)) {
    params[key] = Math.round((spec.min + spec.max) / 2);
  }

  // 6. Create LiveRunner
  const runner = new LiveRunner({
    factory,
    params,
    exchangeConfig,
    symbols,
    timeframes,
    shutdownBehavior: 'close-all',
    checkOrphanPositions: true,
  });

  // 7. Graceful shutdown handler
  let stopping = false;
  const shutdown = async (reason: string): Promise<void> => {
    if (stopping) return;
    stopping = true;
    console.log(JSON.stringify({
      timestamp: new Date().toISOString(),
      level: 'info',
      event: 'testnet:shutdown',
      reason,
    }));
    await runner.stop();
  };

  process.on('SIGINT', () => { void shutdown('SIGINT'); });
  process.on('SIGTERM', () => { void shutdown('SIGTERM'); });

  // 8. Print config summary
  console.log('=== Testnet Validation ===');
  console.log(`Template:  ${template.name}`);
  console.log(`Params:    ${JSON.stringify(params)}`);
  console.log(`Symbol:    ${args.symbol}`);
  console.log(`Timeframe: ${args.timeframe}`);
  console.log(`Duration:  ${String(args.duration)}ms (${String(Math.round(args.duration / 60_000))}min)`);
  console.log(`Shutdown:  close-all`);
  console.log('');

  // 9. Start the runner
  await runner.start();

  // 10. Set duration timeout
  const timeout = setTimeout(() => {
    void shutdown('duration-elapsed');
  }, args.duration);

  // Wait until runner is stopped
  await new Promise<void>((resolve) => {
    const poll = setInterval(() => {
      if (runner.status === 'stopped') {
        clearInterval(poll);
        clearTimeout(timeout);
        resolve();
      }
    }, 1000);
  });

  console.log('=== Testnet Validation Complete ===');
}
