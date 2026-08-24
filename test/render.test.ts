// residencyCheck's four-way branch exists specifically to fix two previously-shipped
// bugs: a vacuous 0-of-0 "exact" badge, and conflating "no root calls" with "every call
// opened its own epoch". [LAW:behavior-not-structure] These pin the four states — and
// the priority between them (rootCalls === 0 checked before callsChecked === 0) — so a
// future edit to the branch order can't silently reintroduce either bug.

import { expect, test, describe } from 'bun:test';
import { residencyCheck } from '../src/report/render.ts';
import type { Conservation } from '../src/report/model.ts';

const cons = (overrides: Partial<Conservation>): Conservation => ({
  actualCacheRead: 1000,
  predictedCacheRead: 1000,
  callsChecked: 4,
  callsExact: 4,
  rootCalls: 5,
  ...overrides,
});

describe('residencyCheck', () => {
  test('no-calls: a root conversation with zero API calls gets its own honest state', () => {
    const html = residencyCheck(cons({ rootCalls: 0, callsChecked: 0, callsExact: 0 }));
    expect(html).toContain('check note');
    expect(html).toContain('No root calls in this session');
    // The exact false claim this state exists to avoid: no call opened an epoch here,
    // because there were no calls at all.
    expect(html).not.toContain('opened its own epoch');
  });

  test('no-predictable: calls exist but every one opened its own epoch', () => {
    const html = residencyCheck(cons({ rootCalls: 3, callsChecked: 0, callsExact: 0 }));
    expect(html).toContain('check note');
    expect(html).toContain('No predictable calls in this session');
    expect(html).toContain('opened its own epoch');
    // Distinct from the no-calls state, even though callsChecked is 0 in both.
    expect(html).not.toContain('No root calls');
  });

  test('exact: every predictable call matched — the real "ok" badge', () => {
    const html = residencyCheck(cons({ rootCalls: 4, callsChecked: 4, callsExact: 4 }));
    expect(html).toContain('check ok');
    expect(html).toContain('Residency reconstruction is exact');
    expect(html).toContain('agree on <b>4');
    expect(html).toContain('4</b> predictable calls');
  });

  test('mismatch: at least one predictable call disagreed — the "warn" badge', () => {
    const html = residencyCheck(cons({ rootCalls: 4, callsChecked: 4, callsExact: 3 }));
    expect(html).toContain('check warn');
    expect(html).toContain('Residency reconstruction does not reconcile');
  });

  test('rootCalls === 0 takes priority over callsChecked === 0', () => {
    // Both conditions are simultaneously true for a zero-call root conversation
    // (callsChecked reduces from an empty array too); the no-calls narration must win,
    // not the no-predictable one, or the panel states a cause ("every call opened its
    // own epoch") that didn't happen.
    const html = residencyCheck(cons({ rootCalls: 0, callsChecked: 0, callsExact: 0 }));
    expect(html).toContain('No root calls in this session');
  });
});
