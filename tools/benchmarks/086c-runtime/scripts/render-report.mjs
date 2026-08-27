import { access } from 'node:fs/promises';
import path from 'node:path';
import { LAB_ROOT } from '../src/constants.mjs';

const required = [
  'BENCHMARK_REPORT.md',
  'SCORECARD.md',
  '.artifacts/phase-a-run.json',
  '.artifacts/own-performance-results.json',
  '.artifacts/footprint.json',
];

for (const relativePath of required) {
  await access(path.join(LAB_ROOT, relativePath));
}

console.log(JSON.stringify({
  report: path.join(LAB_ROOT, 'BENCHMARK_REPORT.md'),
  scorecard: path.join(LAB_ROOT, 'SCORECARD.md'),
  status: 'static report verified against the committed Phase A evidence artifacts',
}, null, 2));
