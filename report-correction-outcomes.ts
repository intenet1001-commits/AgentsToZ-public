#!/usr/bin/env bun
import {resolveAppDataDirFromEnvironment} from './src/appDataDir';
import {readCorrectionOutcomeReport} from './src/correctionOutcomeStore';
import {benchmarkExitCode} from './benchmark-voice-remote';

/**
 * Read-only correction-outcome evidence export. Prints the protocol version/hash, outcome counts and the coverage
 * note — never ids, titles, evidence or task text. Never creates the store. The learning track is NOT_RUN without
 * finalized outcomes and BLOCKED (baseline-missing) with them: descriptive counts never become PASS.
 *
 *   bun report-correction-outcomes.ts [--app-data-dir <absolute path>]
 */
if (import.meta.main) {
  const args = process.argv.slice(2);
  let appDataDir: string | undefined;
  if (args.length === 2 && args[0] === '--app-data-dir') appDataDir = args[1];
  else if (args.length !== 0) { console.error('usage: bun report-correction-outcomes.ts [--app-data-dir <absolute path>]'); process.exit(64); }
  try {
    const report = readCorrectionOutcomeReport(appDataDir ?? resolveAppDataDirFromEnvironment());
    process.stdout.write(JSON.stringify(report) + '\n');
    process.exitCode = benchmarkExitCode(report.learning.status);
  } catch { console.error('CORRECTION_OUTCOME_REPORT_UNAVAILABLE'); process.exitCode = 65; }
}
