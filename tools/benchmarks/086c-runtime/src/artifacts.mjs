import { mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { ARTIFACTS_DIRECTORY } from './constants.mjs';

export async function ensureArtifactsDirectory() {
  await mkdir(ARTIFACTS_DIRECTORY, { recursive: true });
  return ARTIFACTS_DIRECTORY;
}

export async function writeArtifact(name, value) {
  await ensureArtifactsDirectory();
  const target = path.join(ARTIFACTS_DIRECTORY, name);
  await writeFile(target, `${JSON.stringify(value, null, 2)}\n`, 'utf8');
  return target;
}

export async function readArtifact(name, fallback = null) {
  try {
    return JSON.parse(await readFile(path.join(ARTIFACTS_DIRECTORY, name), 'utf8'));
  } catch (error) {
    if (error.code === 'ENOENT') {
      return fallback;
    }
    throw error;
  }
}
