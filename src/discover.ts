// Find every session transcript on disk, paired with the subagent transcripts that
// belong to it.
//
// [LAW:effects-at-boundaries] The filesystem edge of the pipeline. This module reads
// directory entries and file metadata and nothing else — it never opens a transcript.
// Everything above it is a pure function of the paths this hands out.

import { readdirSync, statSync, existsSync } from 'node:fs';
import { join } from 'node:path';

/** A spawned conversation's two files, both known to exist.
 *
 * [LAW:parse-dont-validate] The type is the proof of pairing. A meta file with no
 * transcript (or the reverse) cannot be represented here at all — it comes back as an
 * `unpaired` string on the session, so nothing downstream needs to re-check that both
 * halves are present, and nothing is silently dropped either. */
export interface SubagentSource {
  agentId: string;
  transcriptPath: string;
  metaPath: string;
}

export interface SessionSource {
  /** The project directory's name, which Claude Code derives from the project's absolute
   * path by flattening every character outside `[A-Za-z0-9]` to `-`.
   *
   * A whole filesystem path, not a project name, and NEVER shown to a person: the
   * flattening is lossy and has no inverse. `workspaceOf` in `workspace.ts` turns this
   * plus the transcript's own `cwd` into something displayable. Kept here because it is
   * the only identity available before a file has been opened, which is what the
   * per-project scoping below runs on. */
  project: string;
  sessionId: string;
  /** The main conversation's JSONL. */
  path: string;
  bytes: number;
  /** Last-modified epoch ms, for since-date scoping and incremental work later. */
  mtime: number;
  subagents: readonly SubagentSource[];
  /** Subagent files missing their other half, named rather than skipped.
   * [LAW:no-silent-failure] */
  unpaired: readonly string[];
}

const SESSION_ID = /^(.+)\.jsonl$/;
const AGENT_FILE = /^agent-(.+?)(\.meta\.json|\.jsonl)$/;

/** Claude Code's own transcript directory, for the machine this is running on.
 *
 * [LAW:no-silent-failure] A missing home variable THROWS. The previous
 * `join(process.env.HOME ?? '', '.claude', 'projects')` turned an unset HOME into the
 * root `/.claude/projects` — a real-looking path that fails much later, at a `readdir`
 * that names the wrong thing, rather than at the assumption that actually broke. HOME is
 * unset on Windows, where `USERPROFILE` is the equivalent, so both are consulted before
 * giving up. (Reasoned from the variable's absence; not observed on a Windows machine.)
 */
function defaultProjectsRoot(env: Record<string, string | undefined>): string {
  const home = env.HOME || env.USERPROFILE;
  if (!home)
    throw new Error(
      'cannot locate the Claude Code projects directory: neither HOME nor USERPROFILE is ' +
        'set. Pass the directory explicitly with --projects <dir>.',
    );
  return join(home, '.claude', 'projects');
}

/** Where to scan, given whatever the caller was told on the command line.
 *
 * Overridable because the default is correct on a normal machine and useless on the ones
 * that matter: an export, an archive, a mounted volume, or a second Claude installation.
 * [LAW:no-mode-explosion] One knob, and it is a VALUE — a path — rather than a mode:
 * there is exactly one code path, and `--projects` changes what flows down it. The
 * default is computed lazily so an explicit root works on a machine with no HOME at all.
 *
 * [LAW:effects-at-boundaries] `env` is a parameter, so this is a pure function of its
 * inputs and testable without mutating the process environment. */
export const projectsRoot = (
  explicit: string | null,
  env: Record<string, string | undefined>,
): string => explicit ?? defaultProjectsRoot(env);

/** The subagent transcripts filed under one session.
 *
 * The directory is FLAT — every descendant of the session lands here side by side,
 * regardless of who spawned it. Reconstructing the actual tree is `forest.ts`'s job
 * and needs the file contents; discovery only pairs each agent's two files. */
function readSubagents(sessionDir: string): Pick<SessionSource, 'subagents' | 'unpaired'> {
  const dir = join(sessionDir, 'subagents');
  if (!existsSync(dir)) return { subagents: [], unpaired: [] };

  const halves = new Map<string, { transcript?: string; meta?: string }>();
  for (const name of readdirSync(dir)) {
    const m = AGENT_FILE.exec(name);
    if (!m) continue;
    const [, agentId, ext] = m;
    const entry = halves.get(agentId!) ?? {};
    if (ext === '.jsonl') entry.transcript = join(dir, name);
    else entry.meta = join(dir, name);
    halves.set(agentId!, entry);
  }

  const subagents: SubagentSource[] = [];
  const unpaired: string[] = [];
  for (const [agentId, h] of halves) {
    if (h.transcript && h.meta)
      subagents.push({ agentId, transcriptPath: h.transcript, metaPath: h.meta });
    else
      unpaired.push(
        `${agentId}: ${h.meta ? 'meta present, transcript missing' : 'transcript present, meta missing'}`,
      );
  }
  return { subagents, unpaired };
}

/** Walk a `~/.claude/projects` tree and yield one source per session.
 *
 * [LAW:composability] No filter parameters. Scoping a scan is `discoverSessions(root)
 * .filter(byProject(/cc-miser/))` — variability as a predicate VALUE crossing one
 * boundary, so a future scope ("bigger than 1MB", "touched this week", "has
 * subagents") is a new expression at the call site rather than a new option here.
 * Filtering on file metadata is cheap because nothing has been opened yet. */
export function discoverSessions(projectsRoot: string): SessionSource[] {
  const out: SessionSource[] = [];
  for (const project of readdirSync(projectsRoot, { withFileTypes: true })) {
    if (!project.isDirectory()) continue;
    const projectDir = join(projectsRoot, project.name);
    for (const entry of readdirSync(projectDir, { withFileTypes: true })) {
      const m = entry.isFile() ? SESSION_ID.exec(entry.name) : null;
      if (!m) continue;
      const sessionId = m[1]!;
      const path = join(projectDir, entry.name);
      const st = statSync(path);
      out.push({
        project: project.name,
        sessionId,
        path,
        bytes: st.size,
        mtime: st.mtimeMs,
        ...readSubagents(join(projectDir, sessionId)),
      });
    }
  }
  return out;
}

// Ready-made predicates, so the common scopes are values rather than prose at each
// call site. Any combination is `xs.filter(a).filter(b)`.
export const byProject =
  (re: RegExp) =>
  (s: SessionSource): boolean =>
    re.test(s.project);

export const since =
  (epochMs: number) =>
  (s: SessionSource): boolean =>
    s.mtime >= epochMs;

export const hasSpawns = (s: SessionSource): boolean => s.subagents.length > 0;
