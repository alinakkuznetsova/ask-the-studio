// reciprocal rank fusion: combine ranked lists without having to calibrate
// cosine similarities against bm25 scores, which live on different scales.
// score(d) = sum over lists of 1 / (k + rank), rank starting at 1.

export function rrf(lists: string[][], k = 60): Map<string, number> {
  const scores = new Map<string, number>();
  for (const list of lists) {
    list.forEach((id, i) => {
      scores.set(id, (scores.get(id) ?? 0) + 1 / (k + i + 1));
    });
  }
  return new Map([...scores.entries()].sort((a, b) => b[1] - a[1]));
}
