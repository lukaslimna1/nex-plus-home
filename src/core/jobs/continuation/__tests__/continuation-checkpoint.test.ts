/**
 * NEX+ · Continuation Checkpoint Contracts & Store
 * Testes Unitários de Invariantes, Derivação Pura e Serialization — Escopo 0.86C-4A
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import type {
  CapabilityRevisionId,
  BindingRevisionId,
  RouteRevisionId,
  DomainEffect,
} from '../../../capabilities/contracts';
import type {
  AttemptId,
  AttemptState,
  DecisionId,
  OutcomeAssessment,
  OutcomeAssessmentId,
} from '../../../execution/contracts';
import type { DecisionMaterialContextId } from '../../../evaluation/contracts';
import type { JobId, JobState } from '../../contracts';

import {
  computeEffectiveDomainMutating,
  createJobCheckpoint,
  validateJobCheckpoint,
  assertJobCheckpointValid,
  assertCanonicalJobCheckpoint,
  normalizeCanonicalUtcInstant,
} from '../invariants';
import {
  serializeJobCheckpoint,
  mapRowToJobCheckpoint,
  parseStrictJobRevision,
  type SerializedJobCheckpointRow,
} from '../serialization';
import {
  JobCheckpointInvariantError,
  JobCheckpointValidationError,
  CorruptedJobCheckpointStorageError,
} from '../errors';
import type { JobCheckpoint, JobCheckpointId } from '../contracts';

describe('0.86C-4A · Continuation Checkpoint — Invariants, Factory & Validation', () => {
  // Helpers para fixtures
  const jobId = 'job_test_4a_001' as JobId;
  const attemptId = 'att_test_4a_001' as AttemptId;
  const decisionId = 'dec_test_4a_001' as DecisionId;
  const outcomeAssessmentId = 'out_test_4a_001' as OutcomeAssessmentId;
  const decisionMaterialContextId = 'dmc_test_4a_001' as DecisionMaterialContextId;
  const capabilityRevisionId = 'cap_rev_1' as CapabilityRevisionId;
  const bindingRevisionId = 'bind_rev_1' as BindingRevisionId;
  const routeRevisionId = 'route_rev_1' as RouteRevisionId;
  const canonicalRecordedAt = '2026-09-29T21:00:00.000Z';

  function createValidJobState(overrides?: Partial<JobState>): JobState {
    return {
      jobId,
      status: 'running',
      revision: 3,
      actor: { kind: 'human', humanId: 'usr_001' },
      materialContextPinId: 'pin_001' as any,
      attemptLineage: [attemptId],
      createdAt: '2026-09-29T20:00:00.000Z',
      updatedAt: '2026-09-29T20:30:00.000Z',
      ...overrides,
    };
  }

  function createValidAttemptState(overrides?: Partial<AttemptState>): AttemptState {
    return {
      attemptId,
      decisionId,
      routeEvaluationId: 'rte_001' as any,
      status: 'succeeded',
      capabilityRevisionId,
      bindingRevisionId,
      routeRevisionId,
      createdAt: '2026-09-29T20:30:00.000Z',
      startedAt: '2026-09-29T20:31:00.000Z',
      finishedAt: '2026-09-29T20:35:00.000Z',
      ...overrides,
    };
  }

  function createValidOutcomeAssessment(overrides?: Partial<OutcomeAssessment>): OutcomeAssessment {
    return {
      assessmentId: outcomeAssessmentId,
      attemptId,
      evidenceRefs: [],
      verdict: 'confirmed_result',
      reasonCode: 'NON_MUTATING_RESULT_VERIFIED',
      assessedAt: canonicalRecordedAt,
      ...overrides,
    };
  }

  describe('1. Derivação Determinística de DomainEffect (INV-12)', () => {
    it('retorna false exclusivamente quando Capability, Binding e Route forem todos "none"', () => {
      const result = computeEffectiveDomainMutating({
        capabilityDomainEffect: 'none',
        bindingDomainEffectAttested: 'none',
        routeDomainEffect: 'none',
      });
      assert.equal(result, false);
    });

    it('retorna true se capabilityDomainEffect for "may_mutate_domain"', () => {
      const result = computeEffectiveDomainMutating({
        capabilityDomainEffect: 'may_mutate_domain',
        bindingDomainEffectAttested: 'none',
        routeDomainEffect: 'none',
      });
      assert.equal(result, true);
    });

    it('retorna true se bindingDomainEffectAttested for "may_mutate_domain"', () => {
      const result = computeEffectiveDomainMutating({
        capabilityDomainEffect: 'none',
        bindingDomainEffectAttested: 'may_mutate_domain',
        routeDomainEffect: 'none',
      });
      assert.equal(result, true);
    });

    it('retorna true se routeDomainEffect for "may_mutate_domain"', () => {
      const result = computeEffectiveDomainMutating({
        capabilityDomainEffect: 'none',
        bindingDomainEffectAttested: 'none',
        routeDomainEffect: 'may_mutate_domain',
      });
      assert.equal(result, true);
    });

    it('rejeita valor inválido com JobCheckpointInvariantError (DOMAIN_EFFECT_INVALID)', () => {
      assert.throws(
        () =>
          computeEffectiveDomainMutating({
            capabilityDomainEffect: 'invalid_effect' as DomainEffect,
            bindingDomainEffectAttested: 'none',
            routeDomainEffect: 'none',
          }),
        (err: unknown) => {
          assert(err instanceof JobCheckpointInvariantError);
          assert.equal(err.code, 'DOMAIN_EFFECT_INVALID');
          return true;
        },
      );
    });
  });

  describe('2. Criação Canônica de JobCheckpoint (createJobCheckpoint)', () => {
    it('cria checkpoint íntegro congelado com directive stop para confirmed_result', () => {
      const job = createValidJobState();
      const attempt = createValidAttemptState();
      const outcome = createValidOutcomeAssessment({ verdict: 'confirmed_result' });

      const chk = createJobCheckpoint({
        checkpointId: 'chk_001' as JobCheckpointId,
        job,
        jobRevision: 3,
        attempt,
        outcomeAssessment: outcome,
        decisionMaterialContextId,
        capabilityRevisionId,
        capabilityDomainEffect: 'none',
        bindingRevisionId,
        bindingDomainEffectAttested: 'none',
        routeRevisionId,
        routeDomainEffect: 'none',
        recordedAt: canonicalRecordedAt,
      });

      assert.equal(chk.checkpointId, 'chk_001');
      assert.equal(chk.jobId, jobId);
      assert.equal(chk.jobRevision, 3);
      assert.equal(chk.attemptId, attemptId);
      assert.equal(chk.outcomeAssessmentId, outcomeAssessmentId);
      assert.equal(chk.continuationDirective, 'stop');
      assert.equal(chk.continuationReasonCode, 'RESULT_CONFIRMED_STOP');
      assert.equal(chk.domainEffectBasis.effectiveIsDomainMutating, false);
      assert(Object.isFrozen(chk));
      assert(Object.isFrozen(chk.domainEffectBasis));
    });

    it('acceptance #7: qualquer base may_mutate_domain + indeterminate produz human_escalation_required', () => {
      const job = createValidJobState();
      const attempt = createValidAttemptState({ status: 'failed' });
      const outcome = createValidOutcomeAssessment({
        verdict: 'indeterminate',
        reasonCode: 'MUTATION_EVIDENCE_CONFLICT',
      });

      const chk = createJobCheckpoint({
        checkpointId: 'chk_002' as JobCheckpointId,
        job,
        jobRevision: 3,
        attempt,
        outcomeAssessment: outcome,
        decisionMaterialContextId,
        capabilityRevisionId,
        capabilityDomainEffect: 'may_mutate_domain',
        bindingRevisionId,
        bindingDomainEffectAttested: 'none',
        routeRevisionId,
        routeDomainEffect: 'none',
        recordedAt: canonicalRecordedAt,
      });

      assert.equal(chk.continuationDirective, 'human_escalation_required');
      assert.equal(chk.continuationReasonCode, 'INDETERMINATE_MUTATION_REQUIRES_HUMAN');
      assert.equal(chk.domainEffectBasis.effectiveIsDomainMutating, true);
    });

    it('acceptance #8: todas as bases none + indeterminate produz new_route_evaluation_required', () => {
      const job = createValidJobState();
      const attempt = createValidAttemptState({ status: 'failed' });
      const outcome = createValidOutcomeAssessment({
        verdict: 'indeterminate',
        reasonCode: 'NON_MUTATING_TECHNICAL_SUCCESS_WITHOUT_RESULT_EVIDENCE',
      });

      const chk = createJobCheckpoint({
        checkpointId: 'chk_003' as JobCheckpointId,
        job,
        jobRevision: 3,
        attempt,
        outcomeAssessment: outcome,
        decisionMaterialContextId,
        capabilityRevisionId,
        capabilityDomainEffect: 'none',
        bindingRevisionId,
        bindingDomainEffectAttested: 'none',
        routeRevisionId,
        routeDomainEffect: 'none',
        recordedAt: canonicalRecordedAt,
      });

      assert.equal(chk.continuationDirective, 'new_route_evaluation_required');
      assert.equal(chk.continuationReasonCode, 'NON_MUTATING_INDETERMINATE_REEVALUATION_ALLOWED');
      assert.equal(chk.domainEffectBasis.effectiveIsDomainMutating, false);
    });

    it('acceptance #13: OutcomeAssessment de outro Attempt é rejeitado estruturalmente', () => {
      const job = createValidJobState();
      const attempt = createValidAttemptState();
      const outcome = createValidOutcomeAssessment({
        attemptId: 'att_other_999' as AttemptId,
      });

      assert.throws(
        () =>
          createJobCheckpoint({
            checkpointId: 'chk_004' as JobCheckpointId,
            job,
            jobRevision: 3,
            attempt,
            outcomeAssessment: outcome,
            decisionMaterialContextId,
            capabilityRevisionId,
            capabilityDomainEffect: 'none',
            bindingRevisionId,
            bindingDomainEffectAttested: 'none',
            routeRevisionId,
            routeDomainEffect: 'none',
            recordedAt: canonicalRecordedAt,
          }),
        (err: unknown) => {
          assert(err instanceof JobCheckpointInvariantError);
          assert.equal(err.code, 'OUTCOME_ASSESSMENT_ATTEMPT_MISMATCH');
          return true;
        },
      );
    });

    it('acceptance #14: Attempt não-terminal (running ou created) não pode gerar checkpoint', () => {
      const job = createValidJobState();
      const attemptRunning = createValidAttemptState({ status: 'running' });
      const outcome = createValidOutcomeAssessment();

      assert.throws(
        () =>
          createJobCheckpoint({
            checkpointId: 'chk_005' as JobCheckpointId,
            job,
            jobRevision: 3,
            attempt: attemptRunning,
            outcomeAssessment: outcome,
            decisionMaterialContextId,
            capabilityRevisionId,
            capabilityDomainEffect: 'none',
            bindingRevisionId,
            bindingDomainEffectAttested: 'none',
            routeRevisionId,
            routeDomainEffect: 'none',
            recordedAt: canonicalRecordedAt,
          }),
        (err: unknown) => {
          assert(err instanceof JobCheckpointInvariantError);
          assert.equal(err.code, 'ATTEMPT_NOT_TERMINAL');
          return true;
        },
      );
    });

    it('acceptance #15: Attempt não pertencente ao Job é rejeitado', () => {
      const job = createValidJobState({ attemptLineage: ['att_different_001' as AttemptId] });
      const attempt = createValidAttemptState();
      const outcome = createValidOutcomeAssessment();

      assert.throws(
        () =>
          createJobCheckpoint({
            checkpointId: 'chk_006' as JobCheckpointId,
            job,
            jobRevision: 3,
            attempt,
            outcomeAssessment: outcome,
            decisionMaterialContextId,
            capabilityRevisionId,
            capabilityDomainEffect: 'none',
            bindingRevisionId,
            bindingDomainEffectAttested: 'none',
            routeRevisionId,
            routeDomainEffect: 'none',
            recordedAt: canonicalRecordedAt,
          }),
        (err: unknown) => {
          assert(err instanceof JobCheckpointInvariantError);
          assert.equal(err.code, 'ATTEMPT_NOT_IN_LINEAGE');
          return true;
        },
      );
    });

    it('acceptance #16: stop não altera JobState', () => {
      const job = createValidJobState({ status: 'running', revision: 5 });
      const originalStatus = job.status;
      const originalRevision = job.revision;
      const attempt = createValidAttemptState();
      const outcome = createValidOutcomeAssessment({ verdict: 'confirmed_result' });

      const chk = createJobCheckpoint({
        checkpointId: 'chk_007' as JobCheckpointId,
        job,
        jobRevision: 5,
        attempt,
        outcomeAssessment: outcome,
        decisionMaterialContextId,
        capabilityRevisionId,
        capabilityDomainEffect: 'none',
        bindingRevisionId,
        bindingDomainEffectAttested: 'none',
        routeRevisionId,
        routeDomainEffect: 'none',
        recordedAt: canonicalRecordedAt,
      });

      assert.equal(chk.continuationDirective, 'stop');
      assert.equal(job.status, originalStatus);
      assert.equal(job.revision, originalRevision);
      assert.notEqual(job.status, 'succeeded');
      assert.notEqual(job.status, 'failed');
      assert.notEqual(job.status, 'cancelled');
    });

    it('rejeita Job em status terminal', () => {
      const job = createValidJobState({ status: 'succeeded' });
      const attempt = createValidAttemptState();
      const outcome = createValidOutcomeAssessment();

      assert.throws(
        () =>
          createJobCheckpoint({
            checkpointId: 'chk_008' as JobCheckpointId,
            job,
            jobRevision: 3,
            attempt,
            outcomeAssessment: outcome,
            decisionMaterialContextId,
            capabilityRevisionId,
            capabilityDomainEffect: 'none',
            bindingRevisionId,
            bindingDomainEffectAttested: 'none',
            routeRevisionId,
            routeDomainEffect: 'none',
            recordedAt: canonicalRecordedAt,
          }),
        (err: unknown) => {
          assert(err instanceof JobCheckpointInvariantError);
          assert.equal(err.code, 'JOB_TERMINAL_INVALID');
          return true;
        },
      );
    });

    it('acceptance #12: jobRevision mismatch falha fechado na criação', () => {
      const job = createValidJobState({ revision: 4 });
      const attempt = createValidAttemptState();
      const outcome = createValidOutcomeAssessment();

      assert.throws(
        () =>
          createJobCheckpoint({
            checkpointId: 'chk_009' as JobCheckpointId,
            job,
            jobRevision: 3, // mismatch com job.revision = 4
            attempt,
            outcomeAssessment: outcome,
            decisionMaterialContextId,
            capabilityRevisionId,
            capabilityDomainEffect: 'none',
            bindingRevisionId,
            bindingDomainEffectAttested: 'none',
            routeRevisionId,
            routeDomainEffect: 'none',
            recordedAt: canonicalRecordedAt,
          }),
        (err: unknown) => {
          assert(err instanceof JobCheckpointInvariantError);
          assert.equal(err.code, 'JOB_REVISION_MISMATCH');
          return true;
        },
      );
    });

    it('rejeita revision IDs divergentes do Attempt', () => {
      const job = createValidJobState();
      const attempt = createValidAttemptState();
      const outcome = createValidOutcomeAssessment();

      assert.throws(
        () =>
          createJobCheckpoint({
            checkpointId: 'chk_010' as JobCheckpointId,
            job,
            jobRevision: 3,
            attempt,
            outcomeAssessment: outcome,
            decisionMaterialContextId,
            capabilityRevisionId: 'cap_divergent' as CapabilityRevisionId,
            capabilityDomainEffect: 'none',
            bindingRevisionId,
            bindingDomainEffectAttested: 'none',
            routeRevisionId,
            routeDomainEffect: 'none',
            recordedAt: canonicalRecordedAt,
          }),
        (err: unknown) => {
          assert(err instanceof JobCheckpointInvariantError);
          assert.equal(err.code, 'CAPABILITY_REVISION_MISMATCH');
          return true;
        },
      );
    });
  });

  describe('3. Revalidação Pura de JobCheckpoint (validateJobCheckpoint)', () => {
    function buildCheckpoint(directive: any = 'stop', reason: string = 'RESULT_CONFIRMED_STOP'): JobCheckpoint {
      const job = createValidJobState();
      const attempt = createValidAttemptState();
      const outcome = createValidOutcomeAssessment();

      return createJobCheckpoint({
        checkpointId: 'chk_val_001' as JobCheckpointId,
        job,
        jobRevision: 3,
        attempt,
        outcomeAssessment: outcome,
        decisionMaterialContextId,
        capabilityRevisionId,
        capabilityDomainEffect: 'none',
        bindingRevisionId,
        bindingDomainEffectAttested: 'none',
        routeRevisionId,
        routeDomainEffect: 'none',
        recordedAt: canonicalRecordedAt,
      });
    }

    it('acceptance #3: directive e reasonCode recomputados coincidem no caso íntegro', () => {
      const chk = buildCheckpoint();
      const job = createValidJobState();
      const attempt = createValidAttemptState();
      const outcome = createValidOutcomeAssessment();

      const validation = validateJobCheckpoint({
        checkpoint: chk,
        job,
        attempt,
        latestOutcomeAssessment: outcome,
      });

      assert.equal(validation.valid, true);
      assert.doesNotThrow(() =>
        assertJobCheckpointValid({
          checkpoint: chk,
          job,
          attempt,
          latestOutcomeAssessment: outcome,
        }),
      );
    });

    it('acceptance #4: directive corrompida / adulterada falha fechado', () => {
      const chk = buildCheckpoint();
      // Forçar directive adulterada
      const corruptedChk: JobCheckpoint = {
        ...chk,
        continuationDirective: 'new_route_evaluation_required',
      };

      const job = createValidJobState();
      const attempt = createValidAttemptState();
      const outcome = createValidOutcomeAssessment();

      const validation = validateJobCheckpoint({
        checkpoint: corruptedChk,
        job,
        attempt,
        latestOutcomeAssessment: outcome,
      });

      assert.equal(validation.valid, false);
      assert.equal(validation.code, 'CONTINUATION_DIRECTIVE_RECOMPUTATION_MISMATCH');
    });

    it('acceptance #5: reasonCode corrompido / adulterado falha fechado', () => {
      const chk = buildCheckpoint();
      const corruptedChk: JobCheckpoint = {
        ...chk,
        continuationReasonCode: 'ADULTERATED_REASON_CODE',
      };

      const job = createValidJobState();
      const attempt = createValidAttemptState();
      const outcome = createValidOutcomeAssessment();

      const validation = validateJobCheckpoint({
        checkpoint: corruptedChk,
        job,
        attempt,
        latestOutcomeAssessment: outcome,
      });

      assert.equal(validation.valid, false);
      assert.equal(validation.code, 'CONTINUATION_DIRECTIVE_RECOMPUTATION_MISMATCH');
    });

    it('acceptance #6: DomainEffectBasis corrompida (effectiveIsDomainMutating mismatch) falha fechado', () => {
      const chk = buildCheckpoint();
      // Corromper a basis: marcar mutating false quando um effect é may_mutate_domain
      const corruptedChk: JobCheckpoint = {
        ...chk,
        domainEffectBasis: {
          ...chk.domainEffectBasis,
          capabilityDomainEffect: 'may_mutate_domain',
          effectiveIsDomainMutating: false, // mismatch com 'may_mutate_domain'
        },
      };

      const job = createValidJobState();
      const attempt = createValidAttemptState({ capabilityRevisionId: chk.domainEffectBasis.capabilityRevisionId });
      const outcome = createValidOutcomeAssessment();

      const validation = validateJobCheckpoint({
        checkpoint: corruptedChk,
        job,
        attempt,
        latestOutcomeAssessment: outcome,
      });

      assert.equal(validation.valid, false);
      assert.equal(validation.code, 'CORRUPTED_DOMAIN_EFFECT_BASIS');
    });

    it('acceptance #9: OutcomeAssessment superseding invalida checkpoint anterior', () => {
      const chk = buildCheckpoint();
      const job = createValidJobState();
      const attempt = createValidAttemptState();
      // Novo outcome emitido para o mesmo attempt com ID diferente
      const supersedingOutcome = createValidOutcomeAssessment({
        assessmentId: 'out_superseding_002' as OutcomeAssessmentId,
        verdict: 'confirmed_result',
      });

      const validation = validateJobCheckpoint({
        checkpoint: chk,
        job,
        attempt,
        latestOutcomeAssessment: supersedingOutcome,
      });

      assert.equal(validation.valid, false);
      assert.equal(validation.code, 'OUTCOME_ASSESSMENT_SUPERSEDED');
      assert.throws(
        () =>
          assertJobCheckpointValid({
            checkpoint: chk,
            job,
            attempt,
            latestOutcomeAssessment: supersedingOutcome,
          }),
        (err: unknown) => {
          assert(err instanceof JobCheckpointValidationError);
          assert.equal(err.code, 'OUTCOME_ASSESSMENT_SUPERSEDED');
          return true;
        },
      );
    });

    it('acceptance #10: Attempt posterior na Job lineage invalida checkpoint', () => {
      const chk = buildCheckpoint();
      // Job agora possui um segundo attempt mais recente na lineage
      const subsequentAttemptId = 'att_test_4a_002' as AttemptId;
      const jobWithNewAttempt = createValidJobState({
        attemptLineage: [attemptId, subsequentAttemptId],
      });
      const attempt = createValidAttemptState();
      const outcome = createValidOutcomeAssessment();

      const validation = validateJobCheckpoint({
        checkpoint: chk,
        job: jobWithNewAttempt,
        attempt,
        latestOutcomeAssessment: outcome,
      });

      assert.equal(validation.valid, false);
      assert.equal(validation.code, 'ATTEMPT_NOT_LATEST_IN_LINEAGE');
    });

    it('acceptance #11: Job terminal invalida checkpoint para continuação', () => {
      const chk = buildCheckpoint();
      const terminalJob = createValidJobState({ status: 'succeeded' });
      const attempt = createValidAttemptState();
      const outcome = createValidOutcomeAssessment();

      const validation = validateJobCheckpoint({
        checkpoint: chk,
        job: terminalJob,
        attempt,
        latestOutcomeAssessment: outcome,
      });

      assert.equal(validation.valid, false);
      assert.equal(validation.code, 'JOB_IS_TERMINAL');
    });

    it('acceptance #12: jobRevision mismatch na revalidação falha fechado', () => {
      const chk = buildCheckpoint();
      const jobRevUpdated = createValidJobState({ revision: 4 }); // checkpoint é revision 3
      const attempt = createValidAttemptState();
      const outcome = createValidOutcomeAssessment();

      const validation = validateJobCheckpoint({
        checkpoint: chk,
        job: jobRevUpdated,
        attempt,
        latestOutcomeAssessment: outcome,
      });

      assert.equal(validation.valid, false);
      assert.equal(validation.code, 'JOB_REVISION_MISMATCH');
    });
  });

  describe('4. Serialization & Trust Boundary (acceptance #19)', () => {
    it('serializeJobCheckpoint descarta propriedades extras e secrets injetados', () => {
      const job = createValidJobState();
      const attempt = createValidAttemptState();
      const outcome = createValidOutcomeAssessment();

      const chk = createJobCheckpoint({
        checkpointId: 'chk_clean_001' as JobCheckpointId,
        job,
        jobRevision: 3,
        attempt,
        outcomeAssessment: outcome,
        decisionMaterialContextId,
        capabilityRevisionId,
        capabilityDomainEffect: 'none',
        bindingRevisionId,
        bindingDomainEffectAttested: 'none',
        routeRevisionId,
        routeDomainEffect: 'none',
        recordedAt: canonicalRecordedAt,
      });

      // Injecao maliciosa em runtime
      const pollutedChk = {
        ...chk,
        extraSecretToken: 'SUPER_SECRET_TOKEN',
        rawExecutionEvidence: { foo: 'bar' },
        __proto__: { injected: true },
      };

      const serialized = serializeJobCheckpoint(pollutedChk as any);

      // Garante que campos extras e segredos nao existem no objeto serializado
      assert.equal((serialized as any).extraSecretToken, undefined);
      assert.equal((serialized as any).rawExecutionEvidence, undefined);
      assert.equal((serialized as any).injected, undefined);

      // Apenas os 16 campos canônicos
      const keys = Object.keys(serialized);
      assert.equal(keys.length, 16);
      assert(keys.includes('checkpoint_id'));
      assert(keys.includes('continuation_directive'));
      assert(keys.includes('continuation_reason_code'));
      assert(keys.includes('effective_is_domain_mutating'));
    });

    it('mapRowToJobCheckpoint desserializa linha válida do PostgreSQL com freeze total', () => {
      const validRow: SerializedJobCheckpointRow = {
        checkpoint_id: 'chk_row_001',
        job_id: 'job_001',
        job_revision: 2,
        attempt_id: 'att_001',
        outcome_assessment_id: 'out_001',
        decision_material_context_id: 'dmc_001',
        capability_revision_id: 'cap_1',
        capability_domain_effect: 'none',
        binding_revision_id: 'bind_1',
        binding_domain_effect_attested: 'none',
        route_revision_id: 'route_1',
        route_domain_effect: 'none',
        effective_is_domain_mutating: false,
        continuation_directive: 'stop',
        continuation_reason_code: 'RESULT_CONFIRMED_STOP',
        recorded_at: canonicalRecordedAt,
      };

      const chk = mapRowToJobCheckpoint(validRow);

      assert.equal(chk.checkpointId, 'chk_row_001');
      assert.equal(chk.jobId, 'job_001');
      assert.equal(chk.continuationDirective, 'stop');
      assert(Object.isFrozen(chk));
      assert(Object.isFrozen(chk.domainEffectBasis));
    });

    it('mapRowToJobCheckpoint falha se effective_is_domain_mutating estiver adulterado no storage', () => {
      const corruptedRow: SerializedJobCheckpointRow = {
        checkpoint_id: 'chk_row_002',
        job_id: 'job_001',
        job_revision: 2,
        attempt_id: 'att_001',
        outcome_assessment_id: 'out_001',
        decision_material_context_id: 'dmc_001',
        capability_revision_id: 'cap_1',
        capability_domain_effect: 'may_mutate_domain',
        binding_revision_id: 'bind_1',
        binding_domain_effect_attested: 'none',
        route_revision_id: 'route_1',
        route_domain_effect: 'none',
        effective_is_domain_mutating: false, // mismatch com may_mutate_domain
        continuation_directive: 'stop',
        continuation_reason_code: 'RESULT_CONFIRMED_STOP',
        recorded_at: canonicalRecordedAt,
      };

      assert.throws(
        () => mapRowToJobCheckpoint(corruptedRow),
        (err: unknown) => {
          assert(err instanceof CorruptedJobCheckpointStorageError);
          assert(err.message.includes('effective_is_domain_mutating'));
          return true;
        },
      );
    });

    it('mapRowToJobCheckpoint falha se directive for inválida no storage', () => {
      const corruptedRow: SerializedJobCheckpointRow = {
        checkpoint_id: 'chk_row_003',
        job_id: 'job_001',
        job_revision: 2,
        attempt_id: 'att_001',
        outcome_assessment_id: 'out_001',
        decision_material_context_id: 'dmc_001',
        capability_revision_id: 'cap_1',
        capability_domain_effect: 'none',
        binding_revision_id: 'bind_1',
        binding_domain_effect_attested: 'none',
        route_revision_id: 'route_1',
        route_domain_effect: 'none',
        effective_is_domain_mutating: false,
        continuation_directive: 'INVALID_DIRECTIVE',
        continuation_reason_code: 'RESULT_CONFIRMED_STOP',
        recorded_at: canonicalRecordedAt,
      };

      assert.throws(
        () => mapRowToJobCheckpoint(corruptedRow),
        (err: unknown) => {
          assert(err instanceof CorruptedJobCheckpointStorageError);
          assert(err.message.includes('continuation_directive'));
          return true;
        },
      );
    });
  });

  describe('5. F-4A-FACTORY-TRUST-01 · Validação Estrita e Fail-Closed da Factory', () => {
    it('rejeita Attempt status "bogus", null, array ou object', () => {
      const job = createValidJobState();
      const outcome = createValidOutcomeAssessment();

      // status bogus
      assert.throws(
        () =>
          createJobCheckpoint({
            checkpointId: 'chk_bad_att_1' as JobCheckpointId,
            job,
            jobRevision: 3,
            attempt: createValidAttemptState({ status: 'bogus' as any }),
            outcomeAssessment: outcome,
            decisionMaterialContextId,
            capabilityRevisionId,
            capabilityDomainEffect: 'none',
            bindingRevisionId,
            bindingDomainEffectAttested: 'none',
            routeRevisionId,
            routeDomainEffect: 'none',
            recordedAt: canonicalRecordedAt,
          }),
        (err: unknown) => {
          assert(err instanceof JobCheckpointInvariantError);
          assert.equal(err.code, 'ATTEMPT_STATUS_INVALID');
          return true;
        },
      );

      // status null
      assert.throws(
        () =>
          createJobCheckpoint({
            checkpointId: 'chk_bad_att_2' as JobCheckpointId,
            job,
            jobRevision: 3,
            attempt: createValidAttemptState({ status: null as any }),
            outcomeAssessment: outcome,
            decisionMaterialContextId,
            capabilityRevisionId,
            capabilityDomainEffect: 'none',
            bindingRevisionId,
            bindingDomainEffectAttested: 'none',
            routeRevisionId,
            routeDomainEffect: 'none',
            recordedAt: canonicalRecordedAt,
          }),
        (err: unknown) => {
          assert(err instanceof JobCheckpointInvariantError);
          assert.equal(err.code, 'ATTEMPT_STATUS_INVALID');
          return true;
        },
      );

      // status array
      assert.throws(
        () =>
          createJobCheckpoint({
            checkpointId: 'chk_bad_att_3' as JobCheckpointId,
            job,
            jobRevision: 3,
            attempt: createValidAttemptState({ status: ['succeeded'] as any }),
            outcomeAssessment: outcome,
            decisionMaterialContextId,
            capabilityRevisionId,
            capabilityDomainEffect: 'none',
            bindingRevisionId,
            bindingDomainEffectAttested: 'none',
            routeRevisionId,
            routeDomainEffect: 'none',
            recordedAt: canonicalRecordedAt,
          }),
        (err: unknown) => {
          assert(err instanceof JobCheckpointInvariantError);
          assert.equal(err.code, 'ATTEMPT_STATUS_INVALID');
          return true;
        },
      );

      // status object
      assert.throws(
        () =>
          createJobCheckpoint({
            checkpointId: 'chk_bad_att_4' as JobCheckpointId,
            job,
            jobRevision: 3,
            attempt: createValidAttemptState({ status: { kind: 'succeeded' } as any }),
            outcomeAssessment: outcome,
            decisionMaterialContextId,
            capabilityRevisionId,
            capabilityDomainEffect: 'none',
            bindingRevisionId,
            bindingDomainEffectAttested: 'none',
            routeRevisionId,
            routeDomainEffect: 'none',
            recordedAt: canonicalRecordedAt,
          }),
        (err: unknown) => {
          assert(err instanceof JobCheckpointInvariantError);
          assert.equal(err.code, 'ATTEMPT_STATUS_INVALID');
          return true;
        },
      );
    });

    it('rejeita Outcome verdict "bogus", vazio ou null', () => {
      const job = createValidJobState();
      const attempt = createValidAttemptState();

      // verdict bogus
      assert.throws(
        () =>
          createJobCheckpoint({
            checkpointId: 'chk_bad_out_1' as JobCheckpointId,
            job,
            jobRevision: 3,
            attempt,
            outcomeAssessment: createValidOutcomeAssessment({ verdict: 'bogus' as any }),
            decisionMaterialContextId,
            capabilityRevisionId,
            capabilityDomainEffect: 'none',
            bindingRevisionId,
            bindingDomainEffectAttested: 'none',
            routeRevisionId,
            routeDomainEffect: 'none',
            recordedAt: canonicalRecordedAt,
          }),
        (err: unknown) => {
          assert(err instanceof JobCheckpointInvariantError);
          assert.equal(err.code, 'OUTCOME_ASSESSMENT_VERDICT_INVALID');
          return true;
        },
      );

      // verdict vazio
      assert.throws(
        () =>
          createJobCheckpoint({
            checkpointId: 'chk_bad_out_2' as JobCheckpointId,
            job,
            jobRevision: 3,
            attempt,
            outcomeAssessment: createValidOutcomeAssessment({ verdict: '' as any }),
            decisionMaterialContextId,
            capabilityRevisionId,
            capabilityDomainEffect: 'none',
            bindingRevisionId,
            bindingDomainEffectAttested: 'none',
            routeRevisionId,
            routeDomainEffect: 'none',
            recordedAt: canonicalRecordedAt,
          }),
        (err: unknown) => {
          assert(err instanceof JobCheckpointInvariantError);
          assert.equal(err.code, 'OUTCOME_ASSESSMENT_VERDICT_INVALID');
          return true;
        },
      );

      // verdict null
      assert.throws(
        () =>
          createJobCheckpoint({
            checkpointId: 'chk_bad_out_3' as JobCheckpointId,
            job,
            jobRevision: 3,
            attempt,
            outcomeAssessment: createValidOutcomeAssessment({ verdict: null as any }),
            decisionMaterialContextId,
            capabilityRevisionId,
            capabilityDomainEffect: 'none',
            bindingRevisionId,
            bindingDomainEffectAttested: 'none',
            routeRevisionId,
            routeDomainEffect: 'none',
            recordedAt: canonicalRecordedAt,
          }),
        (err: unknown) => {
          assert(err instanceof JobCheckpointInvariantError);
          assert.equal(err.code, 'OUTCOME_ASSESSMENT_VERDICT_INVALID');
          return true;
        },
      );
    });

    it('rejeita IDs materiais vazios em Attempt e Revisions mesmo quando coincidem entre si', () => {
      const job = createValidJobState();
      const outcome = createValidOutcomeAssessment();

      // capabilityRevisionId vazio em ambos
      assert.throws(
        () =>
          createJobCheckpoint({
            checkpointId: 'chk_empty_cap_1' as JobCheckpointId,
            job,
            jobRevision: 3,
            attempt: createValidAttemptState({ capabilityRevisionId: '' as any }),
            outcomeAssessment: outcome,
            decisionMaterialContextId,
            capabilityRevisionId: '' as any,
            capabilityDomainEffect: 'none',
            bindingRevisionId,
            bindingDomainEffectAttested: 'none',
            routeRevisionId,
            routeDomainEffect: 'none',
            recordedAt: canonicalRecordedAt,
          }),
        (err: unknown) => {
          assert(err instanceof JobCheckpointInvariantError);
          return true;
        },
      );

      // bindingRevisionId vazio em ambos
      assert.throws(
        () =>
          createJobCheckpoint({
            checkpointId: 'chk_empty_bind_1' as JobCheckpointId,
            job,
            jobRevision: 3,
            attempt: createValidAttemptState({ bindingRevisionId: '' as any }),
            outcomeAssessment: outcome,
            decisionMaterialContextId,
            capabilityRevisionId,
            capabilityDomainEffect: 'none',
            bindingRevisionId: '' as any,
            bindingDomainEffectAttested: 'none',
            routeRevisionId,
            routeDomainEffect: 'none',
            recordedAt: canonicalRecordedAt,
          }),
        (err: unknown) => {
          assert(err instanceof JobCheckpointInvariantError);
          return true;
        },
      );

      // routeRevisionId vazio em ambos
      assert.throws(
        () =>
          createJobCheckpoint({
            checkpointId: 'chk_empty_route_1' as JobCheckpointId,
            job,
            jobRevision: 3,
            attempt: createValidAttemptState({ routeRevisionId: '' as any }),
            outcomeAssessment: outcome,
            decisionMaterialContextId,
            capabilityRevisionId,
            capabilityDomainEffect: 'none',
            bindingRevisionId,
            bindingDomainEffectAttested: 'none',
            routeRevisionId: '' as any,
            routeDomainEffect: 'none',
            recordedAt: canonicalRecordedAt,
          }),
        (err: unknown) => {
          assert(err instanceof JobCheckpointInvariantError);
          return true;
        },
      );
    });

    it('rejeita invalid DomainEffect na factory', () => {
      const job = createValidJobState();
      const attempt = createValidAttemptState();
      const outcome = createValidOutcomeAssessment();

      assert.throws(
        () =>
          createJobCheckpoint({
            checkpointId: 'chk_bad_dom_1' as JobCheckpointId,
            job,
            jobRevision: 3,
            attempt,
            outcomeAssessment: outcome,
            decisionMaterialContextId,
            capabilityRevisionId,
            capabilityDomainEffect: 'invalid_effect' as any,
            bindingRevisionId,
            bindingDomainEffectAttested: 'none',
            routeRevisionId,
            routeDomainEffect: 'none',
            recordedAt: canonicalRecordedAt,
          }),
        (err: unknown) => {
          assert(err instanceof JobCheckpointInvariantError);
          assert.equal(err.code, 'DOMAIN_EFFECT_INVALID');
          return true;
        },
      );
    });

    it('rejeita decisionMaterialContextId vazio ou contendo apenas espaços', () => {
      const job = createValidJobState();
      const attempt = createValidAttemptState();
      const outcome = createValidOutcomeAssessment();

      assert.throws(
        () =>
          createJobCheckpoint({
            checkpointId: 'chk_bad_dmc_1' as JobCheckpointId,
            job,
            jobRevision: 3,
            attempt,
            outcomeAssessment: outcome,
            decisionMaterialContextId: '' as any,
            capabilityRevisionId,
            capabilityDomainEffect: 'none',
            bindingRevisionId,
            bindingDomainEffectAttested: 'none',
            routeRevisionId,
            routeDomainEffect: 'none',
            recordedAt: canonicalRecordedAt,
          }),
        (err: unknown) => {
          assert(err instanceof JobCheckpointInvariantError);
          assert.equal(err.code, 'DECISION_MATERIAL_CONTEXT_INVALID');
          return true;
        },
      );

      assert.throws(
        () =>
          createJobCheckpoint({
            checkpointId: 'chk_bad_dmc_2' as JobCheckpointId,
            job,
            jobRevision: 3,
            attempt,
            outcomeAssessment: outcome,
            decisionMaterialContextId: '   ' as any,
            capabilityRevisionId,
            capabilityDomainEffect: 'none',
            bindingRevisionId,
            bindingDomainEffectAttested: 'none',
            routeRevisionId,
            routeDomainEffect: 'none',
            recordedAt: canonicalRecordedAt,
          }),
        (err: unknown) => {
          assert(err instanceof JobCheckpointInvariantError);
          assert.equal(err.code, 'DECISION_MATERIAL_CONTEXT_INVALID');
          return true;
        },
      );
    });

    it('rejeita Job com status inválido, revision <= 0 ou attemptLineage corrompida', () => {
      const attempt = createValidAttemptState();
      const outcome = createValidOutcomeAssessment();

      // job.status bogus
      assert.throws(
        () =>
          createJobCheckpoint({
            checkpointId: 'chk_bad_job_1' as JobCheckpointId,
            job: createValidJobState({ status: 'bogus' as any }),
            jobRevision: 3,
            attempt,
            outcomeAssessment: outcome,
            decisionMaterialContextId,
            capabilityRevisionId,
            capabilityDomainEffect: 'none',
            bindingRevisionId,
            bindingDomainEffectAttested: 'none',
            routeRevisionId,
            routeDomainEffect: 'none',
            recordedAt: canonicalRecordedAt,
          }),
        (err: unknown) => {
          assert(err instanceof JobCheckpointInvariantError);
          assert.equal(err.code, 'JOB_STATUS_INVALID');
          return true;
        },
      );

      // job.status null
      assert.throws(
        () =>
          createJobCheckpoint({
            checkpointId: 'chk_bad_job_2' as JobCheckpointId,
            job: createValidJobState({ status: null as any }),
            jobRevision: 3,
            attempt,
            outcomeAssessment: outcome,
            decisionMaterialContextId,
            capabilityRevisionId,
            capabilityDomainEffect: 'none',
            bindingRevisionId,
            bindingDomainEffectAttested: 'none',
            routeRevisionId,
            routeDomainEffect: 'none',
            recordedAt: canonicalRecordedAt,
          }),
        (err: unknown) => {
          assert(err instanceof JobCheckpointInvariantError);
          assert.equal(err.code, 'JOB_STATUS_INVALID');
          return true;
        },
      );

      // job.revision zero
      assert.throws(
        () =>
          createJobCheckpoint({
            checkpointId: 'chk_bad_job_3' as JobCheckpointId,
            job: createValidJobState({ revision: 0 }),
            jobRevision: 0,
            attempt,
            outcomeAssessment: outcome,
            decisionMaterialContextId,
            capabilityRevisionId,
            capabilityDomainEffect: 'none',
            bindingRevisionId,
            bindingDomainEffectAttested: 'none',
            routeRevisionId,
            routeDomainEffect: 'none',
            recordedAt: canonicalRecordedAt,
          }),
        (err: unknown) => {
          assert(err instanceof JobCheckpointInvariantError);
          assert.equal(err.code, 'JOB_REVISION_INVALID');
          return true;
        },
      );

      // attemptLineage contendo string vazia
      assert.throws(
        () =>
          createJobCheckpoint({
            checkpointId: 'chk_bad_job_4' as JobCheckpointId,
            job: createValidJobState({ attemptLineage: ['', attemptId] }),
            jobRevision: 3,
            attempt,
            outcomeAssessment: outcome,
            decisionMaterialContextId,
            capabilityRevisionId,
            capabilityDomainEffect: 'none',
            bindingRevisionId,
            bindingDomainEffectAttested: 'none',
            routeRevisionId,
            routeDomainEffect: 'none',
            recordedAt: canonicalRecordedAt,
          }),
        (err: unknown) => {
          assert(err instanceof JobCheckpointInvariantError);
          assert.equal(err.code, 'ATTEMPT_NOT_IN_LINEAGE');
          return true;
        },
      );
    });
  });

  describe('6. F-4A-REVALIDATION-TRUST-01 · Validação Estrutural e Runtime Facts na Revalidação', () => {
    function buildValidCheckpoint(): JobCheckpoint {
      const job = createValidJobState();
      const attempt = createValidAttemptState();
      const outcome = createValidOutcomeAssessment();
      return createJobCheckpoint({
        checkpointId: 'chk_reval_base' as JobCheckpointId,
        job,
        jobRevision: 3,
        attempt,
        outcomeAssessment: outcome,
        decisionMaterialContextId,
        capabilityRevisionId,
        capabilityDomainEffect: 'none',
        bindingRevisionId,
        bindingDomainEffectAttested: 'none',
        routeRevisionId,
        routeDomainEffect: 'none',
        recordedAt: canonicalRecordedAt,
      });
    }

    it('falha fechado com JOB_ID_MISMATCH se checkpoint.jobId for diferente de job.jobId', () => {
      const chk = buildValidCheckpoint();
      const job = createValidJobState({ jobId: 'job_different_999' as JobId });
      const attempt = createValidAttemptState();
      const outcome = createValidOutcomeAssessment();

      const validation = validateJobCheckpoint({
        checkpoint: chk,
        job,
        attempt,
        latestOutcomeAssessment: outcome,
      });

      assert.equal(validation.valid, false);
      assert.equal(validation.code, 'JOB_ID_MISMATCH');
    });

    it('falha fechado com STRUCTURAL_VALIDATION_FAILED para checkpointId vazio', () => {
      const chk = buildValidCheckpoint();
      const badChk = { ...chk, checkpointId: '' as any };
      const job = createValidJobState();
      const attempt = createValidAttemptState();
      const outcome = createValidOutcomeAssessment();

      const validation = validateJobCheckpoint({
        checkpoint: badChk,
        job,
        attempt,
        latestOutcomeAssessment: outcome,
      });

      assert.equal(validation.valid, false);
      assert.equal(validation.code, 'STRUCTURAL_VALIDATION_FAILED');
    });

    it('falha fechado com STRUCTURAL_VALIDATION_FAILED para material context vazio', () => {
      const chk = buildValidCheckpoint();
      const badChk = { ...chk, decisionMaterialContextId: '' as any };
      const job = createValidJobState();
      const attempt = createValidAttemptState();
      const outcome = createValidOutcomeAssessment();

      const validation = validateJobCheckpoint({
        checkpoint: badChk,
        job,
        attempt,
        latestOutcomeAssessment: outcome,
      });

      assert.equal(validation.valid, false);
      assert.equal(validation.code, 'STRUCTURAL_VALIDATION_FAILED');
    });

    it('falha fechado com STRUCTURAL_VALIDATION_FAILED para recordedAt inválido ou sem milissegundos canônicos', () => {
      const chk = buildValidCheckpoint();
      const job = createValidJobState();
      const attempt = createValidAttemptState();
      const outcome = createValidOutcomeAssessment();

      // Timezone diferente de Z
      const badChk1 = { ...chk, recordedAt: '2026-09-29T21:00:00+02:00' as any };
      const val1 = validateJobCheckpoint({
        checkpoint: badChk1,
        job,
        attempt,
        latestOutcomeAssessment: outcome,
      });
      assert.equal(val1.valid, false);
      assert.equal(val1.code, 'STRUCTURAL_VALIDATION_FAILED');

      // Sem fração de milissegundos (.SSSZ) no objeto de checkpoint estrutural
      const badChk2 = { ...chk, recordedAt: '2026-09-29T21:00:00Z' as any };
      const val2 = validateJobCheckpoint({
        checkpoint: badChk2,
        job,
        attempt,
        latestOutcomeAssessment: outcome,
      });
      assert.equal(val2.valid, false);
      assert.equal(val2.code, 'STRUCTURAL_VALIDATION_FAILED');
    });

    it('falha fechado com STRUCTURAL_VALIDATION_FAILED para directive inválida ou reasonCode vazio', () => {
      const chk = buildValidCheckpoint();
      const job = createValidJobState();
      const attempt = createValidAttemptState();
      const outcome = createValidOutcomeAssessment();

      // directive desconhecida
      const badChk1 = { ...chk, continuationDirective: 'bogus_directive' as any };
      const val1 = validateJobCheckpoint({
        checkpoint: badChk1,
        job,
        attempt,
        latestOutcomeAssessment: outcome,
      });
      assert.equal(val1.valid, false);
      assert.equal(val1.code, 'STRUCTURAL_VALIDATION_FAILED');

      // reasonCode vazio
      const badChk2 = { ...chk, continuationReasonCode: '' };
      const val2 = validateJobCheckpoint({
        checkpoint: badChk2,
        job,
        attempt,
        latestOutcomeAssessment: outcome,
      });
      assert.equal(val2.valid, false);
      assert.equal(val2.code, 'STRUCTURAL_VALIDATION_FAILED');
    });

    it('falha fechado com STRUCTURAL_VALIDATION_FAILED para DomainEffectBasis incompleta', () => {
      const chk = buildValidCheckpoint();
      const job = createValidJobState();
      const attempt = createValidAttemptState();
      const outcome = createValidOutcomeAssessment();

      // basis sem routeDomainEffect
      const basisClone = { ...chk.domainEffectBasis };
      delete (basisClone as any).routeDomainEffect;
      const badChk1 = { ...chk, domainEffectBasis: basisClone };
      const val1 = validateJobCheckpoint({
        checkpoint: badChk1,
        job,
        attempt,
        latestOutcomeAssessment: outcome,
      });
      assert.equal(val1.valid, false);
      assert.equal(val1.code, 'STRUCTURAL_VALIDATION_FAILED');

      // basis com revision ID vazio
      const badChk2 = {
        ...chk,
        domainEffectBasis: { ...chk.domainEffectBasis, capabilityRevisionId: '' as any },
      };
      const val2 = validateJobCheckpoint({
        checkpoint: badChk2,
        job,
        attempt,
        latestOutcomeAssessment: outcome,
      });
      assert.equal(val2.valid, false);
      assert.equal(val2.code, 'STRUCTURAL_VALIDATION_FAILED');

      // basis com domain effect inválido
      const badChk3 = {
        ...chk,
        domainEffectBasis: { ...chk.domainEffectBasis, capabilityDomainEffect: 'corrupted' as any },
      };
      const val3 = validateJobCheckpoint({
        checkpoint: badChk3,
        job,
        attempt,
        latestOutcomeAssessment: outcome,
      });
      assert.equal(val3.valid, false);
      assert.equal(val3.code, 'STRUCTURAL_VALIDATION_FAILED');
    });

    it('falha fechado com INVALID_RUNTIME_FACTS para fatos de runtime de Job, Attempt ou Outcome inválidos', () => {
      const chk = buildValidCheckpoint();
      const job = createValidJobState();
      const attempt = createValidAttemptState();
      const outcome = createValidOutcomeAssessment();

      // job com status bogus
      const val1 = validateJobCheckpoint({
        checkpoint: chk,
        job: { ...job, status: 'bogus' as any },
        attempt,
        latestOutcomeAssessment: outcome,
      });
      assert.equal(val1.valid, false);
      assert.equal(val1.code, 'INVALID_RUNTIME_FACTS');

      // attempt com status bogus
      const val2 = validateJobCheckpoint({
        checkpoint: chk,
        job,
        attempt: { ...attempt, status: 'bogus' as any },
        latestOutcomeAssessment: outcome,
      });
      assert.equal(val2.valid, false);
      assert.equal(val2.code, 'INVALID_RUNTIME_FACTS');

      // outcome com verdict bogus
      const val3 = validateJobCheckpoint({
        checkpoint: chk,
        job,
        attempt,
        latestOutcomeAssessment: { ...outcome, verdict: 'bogus' as any },
      });
      assert.equal(val3.valid, false);
      assert.equal(val3.code, 'INVALID_RUNTIME_FACTS');

      // attempt null
      const val4 = validateJobCheckpoint({
        checkpoint: chk,
        job,
        attempt: null as any,
        latestOutcomeAssessment: outcome,
      });
      assert.equal(val4.valid, false);
      assert.equal(val4.code, 'INVALID_RUNTIME_FACTS');
    });
  });

  describe('7. F-4A-SERIALIZATION-STRICT-01 · Parsing Decimal Estrito e Own Properties Guard', () => {
    it('parseStrictJobRevision aceita inteiros seguros >= 1 e rejeita "2junk", "2.5", 0, negativos e formatos espúrios', () => {
      // Aceita
      assert.equal(parseStrictJobRevision(1), 1);
      assert.equal(parseStrictJobRevision(42), 42);
      assert.equal(parseStrictJobRevision('1'), 1);
      assert.equal(parseStrictJobRevision('42'), 42);

      // Rejeita "2junk"
      assert.throws(
        () => parseStrictJobRevision('2junk'),
        (err: unknown) => {
          assert(err instanceof CorruptedJobCheckpointStorageError);
          return true;
        },
      );

      // Rejeita "2.5"
      assert.throws(
        () => parseStrictJobRevision('2.5'),
        (err: unknown) => {
          assert(err instanceof CorruptedJobCheckpointStorageError);
          return true;
        },
      );
      assert.throws(
        () => parseStrictJobRevision(2.5),
        (err: unknown) => {
          assert(err instanceof CorruptedJobCheckpointStorageError);
          return true;
        },
      );

      // Rejeita zero
      assert.throws(
        () => parseStrictJobRevision(0),
        (err: unknown) => {
          assert(err instanceof CorruptedJobCheckpointStorageError);
          return true;
        },
      );
      assert.throws(
        () => parseStrictJobRevision('0'),
        (err: unknown) => {
          assert(err instanceof CorruptedJobCheckpointStorageError);
          return true;
        },
      );

      // Rejeita negativo
      assert.throws(
        () => parseStrictJobRevision(-1),
        (err: unknown) => {
          assert(err instanceof CorruptedJobCheckpointStorageError);
          return true;
        },
      );
      assert.throws(
        () => parseStrictJobRevision('-1'),
        (err: unknown) => {
          assert(err instanceof CorruptedJobCheckpointStorageError);
          return true;
        },
      );

      // Rejeita "+2", "02", " 2 "
      assert.throws(
        () => parseStrictJobRevision('+2'),
        (err: unknown) => {
          assert(err instanceof CorruptedJobCheckpointStorageError);
          return true;
        },
      );
      assert.throws(
        () => parseStrictJobRevision('02'),
        (err: unknown) => {
          assert(err instanceof CorruptedJobCheckpointStorageError);
          return true;
        },
      );
      assert.throws(
        () => parseStrictJobRevision(' 2 '),
        (err: unknown) => {
          assert(err instanceof CorruptedJobCheckpointStorageError);
          return true;
        },
      );

      // Rejeita NaN e Infinity
      assert.throws(
        () => parseStrictJobRevision(NaN),
        (err: unknown) => {
          assert(err instanceof CorruptedJobCheckpointStorageError);
          return true;
        },
      );
      assert.throws(
        () => parseStrictJobRevision(Infinity),
        (err: unknown) => {
          assert(err instanceof CorruptedJobCheckpointStorageError);
          return true;
        },
      );

      // Rejeita arrays e objetos
      assert.throws(
        () => parseStrictJobRevision([2]),
        (err: unknown) => {
          assert(err instanceof CorruptedJobCheckpointStorageError);
          return true;
        },
      );
      assert.throws(
        () => parseStrictJobRevision({ revision: 2 }),
        (err: unknown) => {
          assert(err instanceof CorruptedJobCheckpointStorageError);
          return true;
        },
      );
    });

    it('mapRowToJobCheckpoint rejeita campos materiais herdados de prototype (Object.create)', () => {
      const baseRow: SerializedJobCheckpointRow = {
        checkpoint_id: 'chk_row_proto_1',
        job_id: 'job_001',
        job_revision: 2,
        attempt_id: 'att_001',
        outcome_assessment_id: 'out_001',
        decision_material_context_id: 'dmc_001',
        capability_revision_id: 'cap_1',
        capability_domain_effect: 'none',
        binding_revision_id: 'bind_1',
        binding_domain_effect_attested: 'none',
        route_revision_id: 'route_1',
        route_domain_effect: 'none',
        effective_is_domain_mutating: false,
        continuation_directive: 'stop',
        continuation_reason_code: 'RESULT_CONFIRMED_STOP',
        recorded_at: canonicalRecordedAt,
      };

      // 1. job_revision herdado do prototype
      const protoWithRev = { job_revision: 2 };
      const rowInheritedRev = Object.create(protoWithRev);
      for (const [k, v] of Object.entries(baseRow)) {
        if (k !== 'job_revision') {
          rowInheritedRev[k] = v;
        }
      }

      assert.throws(
        () => mapRowToJobCheckpoint(rowInheritedRev),
        (err: unknown) => {
          assert(err instanceof CorruptedJobCheckpointStorageError);
          assert(err.message.includes("Missing required own property 'job_revision'"));
          return true;
        },
      );

      // 2. checkpoint_id herdado do prototype
      const protoWithChkId = { checkpoint_id: 'chk_inherited' };
      const rowInheritedChkId = Object.create(protoWithChkId);
      for (const [k, v] of Object.entries(baseRow)) {
        if (k !== 'checkpoint_id') {
          rowInheritedChkId[k] = v;
        }
      }

      assert.throws(
        () => mapRowToJobCheckpoint(rowInheritedChkId),
        (err: unknown) => {
          assert(err instanceof CorruptedJobCheckpointStorageError);
          assert(err.message.includes("Missing required own property 'checkpoint_id'"));
          return true;
        },
      );
    });

    it('mapRowToJobCheckpoint rejeita propriedades próprias inesperadas (unexpected own keys / allowlist estrita)', () => {
      const validRow: SerializedJobCheckpointRow = {
        checkpoint_id: 'chk_row_unexp',
        job_id: 'job_001',
        job_revision: 2,
        attempt_id: 'att_001',
        outcome_assessment_id: 'out_001',
        decision_material_context_id: 'dmc_001',
        capability_revision_id: 'cap_1',
        capability_domain_effect: 'none',
        binding_revision_id: 'bind_1',
        binding_domain_effect_attested: 'none',
        route_revision_id: 'route_1',
        route_domain_effect: 'none',
        effective_is_domain_mutating: false,
        continuation_directive: 'stop',
        continuation_reason_code: 'RESULT_CONFIRMED_STOP',
        recorded_at: canonicalRecordedAt,
      };

      const rowWithMaliciousKey = {
        ...validRow,
        injected_column: 'DROP TABLE nex_jobs',
      };

      assert.throws(
        () => mapRowToJobCheckpoint(rowWithMaliciousKey as any),
        (err: unknown) => {
          assert(err instanceof CorruptedJobCheckpointStorageError);
          assert(err.message.includes("Unexpected own property 'injected_column'"));
          return true;
        },
      );
    });
  });

  describe('8. F-4A-ROUNDTRIP-TIME-01 · Normalização e Round-Trip Temporal (.SSSZ)', () => {
    it('normaliza determinísticamente timestamps sem fração, .1Z, .12Z e .123Z para formato canônico fixo YYYY-MM-DDTHH:mm:ss.SSSZ', () => {
      const job = createValidJobState();
      const attempt = createValidAttemptState();
      const outcome = createValidOutcomeAssessment();

      // 1. Sem fração
      const chk0 = createJobCheckpoint({
        checkpointId: 'chk_time_0' as JobCheckpointId,
        job,
        jobRevision: 3,
        attempt,
        outcomeAssessment: outcome,
        decisionMaterialContextId,
        capabilityRevisionId,
        capabilityDomainEffect: 'none',
        bindingRevisionId,
        bindingDomainEffectAttested: 'none',
        routeRevisionId,
        routeDomainEffect: 'none',
        recordedAt: '2026-09-29T21:00:00Z',
      });
      assert.equal(chk0.recordedAt, '2026-09-29T21:00:00.000Z');

      // 2. Com .1Z (1 casa)
      const chk1 = createJobCheckpoint({
        checkpointId: 'chk_time_1' as JobCheckpointId,
        job,
        jobRevision: 3,
        attempt,
        outcomeAssessment: outcome,
        decisionMaterialContextId,
        capabilityRevisionId,
        capabilityDomainEffect: 'none',
        bindingRevisionId,
        bindingDomainEffectAttested: 'none',
        routeRevisionId,
        routeDomainEffect: 'none',
        recordedAt: '2026-09-29T21:00:00.1Z',
      });
      assert.equal(chk1.recordedAt, '2026-09-29T21:00:00.100Z');

      // 3. Com .12Z (2 casas)
      const chk2 = createJobCheckpoint({
        checkpointId: 'chk_time_2' as JobCheckpointId,
        job,
        jobRevision: 3,
        attempt,
        outcomeAssessment: outcome,
        decisionMaterialContextId,
        capabilityRevisionId,
        capabilityDomainEffect: 'none',
        bindingRevisionId,
        bindingDomainEffectAttested: 'none',
        routeRevisionId,
        routeDomainEffect: 'none',
        recordedAt: '2026-09-29T21:00:00.12Z',
      });
      assert.equal(chk2.recordedAt, '2026-09-29T21:00:00.120Z');

      // 4. Com .123Z (3 casas)
      const chk3 = createJobCheckpoint({
        checkpointId: 'chk_time_3' as JobCheckpointId,
        job,
        jobRevision: 3,
        attempt,
        outcomeAssessment: outcome,
        decisionMaterialContextId,
        capabilityRevisionId,
        capabilityDomainEffect: 'none',
        bindingRevisionId,
        bindingDomainEffectAttested: 'none',
        routeRevisionId,
        routeDomainEffect: 'none',
        recordedAt: '2026-09-29T21:00:00.123Z',
      });
      assert.equal(chk3.recordedAt, '2026-09-29T21:00:00.123Z');
    });

    it('round-trip puro entre serializeJobCheckpoint e mapRowToJobCheckpoint preserva igualdade exata', () => {
      const timestamps = [
        '2026-09-29T21:00:00Z',
        '2026-09-29T21:00:00.1Z',
        '2026-09-29T21:00:00.12Z',
        '2026-09-29T21:00:00.123Z',
      ];

      for (let i = 0; i < timestamps.length; i++) {
        const rawTime = timestamps[i];
        const job = createValidJobState();
        const attempt = createValidAttemptState();
        const outcome = createValidOutcomeAssessment();

        const chk = createJobCheckpoint({
          checkpointId: `chk_rt_${i}` as JobCheckpointId,
          job,
          jobRevision: 3,
          attempt,
          outcomeAssessment: outcome,
          decisionMaterialContextId,
          capabilityRevisionId,
          capabilityDomainEffect: 'none',
          bindingRevisionId,
          bindingDomainEffectAttested: 'none',
          routeRevisionId,
          routeDomainEffect: 'none',
          recordedAt: rawTime,
        });

        const row = serializeJobCheckpoint(chk);
        const rehydrated = mapRowToJobCheckpoint(row);

        assert.deepEqual(rehydrated, chk);
        assert.equal(rehydrated.recordedAt, normalizeCanonicalUtcInstant(rawTime));
        assert(rehydrated.recordedAt.endsWith('.SSSZ') === false);
        assert(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/.test(rehydrated.recordedAt));
      }
    });

    it('rejeita timezone diferente de Z na factory e normalização', () => {
      const job = createValidJobState();
      const attempt = createValidAttemptState();
      const outcome = createValidOutcomeAssessment();

      assert.throws(
        () =>
          createJobCheckpoint({
            checkpointId: 'chk_bad_tz_1' as JobCheckpointId,
            job,
            jobRevision: 3,
            attempt,
            outcomeAssessment: outcome,
            decisionMaterialContextId,
            capabilityRevisionId,
            capabilityDomainEffect: 'none',
            bindingRevisionId,
            bindingDomainEffectAttested: 'none',
            routeRevisionId,
            routeDomainEffect: 'none',
            recordedAt: '2026-09-29T21:00:00+02:00',
          }),
        (err: unknown) => {
          assert(err instanceof JobCheckpointInvariantError);
          assert.equal(err.code, 'TIMESTAMP_INVALID');
          return true;
        },
      );

      assert.throws(
        () => normalizeCanonicalUtcInstant('2026-09-29T21:00:00-03:00'),
        (err: unknown) => {
          assert(err instanceof JobCheckpointInvariantError);
          assert.equal(err.code, 'TIMESTAMP_INVALID');
          return true;
        },
      );
    });
  });
});
