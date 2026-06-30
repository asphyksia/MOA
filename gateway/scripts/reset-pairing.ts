#!/usr/bin/env tsx
/**
 * Reset gateway pairing: clear all admins/members and generate a fresh code.
 *
 * Usage (gateway must be stopped first):
 *   npx tsx scripts/reset-pairing.ts
 *
 * Prints the new pairing code to console. Send `/pair <code>` in Telegram to
 * become the admin again.
 */

import { Allowlist } from "../src/allowlist.js"

const allow = new Allowlist()
const code = allow.resetPairing()

console.log("\n========================================")
console.log("  Gateway pairing RESET")
console.log("  New pairing code:  " + code)
console.log("  In Telegram, send:  /pair " + code)
console.log("========================================\n")
console.log("All previous admins and members have been cleared.")
console.log("The first user to pair with this code becomes the new admin.\n")
