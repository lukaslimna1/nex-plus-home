import { spawn } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { writeArtifact } from '../src/artifacts.mjs';

const scripts = [
  'setup.mjs',
  'run-own-runner.mjs',
  'run-pg-boss.mjs',
  'run-graphile-worker.mjs',
  'run-dbos.mjs',
  'run-openworkflow.mjs',
  'run-absurd.mjs',
  'run-payload.mjs',
];
const scriptsDirectory = path.dirname(fileURLToPath(import.meta.url));
const laboratoryRoot = path.resolve(scriptsDirectory, '..');

function runScript(script) {
  return new Promise((resolve, reject) => {
    const startedAt = performance.now();
    const child = spawn(process.execPath, [path.join(scriptsDirectory, script)], {
      cwd: laboratoryRoot,
      env: process.env,
      stdio: 'inherit',
      windowsHide: true,
    });
    child.on('error', reject);
    child.on('close', (code, signal) => {
      const durationMs = Number((performance.now() - startedAt).toFixed(2));
      if (code === 0) {
        resolve({ script, passed: true, durationMs });
        return;
      }
      reject(new Error(`${script} failed with ${code ?? signal ?? 'unknown'} after ${durationMs}ms`));
    });
  });
}

const runs = [];
for (const script of scripts) {
  const run = await runScript(script);
  runs.push(run);
}
await writeArtifact('phase-a-run.json', {
  completedAt: new Date().toISOString(),
  scope: 'Correctness-first Phase A rerun; performance is intentionally a separate own-runner baseline.',
  runs,
});
console.log(JSON.stringify({ runner: 'phase-a', runs }, null, 2));
