#!/usr/bin/env bun
/**
 * CLI for Pine Script generation.
 *
 * Usage:
 *   bun run packages/pine-gen/src/cli.ts robust.json ./pine-output/
 *   bun run packages/pine-gen/src/cli.ts robust.json              (outputs to ./pine/)
 */
import { generateFromFile } from './generator';

async function main(): Promise<void> {
  const inputPath = process.argv[2];
  const outputDir = process.argv[3] ?? './pine';

  if (!inputPath) {
    console.error('Usage: bun run pine-gen/src/cli.ts <robust.json> [output-dir]');
    console.error('');
    console.error('Generates TradingView Pine Script v6 strategies from exported configs.');
    console.error('Input: robust.json from stress test (--export) or results (--export).');
    process.exit(1);
  }

  const { mkdirSync } = await import('node:fs');
  mkdirSync(outputDir, { recursive: true });

  console.log(`Generating Pine scripts from ${inputPath}...`);
  const files = await generateFromFile(inputPath, outputDir);

  console.log(`Generated ${String(files.length)} Pine scripts in ${outputDir}/`);
  for (const f of files) {
    console.log(`  ${f}`);
  }
}

main().catch((err) => {
  console.error('Pine generation failed:', err);
  process.exit(1);
});
