// One row per session: what it cost, how much of it was agent-driven, and what could
// not be priced.
//
// [LAW:effects-at-boundaries] Pure. Analysed sessions in, text out; the driver writes it.

import { depthOf } from '../lineage.ts';
import { priceCalls } from '../models.ts';
import type { AnalyzedSession } from '../session.ts';
import { allCalls, billableOf, isSpawned, rollup, rollupWhere } from '../spans.ts';
import { spend } from '../tokens.ts';
import { tsv } from './tsv.ts';

/** A session reduced to the figures that fit on one line.
 *
 * [LAW:types-are-the-program] `usd` and `unpricedTokEq` are siblings in the same row for
 * the reason `PriceTotals` keeps them together: a dollar figure that does not carry what
 * it failed to cover is an answer-shaped void, and a corpus with an unpriced model
 * produces a small confident number that looks exactly like a correct one. Splitting
 * them across two commands, or dropping the remainder because it is usually zero, would
 * put that back. */
export interface ListRow {
  session: string;
  project: string;
  /** ISO instant of the session's first call — sortable as text, unlike a locale date. */
  started: string;
  wallMin: number;
  calls: number;
  spawnedCalls: number;
  maxDepth: number;
  /** input×1 + cacheWrite×1.25 + cacheRead×0.1, plus output. Exact. */
  tokEq: number;
  /** The part of `tokEq` spent in conversations no human read. Exact. */
  spawnedTokEq: number;
  usd: number;
  /** Spend carrying no published rate, so `usd` covers everything except this. */
  unpricedTokEq: number;
}

export function listRow(a: AnalyzedSession): ListRow {
  const callSpans = allCalls(a.tree);
  const pricing = priceCalls(callSpans.map(billableOf));
  const spawned = callSpans.filter(isSpawned);
  return {
    session: a.source.sessionId,
    project: a.workspace.name,
    started: new Date(a.tree.tStart).toISOString(),
    wallMin: Math.round((a.tree.tEnd - a.tree.tStart) / 60_000),
    calls: callSpans.length,
    spawnedCalls: spawned.length,
    maxDepth: callSpans.reduce((m, s) => Math.max(m, depthOf(s.lineage)), 0),
    tokEq: Math.round(spend(rollup(a.tree))),
    spawnedTokEq: Math.round(spend(rollupWhere(a.tree, isSpawned))),
    usd: Number(pricing.usd.toFixed(4)),
    unpricedTokEq: Math.round(pricing.unpricedSpend),
  };
}

/** The column order, which IS the header line.
 *
 * [LAW:one-source-of-truth] One array decides both what the header says and which
 * fields are written, so a column cannot be added to the output without appearing in
 * the header, and the two cannot end up in different orders. */
export const COLUMNS = [
  'session',
  'project',
  'started',
  'wallMin',
  'calls',
  'spawnedCalls',
  'maxDepth',
  'tokEq',
  'spawnedTokEq',
  'usd',
  'unpricedTokEq',
] as const satisfies readonly (keyof ListRow)[];

/** Every field of `ListRow` appears in `COLUMNS` — the direction `satisfies` does not
 * check.
 *
 * [LAW:types-are-the-program] `satisfies readonly (keyof ListRow)[]` proves only that
 * every column is a real field. Adding a field to `ListRow` and forgetting the column
 * would compile, and the field would silently never reach the header or the rows — a
 * column that is absent looks exactly like a column whose value was always zero, which
 * is the answer-shaped void this file warns about for `usd` and `unpricedTokEq`. This
 * asserts the containment the other way, so a missing column fails the build instead of
 * quietly dropping data. */
type MissingColumn = Exclude<keyof ListRow, (typeof COLUMNS)[number]>;
const _everyFieldIsAColumn: MissingColumn extends never ? true : MissingColumn = true;

/** Tab-separated, header first.
 *
 * WHY ONE FORMAT AND NOT A `--json` FLAG. Tabs are already both: `cut -f8`, `sort -k8n`
 * and a spreadsheet all read this, and so does a person. A second format would be a
 * second rendering of the same rows to keep in step — and, per [LAW:no-mode-explosion],
 * a flag nobody has a plan to delete. `trace` is where the structured shape lives, and
 * it is a command rather than a mode for the same reason.
 *
 * `list`'s binding of the shared renderer: the column table above, which carries the
 * compile-time proof that it covers every field of `ListRow`, applied to the escaping
 * and joining rules that `tsv.ts` owns for every command that emits rows. */
export const toTsv = (rows: readonly ListRow[]): string => tsv(COLUMNS, rows);
