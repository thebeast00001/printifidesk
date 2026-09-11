/**
 * Page-range formatting, kept out of the portal component so it can be tested
 * and reused wherever a selection needs writing down.
 */

/** "1,2,3,7,8" → "1–3, 7–8", which is what you'd write on a job sheet. */
export function summarisePages(pages: number[]): string {
  if (pages.length === 0) return "all";

  const sorted = [...new Set(pages)].sort((a, b) => a - b);
  const runs: string[] = [];
  let start = sorted[0];
  let prev = sorted[0];

  for (const n of sorted.slice(1)) {
    if (n === prev + 1) {
      prev = n;
      continue;
    }
    runs.push(start === prev ? `${start}` : `${start}–${prev}`);
    start = n;
    prev = n;
  }
  runs.push(start === prev ? `${start}` : `${start}–${prev}`);
  return runs.join(", ");
}
