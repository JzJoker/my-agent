export const MAX_OUTPUT = 30_000; // cap tool output so it doesn't blow the context window

// Middle-truncate: for file reads / generic content where the head and tail both matter.
export const truncate = (s: string) =>
  s.length <= MAX_OUTPUT
    ? s
    : `${s.slice(0, MAX_OUTPUT / 2)}\n…[truncated ${s.length - MAX_OUTPUT} chars]…\n${s.slice(-MAX_OUTPUT / 2)}`;

// Tail-truncate: keep the LAST `max` chars. For command output, results and
// errors live at the end, so the tail is the part worth keeping.
export const tailTruncate = (
  s: string,
  max = MAX_OUTPUT,
): { text: string; omitted: number } =>
  s.length <= max
    ? { text: s, omitted: 0 }
    : { text: s.slice(s.length - max), omitted: s.length - max };
