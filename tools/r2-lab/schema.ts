/**
 * NEX+ · R2 Local Feasibility Lab
 * Contratos de Evidência Estruturada e Validação — Escopo 0.7B
 */

export interface OnnxFeasibilityProbeEvidence {
  readonly runtime: 'onnxruntime_genai';
  readonly runtimeVersion: string;
  readonly executionProvider: 'cuda' | 'directml' | 'cpu';
  readonly pythonVersion: string;
  readonly os: string;
  readonly gpuName?: string;
  readonly gpuVramBytes?: number;
  readonly modelFixture: string;
  readonly modelPath: string;
  readonly modelSizeBytes: number;
  readonly loadSucceeded: boolean;
  readonly generationSucceeded: boolean;
  readonly generatedText?: string;
  readonly tokensGenerated?: number;
  readonly loadDurationMs: number;
  readonly generationDurationMs: number;
  readonly errorCode?: string;
  readonly errorMessageSanitized?: string;
  readonly observedAt: string; // ISO 8601 UTC
}

export type FeasibilityClassification =
  | 'VIABLE_CUDA'
  | 'VIABLE_DIRECTML'
  | 'NOT_YET_VIABLE';

export function classifyFeasibility(
  evidence: OnnxFeasibilityProbeEvidence,
): FeasibilityClassification {
  if (!evidence.loadSucceeded || !evidence.generationSucceeded) {
    return 'NOT_YET_VIABLE';
  }
  if (evidence.executionProvider === 'cuda') {
    return 'VIABLE_CUDA';
  }
  if (evidence.executionProvider === 'directml') {
    return 'VIABLE_DIRECTML';
  }
  return 'NOT_YET_VIABLE';
}

export function sanitizeErrorMessage(rawMessage?: string): string | undefined {
  if (!rawMessage) return undefined;
  // Remove absolute file system paths or potential token-like substrings
  return rawMessage
    .replace(/[A-Za-z]:\\[\w\\\.-]+/g, '[REDACTED_PATH]')
    .replace(/\b[0-9a-fA-F]{32,}\b/g, '[REDACTED_HEX]')
    .trim();
}
