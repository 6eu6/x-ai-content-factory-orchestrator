/**
 * Brain — public surface
 *
 * The "mind" of the system: a real retrieval-augmented memory that learns from
 * outcomes (inward), ingests niche patterns (outward), and forgets noise
 * (pruning). Generation is grounded in this brain so output is on-brand and
 * original, not generic.
 */

export { embed, embedMany, embeddingsEnabled, EMBEDDING_DIM } from './embed';
export { remember, reinforce, contradict, recordOutcome, markUsed, type MemoryKind, type RememberInput } from './store';
export { recall, recallBrainContext, type Recalled, type RecallOptions } from './retrieve';
export { pruneBrain, type PruneReport } from './prune';
