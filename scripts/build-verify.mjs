#!/usr/bin/env node
/**
 * NEX+ · Verification Build Runner (Isolated DistDir)
 *
 * Executa o Next.js build exclusivamente no diretório isolado fixo (.next-verify).
 * Rejeita explicitamente qualquer tentativa de usar .next ou fallback padrão.
 * Preserva o tsconfig.json canônico sem mutações efêmeras.
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

// Diretório fixo e obrigatório para verificação (nunca .next)
const isolatedDistDir = '.next-verify';

if (isolatedDistDir === '.next' || !isolatedDistDir.startsWith('.next-')) {
  console.error(`[build:verify] ERRO CRÍTICO DE SEGURANÇA: distDir '${isolatedDistDir}' não é permitido para build de verificação.`);
  process.exit(1);
}

// Bloqueio de concorrência / lock simples
const lockFile = path.join(projectRoot, '.next-verify.lock');
if (fs.existsSync(lockFile)) {
  try {
    const lockPid = fs.readFileSync(lockFile, 'utf8').trim();
    console.warn(`[build:verify] AVISO: Lockfile encontrado (PID: ${lockPid}).`);
  } catch {}
}

try {
  fs.writeFileSync(lockFile, String(process.pid), { flag: 'w' });
} catch {}

// Backup do tsconfig.json canônico para evitar mutação automática de includes efêmeros pelo Next.js
const tsconfigPath = path.join(projectRoot, 'tsconfig.json');
let initialTsconfig = null;
try {
  initialTsconfig = fs.readFileSync(tsconfigPath, 'utf8');
} catch {}

function restoreTsconfig() {
  if (initialTsconfig) {
    try {
      fs.writeFileSync(tsconfigPath, initialTsconfig, 'utf8');
    } catch {}
  }
}

function cleanupLock() {
  try {
    if (fs.existsSync(lockFile)) {
      fs.unlinkSync(lockFile);
    }
  } catch {}
}

const env = {
  ...process.env,
  NEXT_DIST_DIR: isolatedDistDir,
  NODE_ENV: 'production',
};

console.log(`[build:verify] Iniciando build de verificação em distDir isolado fixo: ${env.NEXT_DIST_DIR}`);

const child = spawn(nextBin, ['build'], {
  cwd: projectRoot,
  env,
  stdio: 'inherit',
  shell: isWindows,
});

child.on('close', (code) => {
  restoreTsconfig();
  cleanupLock();
  if (code !== 0) {
    console.error(`[build:verify] Build de verificação falhou com código ${code}`);
    process.exit(code || 1);
  }
  console.log(`[build:verify] Build de verificação concluído com sucesso em ${env.NEXT_DIST_DIR}`);
  process.exit(0);
});

process.on('SIGINT', () => {
  restoreTsconfig();
  cleanupLock();
  process.exit(1);
});
process.on('SIGTERM', () => {
  restoreTsconfig();
  cleanupLock();
  process.exit(1);
});
