import { join } from "node:path"
import { homedir } from "node:os"
import { readFileSync, existsSync } from "node:fs"

/**
 * Gateway configuration, loaded from environment (.env is read manually to
 * avoid an extra dependency).
 */

/**
 * Resolve the gateway's state directory (pairing/allowlist).
 *
 * Precedence: OPENCORE_STATE_DIR env var > ~/.opencore/gateway.
 * Resolved lazily so OPENCORE_STATE_DIR set in .env is honored.
 */
let _stateDir: string | null = null
export function getStateDir(): string {
  if (_stateDir) return _stateDir
  const root = envValue("OPENCORE_STATE_DIR")
  _stateDir = root
    ? join(root, "gateway")
    : join(homedir(), ".opencore", "gateway")
  return _stateDir
}

export type AgentName = "chat" | "dev" | "plan"

export interface GatewayConfig {
  telegramToken: string
  port: number
  defaultAgent: AgentName
  workdir: string
  opencodeBin?: string
  availableModels: Array<{ id: string; label: string }>
  defaultModel?: string
}

function loadDotEnv(): void {
  const path = join(process.cwd(), ".env")
  if (!existsSync(path)) return
  for (const raw of readFileSync(path, "utf8").split("\n")) {
    const line = raw.trim()
    if (!line || line.startsWith("#")) continue
    const eq = line.indexOf("=")
    if (eq === -1) continue
    const key = line.slice(0, eq).trim()
    let val = line.slice(eq + 1).trim()
    // strip surrounding quotes
    if ((val.startsWith('"') && val.endsWith('"')) || (val.startsWith("'") && val.endsWith("'"))) {
      val = val.slice(1, -1)
    }
    if (!(key in process.env)) process.env[key] = val
  }
}

function parseAgent(v: string | undefined): AgentName {
  if (v === "dev" || v === "plan" || v === "chat") return v
  return "chat"
}

function envValue(name: string, legacyName?: string): string | undefined {
  const value = process.env[name]?.trim()
  if (value) return value
  if (!legacyName) return undefined
  const legacy = process.env[legacyName]?.trim()
  return legacy || undefined
}

function envNumber(name: string, fallback: number, legacyName?: string): number {
  const raw = envValue(name, legacyName)
  if (!raw) return fallback
  const parsed = Number(raw)
  return Number.isFinite(parsed) ? parsed : fallback
}

export function loadConfig(): GatewayConfig {
  loadDotEnv()
  // Resolve stateDir after .env is loaded so OPENCORE_STATE_DIR in .env works.
  getStateDir()

  const telegramToken = process.env.TELEGRAM_BOT_TOKEN?.trim() ?? ""
  if (!telegramToken) {
    throw new Error(
      "TELEGRAM_BOT_TOKEN is not set. Copy gateway/.env.example to gateway/.env and fill it in.",
    )
  }

  // Parse available models from env var (comma-separated "id:label" pairs)
  // Example: OPENCORE_MODELS="anthropic/claude-opus-4:Claude Opus 4,anthropic/claude-sonnet-4:Claude Sonnet 4"
  const modelsEnv = process.env.OPENCORE_MODELS?.trim()
  const availableModels: Array<{ id: string; label: string }> = []
  if (modelsEnv) {
    for (const pair of modelsEnv.split(",")) {
      const [id, label] = pair.split(":", 2).map((s) => s.trim())
      if (id) availableModels.push({ id, label: label || id })
    }
  }
  // Default models if not configured
  if (availableModels.length === 0) {
    availableModels.push(
      { id: "anthropic/claude-opus-4", label: "Claude Opus 4" },
      { id: "anthropic/claude-sonnet-4", label: "Claude Sonnet 4" },
      { id: "openai/gpt-4o", label: "GPT-4o" },
      { id: "openai/o1", label: "o1" },
      { id: "google/gemini-2.0-flash-exp", label: "Gemini 2.0 Flash" },
    )
  }

  return {
    telegramToken,
    port: envNumber("OPENCORE_GATEWAY_PORT", 4099, "opencore_GATEWAY_PORT"),
    defaultAgent: parseAgent(envValue("OPENCORE_GATEWAY_DEFAULT_AGENT", "opencore_GATEWAY_DEFAULT_AGENT")),
    workdir: envValue("OPENCORE_GATEWAY_WORKDIR", "opencore_GATEWAY_WORKDIR") || process.cwd(),
    opencodeBin: envValue("OPENCORE_OPENCODE_BIN", "opencore_OPENCODE_BIN"),
    availableModels,
    defaultModel: envValue("OPENCORE_DEFAULT_MODEL"),
  }
}
