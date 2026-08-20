/**
 * NEX+ · R2 Local Feasibility Lab
 * Testes Unitários do Schema e Funções Puras — Escopo 0.7B
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import {
  classifyFeasibility,
  sanitizeErrorMessage,
  type OnnxFeasibilityProbeEvidence,
} from '../schema';

describe('NEX+ R2 Feasibility Lab · Schema & Classification (0.7B)', () => {
  const baseEvidence: OnnxFeasibilityProbeEvidence = {
    runtime: 'onnxruntime_genai',
    runtimeVersion: '0.13.1',
    executionProvider: 'directml',
    pythonVersion: '3.14.4',
    os: 'Windows 11 (AMD64)',
    gpuName: 'NVIDIA GeForce RTX 3060',
    gpuVramBytes: 12884901888,
    modelFixture: 'microsoft/Phi-3-mini-4k-instruct-onnx-directml-int4',
    modelPath: 'G:\\Nex+\\models\\phi3',
    modelSizeBytes: 2135857150,
    loadSucceeded: true,
    generationSucceeded: true,
    generatedText: 'NEX R2 OK',
    tokensGenerated: 6,
    loadDurationMs: 3220.84,
    generationDurationMs: 2004.83,
    observedAt: '2026-08-20T02:00:00.000Z',
  };

  it('1. classifyFeasibility retorna VIABLE_DIRECTML para inferência bem-sucedida via DirectML', () => {
    const classification = classifyFeasibility(baseEvidence);
    assert.equal(classification, 'VIABLE_DIRECTML');
  });

  it('2. classifyFeasibility retorna VIABLE_CUDA para inferência bem-sucedida via CUDA', () => {
    const cudaEvidence: OnnxFeasibilityProbeEvidence = {
      ...baseEvidence,
      executionProvider: 'cuda',
    };
    const classification = classifyFeasibility(cudaEvidence);
    assert.equal(classification, 'VIABLE_CUDA');
  });

  it('3. classifyFeasibility retorna NOT_YET_VIABLE se load falhou', () => {
    const failedLoad: OnnxFeasibilityProbeEvidence = {
      ...baseEvidence,
      loadSucceeded: false,
      generationSucceeded: false,
    };
    const classification = classifyFeasibility(failedLoad);
    assert.equal(classification, 'NOT_YET_VIABLE');
  });

  it('4. classifyFeasibility retorna NOT_YET_VIABLE se generation falhou', () => {
    const failedGen: OnnxFeasibilityProbeEvidence = {
      ...baseEvidence,
      loadSucceeded: true,
      generationSucceeded: false,
    };
    const classification = classifyFeasibility(failedGen);
    assert.equal(classification, 'NOT_YET_VIABLE');
  });

  it('5. sanitizeErrorMessage sanitiza caminhos absolutos e tokens hexadecimais', () => {
    const raw = 'Error loading C:\\Path\\To\\Secret\\file.dll with key a1b2c3d4e5f60718293a4b5c6d7e8f90';
    const sanitized = sanitizeErrorMessage(raw);
    assert.equal(sanitized?.includes('C:\\Path'), false);
    assert.equal(sanitized?.includes('[REDACTED_PATH]'), true);
    assert.equal(sanitized?.includes('[REDACTED_HEX]'), true);
  });
});
