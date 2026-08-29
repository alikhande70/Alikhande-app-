export {
  buildResearchSafeFinalEvaluation,
  EVALUATION_COMPOSITION_VERSION,
  type EvaluationCompositionAudit,
  type FinalEvaluationPopulation,
  projectResearchSafeEvaluationPopulation,
  type ResearchSafeEvaluationAnalysisPlan,
  type ResearchSafeFinalEvaluationPolicy,
  type ResearchSafeFinalEvaluationResult,
  type ResearchSafeProjectionAudit,
} from './evaluation-composition.js';
export type { LockedHoldoutAccessReceipt } from './leakage-window-guard.js';
export {
  buildLockedHoldoutEvaluation,
  LOCKED_HOLDOUT_EVALUATION_VERSION,
  type LockedHoldoutEvaluationAudit,
  type LockedHoldoutEvaluationResult,
  type LockedHoldoutPopulationSeal,
  sealLockedHoldoutPopulation,
} from './locked-holdout-evaluation.js';
