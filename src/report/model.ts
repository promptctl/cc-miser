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

import type { Basis, Cost, Projection, Size, Usage } from '../tokens.ts';

/** Re-exported as a VALUE, not just a type, so the renderer keeps needing exactly one
 * import to speak the whole model.
 *
 * It is the one constructor a renderer legitimately calls: `PriceTotals` carries `usd`
 * as a bare number because that is the type the arithmetic is done in, and this is what
 * stamps the projection onto it at the moment it becomes something a person reads. The
 * alternative — a `totalUsd: Cost` sitting beside `pricing.usd` — would be two
 * representations of one dollar figure, free to drift. [LAW:one-source-of-truth] */
export { usdCost } from '../tokens.ts';
import type { Spawn } from '../lineage.ts';
import type { Activity, Label, Tier } from '../activity.ts';
import type { OutputTotals } from '../output.ts';
import type { PriceTotals, TokenizerFit } from '../models.ts';
import type { Workspace } from '../workspace.ts';

export type {
  Basis,
  Cost,
  Projection,
  Size,
  Usage,
  Spawn,
  Activity,
  Label,
  Tier,
  OutputTotals,
  PriceTotals,
  TokenizerFit,
  Workspace,
};

/** What the report was able to calibrate and price, stated as data rather than left for
 * a reader to infer from an absence.
 *
 * [LAW:one-source-of-truth] The per-model coefficients reach the page from here — the
 * same fits the arithmetic used, not a transcription of them into prose. A table of
 * coefficients a human retypes into a caption is a second copy with a schedule. */
export interface Calibration {
  /** One row per model the corpus calibrated, with the held-out error that says how far
   * to trust it. */
  rows: readonly (TokenizerFit & { model: string })[];
  /** Every model id the calibration corpus contained, including the ones that produced
   * no row — the denominator for "what share of models did we manage to calibrate". */
  seen: readonly string[];
  /** Where the price catalogue's numbers came from and as of when. */
  priceSource: string;
}

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
  /** The source that contributed the most CHARACTERS to this band.
   *
   * An earlier version marked a band `mixed` the moment two sources disagreed, which
   * meant almost every band: a call's arrivals nearly always include the previous
   * call's assistant output alongside whatever else came in. The arena rendered as one
   * flat colour and said nothing about what was resident. Dominance by character count
   * is the answer to "what is this band mostly", which is the question the picture is
   * being asked. */
  source: StratumSource;
  /** What share of the band the dominant source accounts for, 0..1. Carried so the
   * simplification above stays visible: a 51% dominance is not the same claim as 98%. */
  sourceShare: number;
  label: string;
}

export type StratumSource =
  | 'toolResult'
  | 'userText'
  | 'attachment'
  | 'assistantOutput'
  | 'startup'
  /** No arrival explains this band. The honesty bucket, not a blend. */
  | 'unattributed';

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

/** How much of the context-window arena rests on exact numbers rather than estimates.
 *
 * Required alongside `Coverage`, and for the same reason: the arena mixes one arrival
 * the API sizes exactly (assistant output) with three we reconstruct from characters,
 * and a picture that does not say which is which invites the reader to trust all of it
 * equally. [LAW:types-are-the-program] */
export interface ArenaBasis {
  exactTokens: number;
  estimatedTokens: number;
  /** Share of arena tokens taken straight from an API `usage` block, 0..1. */
  exactShare: number;
}

export interface SessionReport {
  sessionId: string;
  /** Where the work happened, carried as the resolved identity rather than the raw
   * directory slug. A slug is a whole filesystem path with its separators flattened, so
   * a renderer handed one has no way to reach a project name without guessing at an
   * inverse that does not exist. [LAW:parse-dont-validate] */
  workspace: Workspace;
  startedAt: number;
  endedAt: number;
  model: string;

  usage: Usage;
  total: Cost;
  /** Dollars AND the spend no rate card covered.
   *
   * [LAW:types-are-the-program] There is deliberately no bare `totalUsd` beside this. A
   * renderer that wants the money has to hold the gap in the same hand, so a page can
   * never show a confident dollar figure for a corpus half of whose models it could not
   * price. The `usd` Projection tag is applied where the number reaches the page. */
  pricing: PriceTotals;

  calls: readonly CallRow[];
  epochs: readonly Epoch[];
  conservation: Conservation;
  coverage: Coverage;
  arenaBasis: ArenaBasis;
  /** What the output tokens bought — visible text and tool calls, or reasoning. */
  output: OutputTotals;

  ledgers: readonly Ledger[];
  findings: readonly Finding[];
  strata: readonly Stratum[];
  flame: FlameNode;

  /** What the session was doing, in one line, for a human scanning a list. */
  synopsis: string;
  /** Parse facts that must stay visible: fan-out, unlinked agents, drift. */
  notes: readonly string[];
}

/** Which sessions the page is built from, against how many exist.
 *
 * [FRAMING:representation] The page is a map of a corpus, and it used to headline itself
 * "Every session" / "The whole account" while rendering a filtered sample — on the
 * development corpus, 24 of 271 sessions, with a line band that excluded 57% of all
 * transcript lines and excluded them from the LONG end, which is where the spend is. A
 * caption that overstates coverage in the direction of the money is the worst version of
 * a wrong map, and on a corpus nobody has looked at there is no way to notice.
 *
 * Carried as data so the masthead is DERIVED from the selection rather than asserted
 * beside it. [LAW:one-source-of-truth] The selector writes `criteria`; nothing
 * downstream restates a coverage claim in prose that a change to the filters could
 * silently falsify. */
export interface Selection {
  /** Sessions discovered under the projects root. */
  discovered: number;
  /** Sessions actually analyzed and rendered here. */
  rendered: number;
  /** Every filter applied, in the selector's own words, with what each one cost.
   * Empty only if the selector applied nothing at all. */
  criteria: readonly string[];
}

export interface CorpusReport {
  generatedAt: number;
  sessions: readonly SessionReport[];
  /** What this page covers, and what it left out. */
  selection: Selection;
  /** Ledgers computed across every session, not per-session. */
  ledgers: readonly Ledger[];
  total: Cost;
  pricing: PriceTotals;
  /** What the corpus taught the estimator, and what the rates rest on. */
  calibration: Calibration;
  coverage: Coverage;
  /** Output split across every session, so the reasoning share is a corpus fact rather
   * than an anecdote from whichever session is on screen. */
  output: OutputTotals;
}
