#!/usr/bin/env node
/**
 * NEX+ · Verification Build Runner (Isolated DistDir)
 *
 * Executa o Next.js build em um diretório isolado (.next-verify) para que
 * quality gates e checagens possam rodar sem interferir nem reescrever o .next
 * em uso pelo servidor de produção em execução.
 */

import { spawn } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const projectRoot = path.resolve(__dirname, '..');

const isWindows = process.platform === 'win32';
const nextBin = path.join(projectRoot, 'node_modules', '.bin', isWindows ? 'next.cmd' : 'next');

const env = {
  ...process.env,
  NEXT_DIST_DIR: process.env.NEXT_DIST_DIR || '.next-verify',
  NODE_ENV: 'production',
};

console.log(`[build:verify] Iniciando build de verificação em distDir isolado: ${env.NEXT_DIST_DIR}`);

const child = spawn(nextBin, ['build'], {
  cwd: projectRoot,
  env,
  stdio: 'inherit',
  shell: isWindows,
});

child.on('close', (code) => {
  if (code !== 0) {
    console.error(`[build:verify] Build de verificação falhou com código ${code}`);
    process.exit(code || 1);
  }
  console.log(`[build:verify] Build de verificação concluído com sucesso em ${env.NEXT_DIST_DIR}`);
  process.exit(0);
});
