/**
 * NEX+ · Serialização & Mapeamento de Persistência
 * Escopo 0.85 (Bloco 0.85B)
 */

import { PersistenceInvariantViolationError } from './errors';
import { isCanonicalUtcInstant } from '../invariants';

export function serializeToPgJsonb(val: unknown, fieldName = 'json_field'): string {
  if (val === undefined) {
    throw new PersistenceInvariantViolationError(
      'INVALID_JSON_SERIALIZATION',
      `Cannot serialize undefined value for field '${fieldName}' to JSONB.`
    );
  }

  try {
    const serialized = JSON.stringify(val);
    if (serialized === undefined) {
      throw new Error('JSON.stringify returned undefined');
    }
    return serialized;
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err);
    throw new PersistenceInvariantViolationError(
      'INVALID_JSON_SERIALIZATION',
      `Failed to serialize value for field '${fieldName}' to valid JSON: ${msg}`
    );
  }
}

export function parsePgJsonb<T>(val: unknown): T {
  if (val === null || val === undefined) {
    return val as T;
  }
  if (typeof val === 'string') {
    return JSON.parse(val) as T;
  }
  return val as T;
}

export function formatPgTimestampToUtcInstant(val: unknown): string {
  if (val instanceof Date) {
    return val.toISOString();
  }
  if (typeof val === 'string') {
    if (isCanonicalUtcInstant(val)) {
      return val;
    }
    const d = new Date(val);
    if (!isNaN(d.getTime())) {
      return d.toISOString();
    }
  }
  throw new PersistenceInvariantViolationError(
    'INVALID_TIMESTAMP_DESERIALIZATION',
    `Cannot convert value '${String(val)}' to canonical UTC instant ending with Z.`
  );
}
