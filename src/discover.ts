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
  /** The project directory's slug: the project's absolute path with each `/` flattened
   * to `-`, e.g. `-Users-you-code-cc-miser`. Rendered through `projectLabel` rather
   * than shown raw — it is a whole filesystem path, not a name. */
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
