/**
 * NEX+ · Artifact Blob Store Port Interface
 * Escopo 0.85 (Bloco 0.85C · Re-export do Port Neutro de Storage 0.86B-3)
 */

import type {
  BlobStore,
  PutBlobOptions,
  PutBlobResult,
  VerifyBlobResult,
} from '../../storage/blob-store';

export type {
  BlobStore,
  PutBlobOptions,
  PutBlobResult,
  VerifyBlobResult,
};

export type ArtifactBlobStore = BlobStore;
