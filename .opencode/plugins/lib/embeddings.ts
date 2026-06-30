/**
 * Embeddings client for opencore semantic search.
 *
 * Talks to any OpenAI-compatible `/v1/embeddings` endpoint, so the same code
 * works with a local llama.cpp server (recommended default), Ollama, or a cloud
 * API. opencore stays agnostic to the source.
 *
 * Config is read from (in order of precedence):
 *   1. Environment variables (good for CLI / shell launches):
 *        OPENCORE_EMBED_BASE_URL  e.g. http://127.0.0.1:8181/v1
 *        OPENCORE_EMBED_MODEL     e.g. harrier
 *        OPENCORE_EMBED_API_KEY   optional (cloud)
 *        OPENCORE_EMBED_QUERY_INSTRUCT  optional query instruction override
 *   2. A config file at ~/.opencore/embeddings.json (good for the desktop app and
 *      the daemon, which don't inherit your shell env):
 *        { "baseUrl": "...", "model": "...", "apiKey": "...", "queryInstruct": "..." }
 *
 * Design:
 * - If no base URL is found, or a request fails, embed() returns null.
 *   Callers treat null as "no embeddings available" and fall back to BM25.
 * - harrier (and most instruct embedding models) want a one-sentence task
 *   instruction on QUERIES but not on documents. We apply it to queries only.
 * - Small in-memory cache avoids re-embedding identical query text.
 */

import { statePath } from "./state-dir"
import { join } from "node:path"
import { readFileSync, existsSync } from "node:fs"

interface EmbedConfig {
  baseUrl: string
  model: string
  apiKey: string
  queryInstruct: string
}

const DEFAULT_QUERY_INSTRUCT =
  "Instruct: Given a search query, retrieve relevant text that answers it\nQuery: "

function envValue(name: string, legacyName?: string): string | undefined {
  const value = process.env[name]?.trim()
  if (value) return value
  if (!legacyName) return undefined
  const legacy = process.env[legacyName]?.trim()
  return legacy || undefined
}

function loadConfig(): EmbedConfig {
  // File config (so the desktop app / daemon work without shell env).
  let file: Partial<EmbedConfig> = {}
  try {
    const path = statePath("embeddings.json")
    if (existsSync(path)) file = JSON.parse(readFileSync(path, "utf8"))
  } catch {
    /* ignore malformed file */
  }
  return {
    baseUrl: (envValue("OPENCORE_EMBED_BASE_URL", "opencore_EMBED_BASE_URL") || file.baseUrl || "").replace(/\/+$/, ""),
    model: envValue("OPENCORE_EMBED_MODEL", "opencore_EMBED_MODEL") || file.model || "harrier",
    apiKey: envValue("OPENCORE_EMBED_API_KEY", "opencore_EMBED_API_KEY") || file.apiKey || "",
    queryInstruct:
      envValue("OPENCORE_EMBED_QUERY_INSTRUCT", "opencore_EMBED_QUERY_INSTRUCT") ||
      file.queryInstruct ||
      DEFAULT_QUERY_INSTRUCT,
  }
}

const cfg = loadConfig()
const baseUrl = cfg.baseUrl
const model = cfg.model
const apiKey = cfg.apiKey

export function embeddingsConfigured(): boolean {
  return baseUrl.length > 0
}

/** A short label identifying the active embedding model + endpoint, for the
 *  store to detect when the model changed (and re-embed). */
export function embeddingModelId(): string {
  return embeddingsConfigured() ? `${model}@${baseUrl}` : ""
}

const queryCache = new Map<string, number[]>()
const MAX_CACHE = 256

async function postEmbeddings(inputs: string[]): Promise<number[][] | null> {
  if (!embeddingsConfigured() || inputs.length === 0) return null
  try {
    const headers: Record<string, string> = { "Content-Type": "application/json" }
    if (apiKey) headers["Authorization"] = `Bearer ${apiKey}`
    const res = await fetch(`${baseUrl}/embeddings`, {
      method: "POST",
      headers,
      body: JSON.stringify({ model, input: inputs }),
    })
    if (!res.ok) return null
    const json: any = await res.json()
    const data = json?.data
    if (!Array.isArray(data)) return null
    // Preserve input order via the `index` field when present.
    const out: number[][] = new Array(inputs.length)
    for (let i = 0; i < data.length; i++) {
      const item = data[i]
      const idx = typeof item?.index === "number" ? item.index : i
      out[idx] = item?.embedding ?? []
    }
    return out
  } catch {
    return null
  }
}

/** Embed documents (no instruction prefix). Returns null on any failure. */
export async function embedDocuments(texts: string[]): Promise<number[][] | null> {
  return postEmbeddings(texts)
}

/** Embed a single query (with instruction prefix). Cached. Null on failure. */
export async function embedQuery(text: string): Promise<number[] | null> {
  if (!embeddingsConfigured()) return null
  const cached = queryCache.get(text)
  if (cached) return cached
  const res = await postEmbeddings([cfg.queryInstruct + text])
  const vec = res?.[0] ?? null
  if (vec) {
    if (queryCache.size >= MAX_CACHE) {
      const first = queryCache.keys().next().value
      if (first !== undefined) queryCache.delete(first)
    }
    queryCache.set(text, vec)
  }
  return vec
}
