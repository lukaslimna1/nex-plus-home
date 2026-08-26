#!/usr/bin/env node
/**
 * NEX+ · Verification Build Runner (Isolated DistDir & Exclusive Lock)
 *
 * Executa o Next.js build exclusivamente no diretório isolado (.next-verify).
 * Utiliza lock atômico exclusivo (flag 'wx') para garantir fail-closed em concorrência.
 * Utiliza NEX_BUILD_MODE=verify com tsconfig.verify.json dedicado, mantendo o tsconfig.json intocado.
 */

import { execFileSync, spawn } from 'node:child_process';
import path from 'node:path';
import fs from 'node:fs';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const projectRoot = path.resolve(__dirname, '..');

const isWindows = process.platform === 'win32';
const nextBin = path.join(projectRoot, 'node_modules', '.bin', isWindows ? 'next.cmd' : 'next');
const lockFile = path.join(projectRoot, '.next-verify.lock');
const lockOwner = {
  pid: process.pid,
  timestamp: Date.now(),
  type: 'build:verify',
  token: crypto.randomUUID(),
};

let lockFd = null;
let child = null;
let finished = false;

function releaseLock() {
  if (lockFd !== null) {
    try {
      fs.closeSync(lockFd);
    } catch {}
    lockFd = null;
  }

  try {
    const content = JSON.parse(fs.readFileSync(lockFile, 'utf8'));
    if (content?.token === lockOwner.token) {
      fs.unlinkSync(lockFile);
    }
  } catch {}
}

function acquireLock() {
  try {
    lockFd = fs.openSync(lockFile, 'wx');
    fs.writeFileSync(lockFd, JSON.stringify(lockOwner, null, 2), 'utf8');
  } catch (err) {
    if (lockFd !== null) {
      try {
        fs.closeSync(lockFd);
      } catch {}
      lockFd = null;
    }

    if (err?.code === 'EEXIST') {
      throw new Error(`[build:verify] ERRO DE CONCORRÊNCIA: lock ativo em ${lockFile}. Abortando.`);
    }
    throw new Error(`[build:verify] Erro ao criar lockfile: ${err?.message || err}`);
  }
}

function terminateChild() {
  if (!child?.pid || child.killed) return;

  try {
    if (isWindows) {
      execFileSync('taskkill', ['/PID', String(child.pid), '/T', '/F'], { stdio: 'ignore' });
    } else {
      child.kill('SIGTERM');
    }
  } catch {}
}

const distDir = path.join(projectRoot, '.next-verify');

function cleanVerifyDistDir() {
  const resolvedDist = path.resolve(distDir);
  const resolvedRoot = path.resolve(projectRoot);

  // Path safety checks
  if (
    resolvedDist === resolvedRoot ||
    !resolvedDist.startsWith(resolvedRoot + path.sep) ||
    path.basename(resolvedDist) !== '.next-verify'
  ) {
    throw new Error(`[build:verify] [SECURITY_FAIL] Caminho inválido para limpeza de distDir: ${resolvedDist}`);
  }

  if (fs.existsSync(resolvedDist)) {
    fs.rmSync(resolvedDist, {
      recursive: true,
      force: true,
      maxRetries: 5,
      retryDelay: 100,
    });
  }
}

function finish(code, message) {
  if (finished) return;
  finished = true;

  let cleanupError = null;
  try {
    cleanVerifyDistDir();
  } catch (err) {
    cleanupError = err;
  }

  releaseLock();

  if (message) {
    if (code === 0) {
      console.log(message);
    } else {
      console.error(message);
    }
  }

  if (cleanupError) {
    console.error(`[build:verify] [HYGIENE_FAIL] Falha ao limpar diretório isolado .next-verify: ${cleanupError?.message || cleanupError}`);
    process.exit(code !== 0 ? code : 1);
  }

  process.exit(code);
}

try {
  acquireLock();
} catch (err) {
  console.error(err.message);
  process.exit(1);
}

const env = {
  ...process.env,
  NEX_BUILD_MODE: 'verify',
  NODE_ENV: 'production',
  NEXT_DIST_DIR: '',
};

console.log('[build:verify] Iniciando build de verificação isolado (NEX_BUILD_MODE=verify, distDir=.next-verify)');

try {
  child = spawn(nextBin, ['build'], {
    cwd: projectRoot,
    env,
    stdio: 'inherit',
    shell: isWindows,
  });
} catch (spawnErr) {
  finish(1, `[build:verify] Falha ao iniciar processo de build: ${spawnErr}`);
}

child.once('error', (err) => {
  finish(1, `[build:verify] Falha ao iniciar processo de build: ${err}`);
});

child.once('close', (code) => {
  if (code !== 0) {
    finish(code || 1, `[build:verify] Build de verificação falhou com código ${code}`);
  }
  finish(0, '[build:verify] Build de verificação concluído com sucesso em .next-verify (e limpo)');
});

function handleSignal() {
  if (finished) return;
  terminateChild();
  setTimeout(() => {
    if (!finished) finish(1, '[build:verify] Build interrompido; lock e distDir isolado limpos após encerramento forçado.');
  }, 1500).unref();
}

process.on('SIGINT', handleSignal);
process.on('SIGTERM', handleSignal);
