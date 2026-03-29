// Public orchestration entrypoints for the intelligence pipeline.
// Re-exports only stable surfaces — not prefilter, summarizer, or source adapters.

export { runCollector, type CollectorOptions } from './collector';
export { selectTopSignals, buildDigestMessage } from './digest';
export {
  runLifecycle,
  updateLifecycle,
  update_rfc_status,
  type LifecycleTransition,
} from './lifecycle';
