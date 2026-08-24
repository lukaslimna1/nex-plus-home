/**
 * NEX+ · Neutral Technical Blob Store Port Interface
 * Escopo 0.86 (Bloco 0.86B · Hardening 0.86B-3)
 *
 * Interface agnóstica de armazenamento de blobs com hashing em streaming O(1),
 * content-addressing (SHA-256), staging atômico e verificação criptográfica ativa.
 */

export interface PutBlobOptions {
  readonly expectedSha256?: string;
  readonly maxBytes?: number;
}

export interface PutBlobResult {
  readonly sha256: string;
  readonly byteSize: number;
  readonly storageKey: string;
  readonly alreadyExisted: boolean;
}

export interface VerifyBlobResult {
  readonly valid: boolean;
  readonly actualSha256?: string;
  readonly expectedSha256?: string;
  readonly actualSize?: number;
  readonly expectedSize?: number;
  readonly error?: string;
}

export interface BlobStore {
  /**
   * Armazena um blob no storage físico com hashing em tempo real e staging seguro.
   */
  putBlob(
    data: Buffer | NodeJS.ReadableStream,
    options?: PutBlobOptions
  ): Promise<PutBlobResult>;

  /**
   * Lê o conteúdo completo de um blob, verificando ativamente seu hash SHA-256.
   */
  getBlob(storageKey: string, expectedSha256?: string): Promise<Buffer>;

  /**
   * Obtém uma stream de leitura do blob físico.
   */
  getBlobStream(storageKey: string, expectedSha256?: string): Promise<NodeJS.ReadableStream>;

  /**
   * Verifica se o blob existe fisicamente no store.
   */
  hasBlob(storageKey: string): Promise<boolean>;

  /**
   * Executa verificação criptográfica de integridade física sobre o blob.
   */
  verifyBlob(
    storageKey: string,
    expectedSha256: string,
    expectedSize?: number
  ): Promise<VerifyBlobResult>;

  /**
   * Lista todas as storage keys físicas presentes no store (para auditoria).
   */
  listStorageKeys(): Promise<string[]>;
}
