import { Integration } from "../../integration"

export const methodID = Integration.MethodID.make("claude-pro-max")
export const system = "You are Claude Code, Anthropic's official CLI for Claude."
// Keep the CLI version aligned with the legacy auth adapter until the login paths converge.
export const userAgent = "claude-cli/2.1.281 (external, cli)"
export const betas = "claude-code-20250219,oauth-2025-04-20"
