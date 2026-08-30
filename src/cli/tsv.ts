// Rows as tab-separated text, header first.
//
// [LAW:effects-at-boundaries] Pure. Rows in, one string out; the driver writes it.
//
// [LAW:decomposition] Its own module because two commands render rows this way and the
// escaping rule below is a rule about TAB-SEPARATED TEXT rather than about sessions or
// about traces. Left in `list.ts`, the second caller either imports from a module named
// for something else or — the outcome that matters — reimplements `cell` and gets it
// subtly wrong, which is a corrupted row rather than an obvious failure.

/** One field, made safe to sit between tabs.
 *
 * A project name containing a tab would corrupt a row, so tabs are replaced with a space
 * rather than escaped: these are display names derived from real directories, and a
 * quoting scheme would oblige every consumer to implement the unquoting.
 *
 * Newlines and carriage returns go the same way, and for a worse reason than tabs. A
 * POSIX directory name may legally contain a newline, and `project` is the last segment
 * of a real one — so an un-stripped `\n` does not merely misplace a field, it ends the
 * row early and starts a second one with the wrong number of columns, turning one record
 * into two malformed ones that every consumer reads as data. */
const cell = (v: string | number): string => String(v).replace(/[\t\r\n]/g, ' ');

/** The column list IS the header line, so a column cannot reach the rows without
 * appearing in the header and the two cannot end up in different orders.
 * [LAW:one-source-of-truth]
 *
 * [LAW:composability] Columns are a VALUE crossing this boundary rather than a table
 * baked into the function, which is what lets one renderer serve `list` and `otlp`
 * instead of there being a `toListTsv` and a `toExportTsv` — a family of names encoding
 * what a parameter carries.
 *
 * [LAW:types-are-the-program] The constraint is `{ [K in keyof R]: string | number }` and
 * not `Record<string, string | number>`. The `Record` form is the stronger-but-false
 * theorem: it demands an index signature, which an ordinary interface does not have, so
 * every row type would need one — and an index signature says "any string is a field of
 * this", which would let `columns` name a column that does not exist and render it as
 * `undefined`. The mapped form says only what is true: every field this row HAS is
 * printable. */
export const header = (columns: readonly string[]): string => columns.join('\t');

export const row = <R extends { [K in keyof R]: string | number }>(
  columns: readonly (keyof R & string)[],
  r: R,
): string => columns.map((c) => cell(r[c])).join('\t');

/** The whole table at once, for a caller that has every row before it writes any.
 *
 * Defined in terms of the two above rather than beside them, so a caller that must stream
 * — `otlp` writes each row as its POST lands, because a batched table is lost entirely if
 * a later session fails — emits exactly the same bytes as one that does not.
 * [LAW:one-source-of-truth] The alternative was the streaming caller rendering a table and
 * slicing the header line back off with `split('\n').slice(1)`, which is this module's job
 * being done badly by someone who could not ask for half of it. */
export const tsv = <R extends { [K in keyof R]: string | number }>(
  columns: readonly (keyof R & string)[],
  rows: readonly R[],
): string => [header(columns), ...rows.map((r) => row(columns, r))].join('\n');
