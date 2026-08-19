/**
 * NEX+ · Resource Governor & Local Runtime Lifecycle
 * Telemetria de Sistema Operacional (node:os) — Escopo 0.6 (Fase A)
 *
 * Coleta factual de RAM e cálculo de utilização de CPU via delta de tempos por core.
 * Não utiliza os.loadavg() no Windows. Não cria daemons ou loops infinitos.
 */

import os from 'node:os';
import type { CpuCoreSample, SystemTelemetry } from '../contracts';

export interface SystemTelemetryOptions {
  readonly sampleDelayMs?: number;
  readonly sampler?: () => CpuCoreSample[];
  readonly totalMemFn?: () => number;
  readonly freeMemFn?: () => number;
  readonly sleepFn?: (ms: number) => Promise<void>;
  readonly observedAt?: string;
}

/**
 * Função pura de cálculo de utilização média de CPU entre duas amostras de `os.cpus()`.
 * Retorna percentual de 0 a 100, ou `undefined` se as amostras forem inválidas ou inconsistentes.
 */
export function calculateCpuUtilization(
  sampleA: readonly CpuCoreSample[],
  sampleB: readonly CpuCoreSample[],
): number | undefined {
  if (!Array.isArray(sampleA) || !Array.isArray(sampleB)) {
    return undefined;
  }
  if (sampleA.length === 0 || sampleA.length !== sampleB.length) {
    return undefined;
  }

  let totalDeltaAllCores = 0;
  let idleDeltaAllCores = 0;

  for (let i = 0; i < sampleA.length; i++) {
    const a = sampleA[i];
    const b = sampleB[i];

    if (!a?.times || !b?.times) {
      return undefined;
    }

    const totalA = a.times.user + a.times.nice + a.times.sys + a.times.idle + a.times.irq;
    const totalB = b.times.user + b.times.nice + b.times.sys + b.times.idle + b.times.irq;

    const totalDelta = totalB - totalA;
    const idleDelta = b.times.idle - a.times.idle;

    if (totalDelta < 0 || idleDelta < 0) {
      return undefined;
    }

    totalDeltaAllCores += totalDelta;
    idleDeltaAllCores += idleDelta;
  }

  if (totalDeltaAllCores <= 0) {
    return 0;
  }

  const activeDelta = totalDeltaAllCores - idleDeltaAllCores;
  const percent = (activeDelta / totalDeltaAllCores) * 100;

  // Clamp entre 0 e 100
  return Math.min(100, Math.max(0, Math.round(percent * 100) / 100));
}

function defaultSleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function defaultSampler(): CpuCoreSample[] {
  return os.cpus().map((core) => ({
    model: core.model,
    speed: core.speed,
    times: {
      user: core.times.user,
      nice: core.times.nice,
      sys: core.times.sys,
      idle: core.times.idle,
      irq: core.times.irq,
    },
  }));
}

/**
 * Coleta factual de telemetria do sistema (RAM e CPU).
 * Permite injeção de samplers e timers para testes determinísticos.
 */
export async function captureSystemTelemetry(
  options: SystemTelemetryOptions = {},
): Promise<SystemTelemetry> {
  const {
    sampleDelayMs = 50,
    sampler = defaultSampler,
    totalMemFn = os.totalmem,
    freeMemFn = os.freemem,
    sleepFn = defaultSleep,
    observedAt = new Date().toISOString(),
  } = options;

  try {
    const totalRamBytes = totalMemFn();
    const freeRamBytes = freeMemFn();
    const usedRamBytes = Math.max(0, totalRamBytes - freeRamBytes);

    const sample1 = sampler();
    const logicalCpuCount = Array.isArray(sample1) ? sample1.length : os.cpus().length;

    let cpuUtilizationPercent: number | undefined;

    if (sampleDelayMs > 0 && Array.isArray(sample1) && sample1.length > 0) {
      await sleepFn(sampleDelayMs);
      const sample2 = sampler();
      cpuUtilizationPercent = calculateCpuUtilization(sample1, sample2);
    }

    return {
      status: 'available',
      totalRamBytes,
      freeRamBytes,
      usedRamBytes,
      logicalCpuCount,
      cpuUtilizationPercent,
      observedAt,
    };
  } catch (err) {
    const errorDetail = err instanceof Error ? err.message : String(err);
    return {
      status: 'error',
      totalRamBytes: 0,
      freeRamBytes: 0,
      usedRamBytes: 0,
      logicalCpuCount: 0,
      observedAt,
      errorDetail,
    };
  }
}
