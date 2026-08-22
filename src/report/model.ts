// The report model: the seam between analysis and presentation.
//
// [LAW:locality-or-seam] The seam IS the type. The renderer is a pure function of this
// model and derives no numbers of its own; the producer computes them and nothing
// else. Neither side imports the other — both import this.
//
// [LAW:types-are-the-program] PROJECT.md's honesty rules are encoded here rather than
// left to the renderer's discipline: a cost carries WHICH PROJECTION it is, a label
// carries HOW it was decided, and coverage is a required field. A figure that cannot
// say how it was derived is unrepresentable.
//
// [LAW:one-source-of-truth] The vocabulary below (Usage, Cost, Spawn, Activity, Tier,
// Label) is IMPORTED from the modules that own each concept and re-exported here, so
// the seam and the pipeline cannot end up with two structurally-identical copies that
// drift. It is re-exported so a renderer still needs exactly one import to speak the
// whole model.

import type { Cost, Projection, Usage } from '../tokens.ts';
import type { Spawn } from '../lineage.ts';
import type { Activity, Label, Tier } from '../activity.ts';

export type { Cost, Projection, Usage, Spawn, Activity, Label, Tier };

export interface CallRow {
  index: number;
  ts: number;
  model: string;
  usage: Usage;
  depth: number;
  lineage: readonly Spawn[];
  label: Label;
  tools: ReadonlyArray<{ name: string; summary: string; resultChars: number }>;
}

/** A maximal run of calls over which the cached prefix survives. A new epoch means
 * everything still needed was re-written at 1.25x instead of re-read at 0.1x. */
export interface Epoch {
  index: number;
  startCall: number;
  endCall: number;
  rewrittenTokens: number;
  gapBeforeMs: number;
  excess: Cost;
}

/** One row of any ledger. `share` is of the ledger's own total. */
export interface LedgerRow {
  key: string;
  cost: Cost;
  share: number;
  calls: number;
  /** Optional second dimension, e.g. what share of this row was agent-driven. */
  note: string;
}

export interface Ledger {
  id: string;
  title: string;
  /** What a reader should take from it — one sentence, not a chart caption. */
  lede: string;
  rows: readonly LedgerRow[];
}

/** A specific, priced thing to act on. PROJECT.md: "the report stops being a chart and
 * becomes a punch list." A finding without a price is an observation. */
export interface Finding {
  headline: string;
  detail: string;
  cost: Cost;
  /** Share of the session this finding accounts for, 0..1. */
  shareOfSession: number;
  severity: 'high' | 'medium' | 'note';
}

/** Everything resident in the context window at a given call — the arena view. One
 * band per allocation: born at `bornAtCall`, `tokens` thick, alive until its epoch
 * ends. */
export interface Stratum {
  bornAtCall: number;
  epoch: number;
  tokens: number;
  source: StratumSource;
  label: string;
}

export type StratumSource =
  | 'toolResult'
  | 'userText'
  | 'attachment'
  | 'assistantOutput'
  | 'startup'
  | 'mixed';

export interface FlameNode {
  name: string;
  value: number;
  kind: string;
  activity: Activity | null;
  depth: number;
  children: FlameNode[];
}

/** How much of the session's spend each classification tier accounted for. Required,
 * so a report cannot show percentages without showing their basis. */
export interface Coverage {
  byTier: Record<Tier, number>;
  /** Share of spend with no label at all, 0..1. Rendered even when zero. */
  unclassified: number;
}

export interface Conservation {
  actualCacheRead: number;
  predictedCacheRead: number;
  callsChecked: number;
  callsExact: number;
}

export interface SessionReport {
  sessionId: string;
  project: string;
  startedAt: number;
  endedAt: number;
  model: string;

  usage: Usage;
  total: Cost;
  totalUsd: Cost;

  calls: readonly CallRow[];
  epochs: readonly Epoch[];
  conservation: Conservation;
  coverage: Coverage;

  ledgers: readonly Ledger[];
  findings: readonly Finding[];
  strata: readonly Stratum[];
  flame: FlameNode;

  /** What the session was doing, in one line, for a human scanning a list. */
  synopsis: string;
  /** Parse facts that must stay visible: fan-out, unlinked agents, drift. */
  notes: readonly string[];
}

export interface CorpusReport {
  generatedAt: number;
  sessions: readonly SessionReport[];
  /** Ledgers computed across every session, not per-session. */
  ledgers: readonly Ledger[];
  total: Cost;
  totalUsd: Cost;
  coverage: Coverage;
}
