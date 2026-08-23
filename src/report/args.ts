// What the report driver was told on the command line.
//
// [LAW:decomposition] Its own module rather than a few functions inside `generate.ts`,
// because `generate.ts` is a SCRIPT: it calls `main()` at the top level, so importing
// anything from it runs a full corpus scan as a side effect of the import. A test that
// wanted to check the argument rules got a report of the developer's own machine — the
// exact machine-dependence this file's ticket exists to remove. Parsing a command line
// is a separate, pure job, and separating it is what makes it checkable.

export const USAGE = 'usage: report [--projects <dir>] [--limit <n>]';

export interface Args {
  /** An explicit projects root, or null to use this machine's Claude Code directory. */
  projects: string | null;
  /** How many sessions to analyze. */
  limit: number;
}

const DEFAULTS: Args = { projects: null, limit: 24 };

const positiveInt = (flag: string, raw: string): number => {
  const value = Number(raw);
  if (!Number.isInteger(value) || value < 1)
    throw new Error(`\`${flag}\` needs a positive whole number, got \`${raw}\`. ${USAGE}`);
  return value;
};

/** How an argument is recognised, as a TABLE.
 *
 * [LAW:dataflow-not-control-flow] A new option is a new ROW, in the same idiom
 * `ORIGIN_RULES` uses in `calls.ts`, rather than another arm of a growing `if`. */
const FLAGS: Record<string, (value: string) => Partial<Args>> = {
  '--projects': (value) => ({ projects: value }),
  '--limit': (value) => ({ limit: positiveInt('--limit', value) }),
};

/** [LAW:parse-dont-validate] The one crossing where a string array becomes `Args`.
 * Everything downstream takes `Args` and never re-inspects `process.argv`.
 *
 * [LAW:no-silent-failure] An unrecognised or value-less flag THROWS. Ignoring one is how
 * a person points the tool at an archive with a typo'd flag, gets a full report built
 * from their own home directory instead, and has no reason to doubt it. */
export function readArgs(argv: readonly string[]): Args {
  let args = DEFAULTS;
  for (let i = 0; i < argv.length; i += 2) {
    const flag = argv[i]!;
    const read = FLAGS[flag];
    if (!read) throw new Error(`unrecognised argument \`${flag}\`. ${USAGE}`);
    const value = argv[i + 1];
    if (value === undefined) throw new Error(`\`${flag}\` needs a value. ${USAGE}`);
    args = { ...args, ...read(value) };
  }
  return args;
}
