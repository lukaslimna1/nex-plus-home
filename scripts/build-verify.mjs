#!/usr/bin/env node
/**
 * NEX+ · Verification Build Runner (Isolated DistDir & Exclusive Lock)
 *
 * Executa o Next.js build exclusivamente no diretório isolado (.next-verify).
 * Utiliza lock atômico exclusivo (flag 'wx') para garantir fail-closed em concorrência.
 * Utiliza NEX_BUILD_MODE=verify com tsconfig.verify.json dedicado, mantendo o tsconfig.json intocado.
 */

import { spawn } from 'node:child_process';
import path from 'node:path';
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const projectRoot = path.resolve(__dirname, '..');

const isWindows = process.platform === 'win32';
const nextBin = path.join(projectRoot, 'node_modules', '.bin', isWindows ? 'next.cmd' : 'next');

const lockFile = path.join(projectRoot, '.next-verify.lock');
let lockFd = null;

try {
  lockFd = fs.openSync(lockFile, 'wx');
  const lockData = JSON.stringify(
    {
      pid: process.pid,
      timestamp: Date.now(),
      type: 'build:verify',
    },
    null,
    2,
  );
  fs.writeFileSync(lockFd, lockData, 'utf8');
} catch (err) {
  if (err && err.code === 'EEXIST') {
    let isStale = false;
    try {
      const existing = JSON.parse(fs.readFileSync(lockFile, 'utf8'));
      if (existing && existing.pid) {
        try {
          process.kill(existing.pid, 0);
        } catch (killErr) {
          if (killErr && killErr.code === 'ESRCH') {
            isStale = true;
          }
        }
      }
    } catch {}

    if (isStale) {
      console.warn(`[build:verify] Lockfile órfão detectado (PID anterior não existe). Limpando lock stale...`);
      try {
        fs.unlinkSync(lockFile);
      } catch {}
      try {
        lockFd = fs.openSync(lockFile, 'wx');
        const lockData = JSON.stringify(
          {
            pid: process.pid,
            timestamp: Date.now(),
            type: 'build:verify',
          },
          null,
          2,
        );
        fs.writeFileSync(lockFd, lockData, 'utf8');
      } catch (retryErr) {
        console.error(`[build:verify] Falha ao readquirir lock após limpar lock órfão. Abortando.`);
        process.exit(1);
      }
    } else {
      console.error(`[build:verify] ERRO DE CONCORRÊNCIA: Outro processo de verificação já está em execução (lock ativo em ${lockFile}). Abortando.`);
      process.exit(1);
    }
  } else {
    console.error(`[build:verify] Erro ao criar lockfile:`, err.message);
    process.exit(1);
  }
}

function releaseLock() {
  if (lockFd !== null) {
    try {
      fs.closeSync(lockFd);
    } catch {}
    lockFd = null;
  }
  try {
    if (fs.existsSync(lockFile)) {
      const content = JSON.parse(fs.readFileSync(lockFile, 'utf8'));
      if (content && content.pid === process.pid) {
        fs.unlinkSync(lockFile);
      }
    }
  } catch {}
}

const env = {
  ...process.env,
  NEX_BUILD_MODE: 'verify',
  NODE_ENV: 'production',
};

// Remover qualquer distDir manual para forçar a autoridade do NEX_BUILD_MODE
delete env.NEXT_DIST_DIR;

console.log(`[build:verify] Iniciando build de verificação isolado (NEX_BUILD_MODE=verify, distDir=.next-verify)`);

let child = null;
try {
  child = spawn(nextBin, ['build'], {
    cwd: projectRoot,
    env,
    stdio: 'inherit',
    shell: isWindows,
  });
} catch (spawnErr) {
  releaseLock();
  console.error(`[build:verify] Falha ao iniciar processo de build:`, spawnErr);
  process.exit(1);
}

child.on('close', (code) => {
  releaseLock();
  if (code !== 0) {
    console.error(`[build:verify] Build de verificação falhou com código ${code}`);
    process.exit(code || 1);
  }
  console.log(`[build:verify] Build de verificação concluído com sucesso em .next-verify`);
  process.exit(0);
});

function handleSignal(signal) {
  if (child) {
    try {
      child.kill(signal);
    } catch {}
  }
  releaseLock();
  process.exit(1);
}

process.on('SIGINT', () => handleSignal('SIGINT'));
process.on('SIGTERM', () => handleSignal('SIGTERM'));
process.on('exit', () => releaseLock());
