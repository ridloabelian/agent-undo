import type { DryRunDiff } from '../types.js';

/**
 * Generates a readable unified line diff between two text snapshots.
 */
export function createUnifiedTextDiff(
  label: string,
  beforeText: string | null,
  afterText: string | null,
): string {
  const beforeLines = beforeText === null ? [] : beforeText.split('\n');
  const afterLines = afterText === null ? [] : afterText.split('\n');

  const header = [
    `--- ${beforeText === null ? '/dev/null' : `a/${label}`}`,
    `+++ ${afterText === null ? '/dev/null' : `b/${label}`}`,
  ];

  // Bound LCS matrix size for very large payloads so diffing remains instant.
  if (beforeLines.length * afterLines.length > 250_000) {
    const summaryLines = [
      `@@ -1,${beforeLines.length} +1,${afterLines.length} @@`,
      ...beforeLines.slice(0, 20).map((line) => `-${line}`),
      ...(beforeLines.length > 20 ? ['-... (truncated)'] : []),
      ...afterLines.slice(0, 20).map((line) => `+${line}`),
      ...(afterLines.length > 20 ? ['+... (truncated)'] : []),
    ];
    return [...header, ...summaryLines].join('\n');
  }

  const m = beforeLines.length;
  const n = afterLines.length;
  const dp: number[][] = Array.from({ length: m + 1 }, () =>
    Array<number>(n + 1).fill(0),
  );

  for (let i = m - 1; i >= 0; i -= 1) {
    for (let j = n - 1; j >= 0; j -= 1) {
      if (beforeLines[i] === afterLines[j]) {
        dp[i]![j] = 1 + (dp[i + 1]?.[j + 1] ?? 0);
      } else {
        dp[i]![j] = Math.max(dp[i + 1]?.[j] ?? 0, dp[i]?.[j + 1] ?? 0);
      }
    }
  }

  const diffBody: string[] = [];
  let i = 0;
  let j = 0;
  while (i < m && j < n) {
    if (beforeLines[i] === afterLines[j]) {
      diffBody.push(` ${beforeLines[i] ?? ''}`);
      i += 1;
      j += 1;
    } else if ((dp[i + 1]?.[j] ?? 0) >= (dp[i]?.[j + 1] ?? 0)) {
      diffBody.push(`-${beforeLines[i] ?? ''}`);
      i += 1;
    } else {
      diffBody.push(`+${afterLines[j] ?? ''}`);
      j += 1;
    }
  }

  while (i < m) {
    diffBody.push(`-${beforeLines[i] ?? ''}`);
    i += 1;
  }
  while (j < n) {
    diffBody.push(`+${afterLines[j] ?? ''}`);
    j += 1;
  }

  return [
    ...header,
    `@@ -${m === 0 ? 0 : 1},${m} +${n === 0 ? 0 : 1},${n} @@`,
    ...diffBody,
  ].join('\n');
}

/**
 * Fallback dry-run diff for tools that do not supply a custom previewDiff hook.
 */
export function generateDefaultDiff(
  toolName: string,
  args: Record<string, unknown>,
  reversible: boolean,
  reversibilityNote: string,
): DryRunDiff {
  const formattedArgs = JSON.stringify(args, null, 2);
  const lines = formattedArgs.split('\n').map((line) => `+ ${line}`);
  return {
    title: `Call ${toolName}`,
    operation: 'execute',
    target: toolName,
    before: null,
    after: args,
    unifiedDiff: [
      `--- tool/${toolName} (current)`,
      `+++ tool/${toolName} (proposed)`,
      ...lines,
    ].join('\n'),
    reversible,
    reversibilityNote,
  };
}
