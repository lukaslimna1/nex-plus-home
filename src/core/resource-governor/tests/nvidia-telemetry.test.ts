/**
 * NEX+ · Resource Governor & Local Runtime Lifecycle
 * Testes Unitários de Telemetria NVIDIA GPU — Escopo 0.6 (Fase A)
 *
 * Cenários A6 a A10: Parsers single/multi GPU, ausência de binário, outputs malformados e zero real.
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import {
  captureNvidiaTelemetry,
  parseNvidiaSmiOutput,
} from '../telemetry/nvidia';

describe('NEX+ Resource Governor · NVIDIA GPU Telemetry (Fase A)', () => {
  // A6. parser NVIDIA single GPU
  it('A6. parser NVIDIA single GPU', () => {
    const csv = `0, GPU-12345678-abcd-ef01-2345-6789abcdef01, NVIDIA GeForce RTX 4090, 24564, 4096, 20468, 15, 22, 54\n`;
    const devices = parseNvidiaSmiOutput(csv);

    assert.equal(devices.length, 1);
    assert.equal(devices[0].index, 0);
    assert.equal(devices[0].uuid, 'GPU-12345678-abcd-ef01-2345-6789abcdef01');
    assert.equal(devices[0].name, 'NVIDIA GeForce RTX 4090');
    assert.equal(devices[0].memoryTotalBytes, 24564 * 1024 * 1024);
    assert.equal(devices[0].memoryUsedBytes, 4096 * 1024 * 1024);
    assert.equal(devices[0].memoryFreeBytes, 20468 * 1024 * 1024);
    assert.equal(devices[0].gpuUtilizationPercent, 15);
    assert.equal(devices[0].memoryUtilizationPercent, 22);
    assert.equal(devices[0].temperatureCelsius, 54);
  });

  // A7. parser NVIDIA múltiplas GPUs
  it('A7. parser NVIDIA múltiplas GPUs', () => {
    const csv = [
      `0, GPU-aaa, RTX 4090, 24564, 2000, 22564, 10, 8, 48`,
      `1, GPU-bbb, RTX 3090, 24576, 12000, 12576, 85, 60, 72`,
    ].join('\n');

    const devices = parseNvidiaSmiOutput(csv);
    assert.equal(devices.length, 2);
    assert.equal(devices[0].uuid, 'GPU-aaa');
    assert.equal(devices[1].uuid, 'GPU-bbb');
    assert.equal(devices[1].gpuUtilizationPercent, 85);
  });

  // A8. nvidia-smi ausente → unavailable
  it('A8. nvidia-smi ausente → unavailable', async () => {
    const telemetry = await captureNvidiaTelemetry({
      execFn: async () => {
        const err: any = new Error('spawn nvidia-smi ENOENT');
        err.code = 'ENOENT';
        throw err;
      },
    });

    assert.equal(telemetry.status, 'unavailable');
    assert.equal(telemetry.devices.length, 0);
  });

  // A9. output NVIDIA malformado → erro explícito
  it('A9. output NVIDIA malformado → erro explícito', async () => {
    // Parser direto lança erro em linha com campos insuficientes
    assert.throws(() => {
      parseNvidiaSmiOutput('invalid, format, only_three_fields');
    }, /Malformed CSV line/);

    // captureNvidiaTelemetry captura o erro e retorna status 'error'
    const telemetry = await captureNvidiaTelemetry({
      execFn: async () => ({ stdout: 'invalid, format, only_three_fields', stderr: '' }),
    });

    assert.equal(telemetry.status, 'error');
    assert.ok(telemetry.errorDetail?.includes('Malformed CSV line'));
  });

  // A10. zero real de utilização permanece 0 e não unknown
  it('A10. zero real de utilização permanece 0 e não unknown', () => {
    const csv = `0, GPU-zero, RTX 4090, 24564, 500, 24064, 0, 0, [N/A]\n`;
    const devices = parseNvidiaSmiOutput(csv);

    assert.equal(devices.length, 1);
    assert.equal(devices[0].gpuUtilizationPercent, 0);
    assert.equal(devices[0].memoryUtilizationPercent, 0);
    assert.equal(devices[0].temperatureCelsius, undefined); // [N/A] tratado como undefined
  });
});
