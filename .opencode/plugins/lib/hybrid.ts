/**
 * Hybrid search helpers: cosine similarity for vectors, and Reciprocal Rank
 * Fusion (RRF) to combine keyword (BM25) and semantic (vector) rankings.
 *
 * RRF is robust because it fuses by RANK, not by raw scores (which live on
 * different scales for BM25 vs cosine). Each result's fused score is the sum of
 * 1/(k + rank) across the lists it appears in.
 */

/** Cosine similarity between two equal-length vectors. */
export function cosineSimilarity(a: number[], b: number[]): number {
  if (a.length !== b.length || a.length === 0) return 0
  let dot = 0
  let na = 0
  let nb = 0
  for (let i = 0; i < a.length; i++) {
    dot += a[i] * b[i]
    na += a[i] * a[i]
    nb += b[i] * b[i]
  }
  if (na === 0 || nb === 0) return 0
  return dot / (Math.sqrt(na) * Math.sqrt(nb))
}

/**
 * Rank a query vector against candidate vectors, returning indices sorted by
 * descending similarity (best first), limited to `limit`.
 */
export function rankBySimilarity(
  query: number[],
  candidates: Array<number[] | null>,
  limit: number,
): number[] {
  const scored: Array<{ i: number; s: number }> = []
  for (let i = 0; i < candidates.length; i++) {
    const v = candidates[i]
    if (v && v.length === query.length) {
      scored.push({ i, s: cosineSimilarity(query, v) })
    }
  }
  scored.sort((x, y) => y.s - x.s)
  return scored.slice(0, limit).map((x) => x.i)
}

/**
 * Reciprocal Rank Fusion over multiple ranked lists of item ids.
 * `lists` is an array of ranked id-arrays (best-first). Returns ids sorted by
 * fused score, best first.
 */
export function reciprocalRankFusion<T>(lists: T[][], k = 60, limit?: number): T[] {
  const score = new Map<T, number>()
  for (const list of lists) {
    for (let rank = 0; rank < list.length; rank++) {
      const id = list[rank]
      score.set(id, (score.get(id) ?? 0) + 1 / (k + rank + 1))
    }
  }
  const fused = [...score.entries()].sort((a, b) => b[1] - a[1]).map((e) => e[0])
  return typeof limit === "number" ? fused.slice(0, limit) : fused
}
