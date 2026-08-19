/**
 * NEX+ · ExecutionEvidence & Attempt Ledger
 * Processamento e Canonicalização de Evidências — Escopo 0.5 (Bloco 0.5D)
 *
 * Plano de Autoridade (L0).
 * Projeção segura por allowlist, eliminação de segredos em plaintext e canonicalização de fatos.
 */

import type {
  ExecutionSignal,
  ExecutionEvidence,
  ExecutionEvidenceId,
  ExecutionEvidenceKind,
} from './contracts';

/**
 * Projeta um payload bruto retornado pelo executor de acordo com uma allowlist estrita de campos seguros.
 * Se nenhuma allowlist for fornecida ou se for vazia, nenhum campo é preservado (metadata only).
 * Campos fora da allowlist (incluindo senhas, tokens, cookies e chaves de API) são descartados.
 */
export function projectSafePayload(
  raw: unknown,
  allowlist?: readonly string[],
): Readonly<Record<string, unknown>> {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
    return Object.freeze({});
  }

  if (!allowlist || allowlist.length === 0) {
    return Object.freeze({});
  }

  const rawRecord = raw as Record<string, unknown>;
  const projected: Record<string, unknown> = {};

  for (const key of allowlist) {
    if (Object.prototype.hasOwnProperty.call(rawRecord, key) && rawRecord[key] !== undefined) {
      projected[key] = rawRecord[key];
    }
  }

  return Object.freeze(projected);
}

/**
 * Canonicaliza um ExecutionSignal validado em uma ExecutionEvidence canônica de L0.
 * Garante que sinais técnicos genéricos (como exit 0 ou HTTP 200) não sejam promovidos
 * a provas fáticas sem corroboração de efeito.
 */
export function canonicalizeSignalToEvidence(
  evidenceId: ExecutionEvidenceId,
  signal: ExecutionSignal,
  recordedAt: string,
): ExecutionEvidence {
  let evidenceKind: ExecutionEvidenceKind;

  switch (signal.kind) {
    case 'dispatch_confirmed':
      evidenceKind = 'dispatch_confirmed';
      break;
    case 'pre_dispatch_failure':
      evidenceKind = 'pre_dispatch_failure';
      break;
    case 'effect_observed':
      evidenceKind = 'effect_observed';
      break;
    case 'no_effect_verified':
      evidenceKind = 'no_effect_verified';
      break;
    case 'result_verified':
      evidenceKind = 'result_verified';
      break;
    case 'technical_success':
    case 'technical_failure':
    case 'completion_unknown':
    default:
      evidenceKind = 'technical_unproven';
      break;
  }

  return {
    evidenceId,
    attemptId: signal.attemptId,
    signalRefs: [signal.signalId],
    kind: evidenceKind,
    safeFacts: signal.safeMetadata,
    provenance: signal.provenance,
    recordedAt,
  };
}
