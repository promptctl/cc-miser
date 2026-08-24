// Output survives a pipe.
//
// WHY THIS TEST CANNOT RUN IN PROCESS. Every other command test drives `run` or `main`
// with captured streams, which proves what the tool INTENDED to write. This one is about
// what a reader on the other end of a pipe actually receives, and the two diverged: with
// `process.exit(code)` at the bottom of main.ts, `miser trace | jq` delivered exactly
// 65,536 bytes of an 798,808-byte document — one pipe buffer — and died on unfinished
// JSON, while the same command redirected to a file was whole. Writing to a pipe is
// non-blocking, so the process terminated with the rest still queued. Nothing observable
// from inside the process differs between the two cases, so only a real subprocess with
// a real pipe can hold the line.
//
// [LAW:behavior-not-structure] Asserted as "a consumer reads the whole document", not as
// "main.ts sets process.exitCode" — a different fix for the same contract passes this.
//
// WHY IT NEEDS A REAL CORPUS. The failure only appears past the first buffer, so a
// fixture small enough to fit in 64 KB would pass against the broken code. It skips
// loudly rather than silently for the reason corpus-smoke.test.ts gives: a test that
// quietly does nothing reports success for work that never ran.

import { describe, expect, test } from 'bun:test';
import { rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { chooseCorpus } from './corpus.ts';

const PIPE_BUFFER = 65_536;
const CLI = join(import.meta.dirname, '..', 'src', 'cli', 'main.ts');

const choice = chooseCorpus(process.env);
if (choice.kind === 'skip') console.log(`pipe integrity check SKIPPED: ${choice.why}`);

/** Run the CLI as a real child process with stdout on a pipe, as a shell would. */
async function piped(args: readonly string[]): Promise<{ out: string; code: number }> {
  const proc = Bun.spawn(['bun', 'run', CLI, ...args], { stdout: 'pipe', stderr: 'pipe' });
  const out = await new Response(proc.stdout).text();
  return { out, code: await proc.exited };
}

describe.skipIf(choice.kind === 'skip')('a document written to a pipe arrives whole', () => {
  const root = choice.kind === 'scan' ? choice.root : '';

  test('trace survives a pipe larger than one buffer', async () => {
    const { out, code } = await piped(['trace', '--projects', root, '--limit', '6']);
    expect(code).toBe(0);
    // Without the volume there is nothing to truncate, and the test would pass on the
    // broken code — so the premise is asserted, not assumed.
    expect(out.length).toBeGreaterThan(PIPE_BUFFER);
    // The whole point: a consumer can parse it. Truncation shows up here first.
    const doc = JSON.parse(out);
    expect(doc.sessions.length).toBeGreaterThan(0);
  }, 120_000);

  test('the piped bytes are the bytes a file redirect receives', async () => {
    // Against a FILE, not against a second pipe: two truncated streams truncate at the
    // same buffer boundary and match each other perfectly, so comparing pipe to pipe
    // would have passed on the broken code. A regular-file write blocks, which is
    // exactly why the bug never showed up under `> out.json`.
    const args = ['trace', '--projects', root, '--limit', '6'];
    const path = join(tmpdir(), `miser-pipe-${Date.now()}.json`);
    const redirect = Bun.spawn(['sh', '-c', `bun run ${CLI} ${args.join(' ')} > ${path} 2>/dev/null`]);
    expect(await redirect.exited).toBe(0);
    const onDisk = await Bun.file(path).text();

    const { out } = await piped(args);
    expect(out.length).toBeGreaterThan(PIPE_BUFFER);
    expect(out.length).toBe(onDisk.length);
    rmSync(path, { force: true });
  }, 120_000);

  test('an exit code still reaches the shell through the pipe', async () => {
    expect((await piped(['badcommand'])).code).toBe(2);
    expect((await piped(['list', '--projects', root, '--session', 'nomatchxyz'])).code).toBe(3);
  }, 120_000);
});
