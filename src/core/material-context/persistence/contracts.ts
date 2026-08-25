/**
 * NEX+ · Portas de Persistência de Material Context Pin
 * Escopo 0.86 (Bloco 0.86B · Checkpoint 0.86B-4)
 */

import type { MaterialContextPin, MaterialContextPinId } from '../contracts';

export interface MaterialContextStore {
  /**
   * Persiste atomicamente o MaterialContextPin (header + items relacionais ordenados).
   * Lança erro caso o pinId já exista (append-only) ou se houver violação de integridade.
   */
  savePin(pin: MaterialContextPin): Promise<MaterialContextPin>;

  /**
   * Recupera o MaterialContextPin pelo seu identificador com items ordenados por position.
   * Retorna null se não encontrado.
   */
  getPin(pinId: MaterialContextPinId): Promise<MaterialContextPin | null>;

  /**
   * Verifica a existência de um pin pelo seu identificador.
   */
  hasPin(pinId: MaterialContextPinId): Promise<boolean>;
}
