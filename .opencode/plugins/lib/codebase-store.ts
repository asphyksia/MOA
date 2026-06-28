import { homedir } from "node:os"
import { join } from "node:path"
import { mkdirSync } from "node:fs"
import { createHash } from "node:crypto"
import {
  embedDocuments,
  embedQuery,
  embeddingsConfigured,
  embeddingModelId,
} from "./embeddings"
import { rankBySimilarity, reciprocalRankFusion } from "./hybrid"

/**
 * Per-project SQLite + FTS5 store for codebase RAG, with optional hybrid
 * (keyword + semantic) search.
 *
 * The index is scoped per project (DB named by a hash of the project path).
 * Files are split into line-range chunks; `chunks_fts` indexes content (BM25).
 * A `vectors` table holds per-chunk embeddings (Float32 BLOB) keyed by chunk id,
 * with a content hash + model id so we only (re-)embed new/changed chunks.
 *
 * search() fuses BM25 + cosine via RRF, falling back to BM25 alone when
 * embeddings are unavailable. Runs on Bun's built-in `bun:sqlite`.
 */

export type Chunk = {
  path: string
  startLine: number
  endLine: number
  content: string
}

export type SearchHit = {
  path: string
  startLine: number
  endLine: number
  content: string
}

const baseDir = join(homedir(), ".opencore", "codebase")

const dbCache = new Map<string, any>()

function dbFileFor(projectDir: string): string {
  const hash = createHash("sha256").update(projectDir).digest("hex").slice(0, 16)
  return join(baseDir, `${hash}.db`)
}

function contentHash(text: string): string {
  return createHash("sha256").update(text).digest("hex")
}

function toBlob(vec: number[]): Buffer {
  return Buffer.from(new Float32Array(vec).buffer)
}

function fromBlob(buf: Buffer | Uint8Array | null): number[] | null {
  if (!buf) return null
  const b = Buffer.isBuffer(buf) ? buf : Buffer.from(buf)
  const f = new Float32Array(b.buffer, b.byteOffset, Math.floor(b.byteLength / 4))
  return Array.from(f)
}

async function openDb(projectDir: string): Promise<any> {
  const cached = dbCache.get(projectDir)
  if (cached) return cached

  mkdirSync(baseDir, { recursive: true })
  const { Database } = (await import("bun:sqlite")) as any
  const db = new Database(dbFileFor(projectDir))
  db.run("PRAGMA journal_mode = WAL")

  db.run(`
    CREATE TABLE IF NOT EXISTS chunks (
      id        INTEGER PRIMARY KEY AUTOINCREMENT,
      path      TEXT NOT NULL,
      startLine INTEGER NOT NULL,
      endLine   INTEGER NOT NULL,
      content   TEXT NOT NULL
    )
  `)
  db.run("CREATE INDEX IF NOT EXISTS chunks_path ON chunks(path)")

  db.run(`
    CREATE VIRTUAL TABLE IF NOT EXISTS chunks_fts
    USING fts5(content, path UNINDEXED, content='chunks', content_rowid='id')
  `)
  db.run(`
    CREATE TRIGGER IF NOT EXISTS chunks_ai AFTER INSERT ON chunks BEGIN
      INSERT INTO chunks_fts(rowid, content, path) VALUES (new.id, new.content, new.path);
    END
  `)
  db.run(`
    CREATE TRIGGER IF NOT EXISTS chunks_ad AFTER DELETE ON chunks BEGIN
      INSERT INTO chunks_fts(chunks_fts, rowid, content, path) VALUES ('delete', old.id, old.content, old.path);
    END
  `)

  // Per-chunk embeddings. Deleted automatically with their chunk.
  db.run(`
    CREATE TABLE IF NOT EXISTS vectors (
      chunk_id INTEGER PRIMARY KEY,
      hash     TEXT NOT NULL,
      model    TEXT NOT NULL,
      dim      INTEGER NOT NULL,
      vec      BLOB NOT NULL
    )
  `)

  db.run("CREATE TABLE IF NOT EXISTS meta (key TEXT PRIMARY KEY, value TEXT)")

  dbCache.set(projectDir, db)
  return db
}

/** Replace all chunks for a file with a fresh set. Embeds new chunks if able. */
export async function indexFile(
  projectDir: string,
  path: string,
  chunks: Chunk[],
): Promise<void> {
  const db = await openDb(projectDir)
  const del = db.prepare("DELETE FROM chunks WHERE path = ?")
  const ins = db.prepare(
    "INSERT INTO chunks (path, startLine, endLine, content) VALUES (?, ?, ?, ?)",
  )
  const insertedIds: number[] = []
  const tx = db.transaction(() => {
    // Remove vectors for old chunks of this file first (chunk ids change).
    const oldIds = db
      .query("SELECT id FROM chunks WHERE path = ?")
      .all(path) as Array<{ id: number }>
    const delVec = db.prepare("DELETE FROM vectors WHERE chunk_id = ?")
    for (const o of oldIds) delVec.run(o.id)
    del.run(path)
    for (const c of chunks) {
      const res = ins.run(c.path, c.startLine, c.endLine, c.content)
      insertedIds.push(Number(res.lastInsertRowid))
    }
  })
  tx()

  // Embed the new chunks (best-effort, never blocks indexing correctness).
  if (embeddingsConfigured() && insertedIds.length > 0) {
    void embedChunks(
      projectDir,
      insertedIds.map((id, i) => ({ id, content: chunks[i].content })),
    ).catch(() => {})
  }
}

async function embedChunks(
  projectDir: string,
  items: Array<{ id: number; content: string }>,
): Promise<void> {
  if (!embeddingsConfigured() || items.length === 0) return
  const db = await openDb(projectDir)
  const model = embeddingModelId()
  const vecs = await embedDocuments(items.map((it) => it.content))
  if (!vecs) return
  const stmt = db.prepare(
    "INSERT OR REPLACE INTO vectors (chunk_id, hash, model, dim, vec) VALUES (?, ?, ?, ?, ?)",
  )
  const tx = db.transaction(() => {
    for (let i = 0; i < items.length; i++) {
      const v = vecs[i]
      if (v && v.length) {
        stmt.run(items[i].id, contentHash(items[i].content), model, v.length, toBlob(v))
      }
    }
  })
  tx()
}

/** Embed any chunks lacking an up-to-date vector. Returns count embedded. */
export async function backfillEmbeddings(projectDir: string, limit = 1000): Promise<number> {
  if (!embeddingsConfigured()) return 0
  const db = await openDb(projectDir)
  const model = embeddingModelId()
  const rows = db
    .query(
      `SELECT c.id AS id, c.content AS content
       FROM chunks c
       LEFT JOIN vectors v ON v.chunk_id = c.id
       WHERE v.chunk_id IS NULL OR v.model != ?
       LIMIT ?`,
    )
    .all(model, limit) as Array<{ id: number; content: string }>
  if (rows.length === 0) return 0
  // Batch to keep request sizes sane.
  const batchSize = 32
  let n = 0
  for (let i = 0; i < rows.length; i += batchSize) {
    const batch = rows.slice(i, i + batchSize)
    await embedChunks(projectDir, batch)
    n += batch.length
  }
  return n
}

export async function removeFile(projectDir: string, path: string): Promise<void> {
  const db = await openDb(projectDir)
  const tx = db.transaction(() => {
    const ids = db.query("SELECT id FROM chunks WHERE path = ?").all(path) as Array<{ id: number }>
    const delVec = db.prepare("DELETE FROM vectors WHERE chunk_id = ?")
    for (const r of ids) delVec.run(r.id)
    db.prepare("DELETE FROM chunks WHERE path = ?").run(path)
  })
  tx()
}

export async function clearIndex(projectDir: string): Promise<void> {
  const db = await openDb(projectDir)
  db.run("DELETE FROM vectors")
  db.run("DELETE FROM chunks")
}

function toMatchExpr(query: string): string {
  const terms = query
    .toLowerCase()
    .split(/[^\p{L}\p{N}_]+/u)
    .filter((t) => t.length > 1)
    .map((t) => `"${t.replace(/"/g, '""')}"*`)
  return terms.join(" OR ")
}

function bm25Search(db: any, query: string, limit: number): Array<SearchHit & { id: number }> {
  const expr = toMatchExpr(query)
  if (!expr) return []
  return db
    .query(
      `SELECT c.id, c.path, c.startLine, c.endLine, c.content
       FROM chunks_fts
       JOIN chunks c ON c.id = chunks_fts.rowid
       WHERE chunks_fts MATCH ?
       ORDER BY bm25(chunks_fts) ASC
       LIMIT ?`,
    )
    .all(expr, limit) as Array<SearchHit & { id: number }>
}

export async function search(
  projectDir: string,
  query: string,
  limit = 8,
): Promise<SearchHit[]> {
  const db = await openDb(projectDir)
  const pool = Math.max(limit * 4, 24)

  const bm25 = bm25Search(db, query, pool)

  let semanticIds: number[] = []
  if (embeddingsConfigured()) {
    const qvec = await embedQuery(query)
    if (qvec) {
      const rows = db
        .query("SELECT chunk_id, vec FROM vectors")
        .all() as Array<{ chunk_id: number; vec: Uint8Array }>
      if (rows.length > 0) {
        const ids = rows.map((r) => r.chunk_id)
        const vecs = rows.map((r) => fromBlob(r.vec))
        const ranked = rankBySimilarity(qvec, vecs, pool)
        semanticIds = ranked.map((i) => ids[i])
      }
    }
  }

  if (semanticIds.length === 0) {
    return bm25.slice(0, limit).map(({ id, ...hit }) => hit)
  }

  const bm25Ids = bm25.map((h) => h.id)
  const fusedIds = reciprocalRankFusion([bm25Ids, semanticIds], 60, limit)
  return resolveChunks(db, fusedIds)
}

function resolveChunks(db: any, ids: number[]): SearchHit[] {
  if (ids.length === 0) return []
  const stmt = db.prepare(
    "SELECT path, startLine, endLine, content FROM chunks WHERE id = ?",
  )
  const out: SearchHit[] = []
  for (const id of ids) {
    const row = stmt.get(id) as SearchHit | undefined
    if (row) out.push(row)
  }
  return out
}

export async function setMeta(projectDir: string, key: string, value: string): Promise<void> {
  const db = await openDb(projectDir)
  db.prepare("INSERT OR REPLACE INTO meta (key, value) VALUES (?, ?)").run(key, value)
}

export async function getMeta(projectDir: string, key: string): Promise<string | null> {
  const db = await openDb(projectDir)
  const row = db.query("SELECT value FROM meta WHERE key = ?").get(key) as
    | { value: string }
    | undefined
  return row?.value ?? null
}

export async function stats(projectDir: string): Promise<{ files: number; chunks: number }> {
  const db = await openDb(projectDir)
  const chunks = (db.query("SELECT COUNT(*) AS n FROM chunks").get() as { n: number }).n
  const files = (
    db.query("SELECT COUNT(DISTINCT path) AS n FROM chunks").get() as { n: number }
  ).n
  return { files, chunks }
}
