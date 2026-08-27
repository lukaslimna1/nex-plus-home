import { spawn } from 'node:child_process';

export function run(command, args, options = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, {
      cwd: options.cwd,
      env: options.env ?? process.env,
      stdio: options.stdio ?? 'pipe',
      windowsHide: true,
    });

    let stdout = '';
    let stderr = '';
    child.stdout?.on('data', (chunk) => {
      stdout += chunk;
    });
    child.stderr?.on('data', (chunk) => {
      stderr += chunk;
    });
    child.on('error', reject);
    child.on('close', (code, signal) => {
      const result = { code, signal, stdout: stdout.trim(), stderr: stderr.trim() };
      if (code === 0) {
        resolve(result);
      } else {
        const error = new Error(`${command} ${args.join(' ')} failed (${code ?? signal ?? 'unknown'})\n${stderr}`);
        error.result = result;
        reject(error);
      }
    });
  });
}

export async function runAllowFailure(command, args, options = {}) {
  try {
    return await run(command, args, options);
  } catch (error) {
    return error.result ?? { code: -1, signal: null, stdout: '', stderr: error.message };
  }
}

export function sleep(milliseconds) {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}
