/**
 * Resolve the opencore state directory.
 *
 * Precedence:
 *   1. OPENCORE_STATE_DIR  — explicit override (good for tests, WSL, containers)
 *   2. ~/.opencore         — default
 *
 * Used by every plugin store and the gateway so all state lives in one place
 * and the user can redirect it with a single env var when the default homedir
 * is wrong (e.g. running under a different user profile than expected).
 */
import { homedir } from "node:os"
import { join } from "node:path"

export function stateRoot(): string {
  return process.env.OPENCORE_STATE_DIR?.trim() || join(homedir(), ".opencore")
}

export function statePath(...parts: string[]): string {
  return join(stateRoot(), ...parts)
}
