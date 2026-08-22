// [LAW:one-source-of-truth] Exact token counts come only from API `usage`
// blocks. Everything below is a labeled ESTIMATE used to attribute what the
// exact totals were spent on; estimates never replace or adjust exact numbers.

/** chars→tokens heuristic for English/code (~4 chars per token). Attribution
 * granularity, not billing accuracy. */
export const estimateTokens = (chars: number): number => Math.round(chars / 4);
