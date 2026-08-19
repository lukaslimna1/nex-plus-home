/**
 * NEX+ · Resource Governor & Local Runtime Lifecycle
 * Telemetria NVIDIA GPU (nvidia-smi) — Escopo 0.6 (Fase A)
 *
 * Consultas exclusivamente READ-ONLY a nvidia-smi sem shell interpolation.
 * Parser desacoplado para testes unitários determinísticos.
 * Ausência de driver/GPU retorna status 'unavailable' sem crash e sem inventar 0%.
 */

import { execFile } from 'node:child_process';
import type { GpuDeviceTelemetry, GpuTelemetry } from '../contracts';

export const NVIDIA_SMI_QUERY_ARGS = [
  '--query-gpu=index,uuid,name,memory.total,memory.used,memory.free,utilization.gpu,utilization.memory,temperature.gpu',
  '--format=csv,noheader,nounits',
];

export interface NvidiaTelemetryOptions {
  readonly execFn?: (
    cmd: string,
    args: readonly string[],
  ) => Promise<{ stdout: string; stderr: string }>;
  readonly observedAt?: string;
}

/**
 * Parser puro de saída CSV de `nvidia-smi`.
 * Formato esperado: `index, uuid, name, memory.total, memory.used, memory.free, utilization.gpu, utilization.memory, temperature.gpu`
 * Converte MiB para bytes (`* 1024 * 1024`). Preserva 0 real como número.
 */
export function parseNvidiaSmiOutput(csvOutput: string): GpuDeviceTelemetry[] {
  if (!csvOutput || typeof csvOutput !== 'string') {
    return [];
  }

  const lines = csvOutput
    .split('\n')
    .map((l) => l.trim())
    .filter((l) => l.length > 0);

  const devices: GpuDeviceTelemetry[] = [];

  for (const line of lines) {
    // Parser CSV tolerante a espaços após vírgula
    const parts = line.split(',').map((p) => p.trim());
    if (parts.length < 8) {
      throw new Error(`[NVIDIA Telemetry] Malformed CSV line: expected at least 8 fields, got ${parts.length} ('${line}')`);
    }

    const index = parseInt(parts[0], 10);
    const uuid = parts[1];
    const name = parts[2];
    const totalMib = parseFloat(parts[3]);
    const usedMib = parseFloat(parts[4]);
    const freeMib = parseFloat(parts[5]);
    const gpuUtil = parseFloat(parts[6]);
    const memUtil = parseFloat(parts[7]);
    const tempCelsius = parts.length > 8 && parts[8] !== '[N/A]' && parts[8] !== '' ? parseFloat(parts[8]) : undefined;

    if (
      isNaN(index) ||
      !uuid ||
      !name ||
      isNaN(totalMib) ||
      isNaN(usedMib) ||
      isNaN(freeMib) ||
      isNaN(gpuUtil) ||
      isNaN(memUtil)
    ) {
      throw new Error(`[NVIDIA Telemetry] Invalid numeric fields in CSV output: '${line}'`);
    }

    const BYTES_PER_MIB = 1024 * 1024;

    devices.push({
      index,
      uuid,
      name,
      memoryTotalBytes: Math.round(totalMib * BYTES_PER_MIB),
      memoryUsedBytes: Math.round(usedMib * BYTES_PER_MIB),
      memoryFreeBytes: Math.round(freeMib * BYTES_PER_MIB),
      gpuUtilizationPercent: Math.min(100, Math.max(0, gpuUtil)),
      memoryUtilizationPercent: Math.min(100, Math.max(0, memUtil)),
      temperatureCelsius: tempCelsius !== undefined && !isNaN(tempCelsius) ? tempCelsius : undefined,
    });
  }

  return devices;
}

function defaultExec(
  cmd: string,
  args: readonly string[],
): Promise<{ stdout: string; stderr: string }> {
  return new Promise((resolve, reject) => {
    execFile(cmd, [...args], { timeout: 3000, windowsHide: true }, (error, stdout, stderr) => {
      if (error) {
        reject(error);
      } else {
        resolve({ stdout, stderr });
      }
    });
  });
}

/**
 * Coleta factual de telemetria de GPUs NVIDIA via `nvidia-smi`.
 */
export async function captureNvidiaTelemetry(
  options: NvidiaTelemetryOptions = {},
): Promise<GpuTelemetry> {
  const {
    execFn = defaultExec,
    observedAt = new Date().toISOString(),
  } = options;

  try {
    const { stdout } = await execFn('nvidia-smi', NVIDIA_SMI_QUERY_ARGS);
    const devices = parseNvidiaSmiOutput(stdout);

    if (devices.length === 0) {
      return {
        status: 'unavailable',
        devices: [],
        observedAt,
      };
    }

    return {
      status: 'available',
      devices,
      observedAt,
    };
  } catch (err: any) {
    const isNotFound = err?.code === 'ENOENT' || err?.message?.includes('not found') || err?.message?.includes('ENOENT');
    if (isNotFound) {
      return {
        status: 'unavailable',
        devices: [],
        observedAt,
        errorDetail: 'nvidia-smi binary not found on system PATH',
      };
    }

    const errorDetail = err instanceof Error ? err.message : String(err);
    return {
      status: 'error',
      devices: [],
      observedAt,
      errorDetail,
    };
  }
}
