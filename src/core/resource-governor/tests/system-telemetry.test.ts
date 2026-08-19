/**
 * NEX+ · Resource Governor & Local Runtime Lifecycle
 * Testes Unitários de Telemetria de Sistema — Escopo 0.6 (Fase A)
 *
 * Cenários A1 a A5: RAM, CPU delta, amostras inválidas e independência de loadavg.
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import type { CpuCoreSample } from '../contracts';
import {
  calculateCpuUtilization,
  captureSystemTelemetry,
} from '../telemetry/system';

describe('NEX+ Resource Governor · System Telemetry (Fase A)', () => {
  // A1. RAM total/free/used coerentes
  it('A1. RAM total/free/used coerentes', async () => {
    const total = 32 * 1024 * 1024 * 1024; // 32 GiB
    const free = 12 * 1024 * 1024 * 1024;  // 12 GiB

    const telemetry = await captureSystemTelemetry({
      sampleDelayMs: 0,
      totalMemFn: () => total,
      freeMemFn: () => free,
      sampler: () => [],
    });

    assert.equal(telemetry.status, 'available');
    assert.equal(telemetry.totalRamBytes, total);
    assert.equal(telemetry.freeRamBytes, free);
    assert.equal(telemetry.usedRamBytes, total - free);
  });

  // A2. CPU delta com idle total → 0%
  it('A2. CPU delta com idle total → 0%', () => {
    const sampleA: CpuCoreSample[] = [
      { model: 'CPU', speed: 3000, times: { user: 100, nice: 0, sys: 50, idle: 1000, irq: 0 } },
      { model: 'CPU', speed: 3000, times: { user: 100, nice: 0, sys: 50, idle: 1000, irq: 0 } },
    ];

    // Avançou apenas idle (+500 em cada core), zero tempo ativo
    const sampleB: CpuCoreSample[] = [
      { model: 'CPU', speed: 3000, times: { user: 100, nice: 0, sys: 50, idle: 1500, irq: 0 } },
      { model: 'CPU', speed: 3000, times: { user: 100, nice: 0, sys: 50, idle: 1500, irq: 0 } },
    ];

    const util = calculateCpuUtilization(sampleA, sampleB);
    assert.equal(util, 0);
  });

  // A3. CPU delta parcial → percentual esperado
  it('A3. CPU delta parcial → percentual esperado', () => {
    const sampleA: CpuCoreSample[] = [
      { model: 'CPU', speed: 3000, times: { user: 0, nice: 0, sys: 0, idle: 0, irq: 0 } },
    ];

    // Total delta = 100 ticks. Active = 40 (user: 30, sys: 10). Idle = 60. -> 40%
    const sampleB: CpuCoreSample[] = [
      { model: 'CPU', speed: 3000, times: { user: 30, nice: 0, sys: 10, idle: 60, irq: 0 } },
    ];

    const util = calculateCpuUtilization(sampleA, sampleB);
    assert.equal(util, 40);
  });

  // A4. amostra CPU inválida não fabrica valor
  it('A4. amostra CPU inválida não fabrica valor', () => {
    const validSample: CpuCoreSample[] = [
      { model: 'CPU', speed: 3000, times: { user: 10, nice: 0, sys: 10, idle: 100, irq: 0 } },
    ];

    // Amostras com contagem de cores incompatível
    const mismatchedSample: CpuCoreSample[] = [
      ...validSample,
      { model: 'CPU', speed: 3000, times: { user: 10, nice: 0, sys: 10, idle: 100, irq: 0 } },
    ];

    assert.equal(calculateCpuUtilization(validSample, mismatchedSample), undefined);
    assert.equal(calculateCpuUtilization([], []), undefined);
    assert.equal(calculateCpuUtilization(null as any, validSample), undefined);
  });

  // A5. adapter não usa loadavg como autoridade de CPU
  it('A5. adapter calcula CPU via sampler de deltas sem depender de loadavg', async () => {
    let callCount = 0;
    const samplerMock = (): CpuCoreSample[] => {
      callCount++;
      if (callCount === 1) {
        return [{ model: 'CPU', speed: 3000, times: { user: 100, nice: 0, sys: 50, idle: 1000, irq: 0 } }];
      }
      return [{ model: 'CPU', speed: 3000, times: { user: 150, nice: 0, sys: 50, idle: 1050, irq: 0 } }];
    };

    const telemetry = await captureSystemTelemetry({
      sampleDelayMs: 10,
      sampler: samplerMock,
      sleepFn: async () => {}, // Instant sleep
      totalMemFn: () => 16000,
      freeMemFn: () => 8000,
    });

    assert.equal(telemetry.status, 'available');
    assert.equal(callCount, 2);
    // Delta total = 100 (user +50, sys 0, idle +50). Active = 50. Util = 50%
    assert.equal(telemetry.cpuUtilizationPercent, 50);
  });
});
