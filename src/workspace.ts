// Which directory a session's work happened in, and what to call it on a page.
//
// [LAW:one-source-of-truth] A transcript states its project TWICE: as the `cwd` field on
// its own lines, and as the name of the directory Claude Code files it under — the same
// absolute path with every character outside [A-Za-z0-9] flattened to `-`. The slug is a
// DERIVATION of cwd, and a lossy one, so cwd is the original and the only thing worth
// reading. Measured across 302 transcripts on the development corpus,
// `slugify(first cwd) === directory name` held for 301; the exception was a session
// resumed inside a different git worktree, where the two genuinely disagree about which
// directory the work happened in and cwd is the one telling the truth.
//
// WHY NOT RECOVER THE NAME FROM THE SLUG. Because it cannot be done. Flattening is not
// invertible: a directory name may already contain `-`, so `-Users-jdoe-src-my-project`
// is genuinely ambiguous between `src/my/project` and `src/my-project`, and splitting
// this repo's own slug on `-` yields "miser" rather than "cc-miser". Every leaf-recovery
// rule is a guess wearing a parse's clothing. Reading cwd deletes the ambiguity instead
// of dodging it.

/** The last path segment, for POSIX and Windows paths alike.
 *
 * Separator-agnostic on purpose: a transcript is read on the machine that runs the
 * report, not the machine that wrote it, so `node:path`'s platform-specific `basename`
 * would return the whole of `C:\Users\jdoe\proj` when the report runs on macOS. */
const leafName = (path: string): string => path.split(/[/\\]+/).filter(Boolean).pop() ?? path;

/** Where a session's work happened.
 *
 * [LAW:types-are-the-program] Two variants because the two cases hold genuinely
 * different data — an absolute path is not a slug — and `from` says which reading a
 * name came from. Both carry `name`, so a renderer prints a field and never branches;
 * the discriminator is there for anything that needs to know how much the name is worth.
 */
export type Workspace =
  | { from: 'cwd'; path: string; name: string }
  | { from: 'slug'; slug: string; name: string };

/** Resolve a session's workspace from the two things a session knows about itself.
 *
 * [LAW:parse-dont-validate] The one checkpoint where the transcript's optional `cwd` is
 * unwrapped. Downstream signatures take `Workspace`, which always has a `name`, so no
 * renderer, ledger or index ever asks again whether the true path was available.
 *
 * The `slug` arm is the honest floor rather than a fallback that guesses: a transcript
 * carrying no `cwd` on any line leaves us knowing only the flattened path, and printing
 * it unchanged says exactly that much and no more. No transcript in the development
 * corpus took this arm; it exists because a corpus nobody here has looked at may. */
export function workspaceOf(slug: string, cwd: string | null): Workspace {
  return cwd === null
    ? { from: 'slug', slug, name: slug }
    : { from: 'cwd', path: cwd, name: leafName(cwd) };
}

/** Identity for counting and grouping, as opposed to `name` for display.
 *
 * Two checkouts of different projects can share a leaf name — `~/work/api` and
 * `~/oss/api` are both "api" — so counting distinct projects by display name would
 * silently merge them. */
export const workspaceKey = (w: Workspace): string => (w.from === 'cwd' ? w.path : w.slug);
