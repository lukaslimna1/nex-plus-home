/**
 * NEX+ · Route Eligibility, Selection & Escalation
 * Barrel Export Público — Escopo 0.5 (Bloco 0.5E)
 */

export * from './contracts';
export {
  DispatchAdmissionNotFoundError,
  DispatchAdmissionConflictError,
  DispatchAdmissionAlreadyConsumedError,
} from './admission-authority';
export * from './route-evaluation';
export {
  evaluateDecision,
  buildAttemptCreatedEvent,
  type EvaluateDecisionParams,
  type BuildAttemptCreatedEventParams,
  type CapabilityRegistryStore,
} from './selection';
export * from './continuation';
