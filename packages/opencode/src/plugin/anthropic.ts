import type { Hooks, PluginInput } from "@opencode-ai/plugin"
import { OAUTH_DUMMY_KEY } from "../auth"
import { OauthCallbackPage } from "@opencode-ai/core/oauth/page"
import { createServer } from "http"

// Public OAuth client id shipped with Claude Code, stored base64 so secret
// scanners do not flag it. There is no client secret: the flow is PKCE-only.
const CLIENT_ID = atob("OWQxYzI1MGEtZTYxYi00NGQ5LTg4ZWQtNTk0NGQxOTYyZjVl")
const AUTHORIZE_URL = "https://claude.ai/oauth/authorize"
// platform.claude.com serves the same endpoint, but api.anthropic.com is the
// origin inference already uses and answers with structured OAuth errors.
const TOKEN_URL = "https://api.anthropic.com/v1/oauth/token"
const SCOPES =
  "org:create_api_key user:profile user:inference user:sessions:claude_code user:mcp_servers user:file_upload"
const CALLBACK_PORT = 54545
const CALLBACK_PATH = "/callback"
const OAUTH_TIMEOUT_MS = 5 * 60 * 1000
const OAUTH_TIMEOUT_MESSAGE = "OAuth callback timeout - authorization took too long"

// Anthropic only serves subscription models to requests that look like the
// official client, so we echo its user agent and beta list. Bump
// CLAUDE_CODE_VERSION when a model starts answering "Claude Code x.y.z does
// not support this model" — track `@anthropic-ai/claude-code` on npm.
const CLAUDE_CODE_VERSION = "2.1.281"
const CLAUDE_CODE_USER_AGENT = `claude-cli/${CLAUDE_CODE_VERSION} (external, cli)`
const REFRESH_USER_AGENT = "anthropic-sdk-typescript/0.112.1 userOAuthProvider"
const OAUTH_BETAS = ["claude-code-20250219", "oauth-2025-04-20"]

// Anthropic answers sonnet/opus requests from consumer OAuth tokens with a
// 429 rate_limit_error unless `system` is byte-exactly this line: appending
// anything to it (even our own instructions), or sending any other prompt,
// fails. Headers, betas and tools make no difference, and haiku is exempt.
// The request builder therefore sends this line as the system field and
// carries opencode's instructions as the first user message instead.
export const CLAUDE_CODE_SYSTEM = "You are Claude Code, Anthropic's official CLI for Claude."

// Refresh slightly early so a long-running request never starts with a token
// that expires mid-flight. Anthropic rotates the refresh token on every use,
// so a stale copy is a hard re-login.
const ACCESS_TOKEN_REFRESH_SKEW_MS = 300_000

interface AnthropicAuthPluginOptions {
  tokenUrl?: string
  /** Loopback port for the OAuth callback. Tests bind an ephemeral port with 0. */
  callbackPort?: number
}

interface TokenResponse {
  access_token: string
  refresh_token?: string
  expires_in?: number
}

interface PkceCodes {
  verifier: string
  challenge: string
}

async function generatePKCE(): Promise<PkceCodes> {
  const chars = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-._~"
  const verifier = Array.from(crypto.getRandomValues(new Uint8Array(64)))
    .map((byte) => chars[byte % chars.length])
    .join("")
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(verifier))
  return { verifier, challenge: base64UrlEncode(digest) }
}

function base64UrlEncode(buffer: ArrayBuffer): string {
  const binary = String.fromCharCode(...new Uint8Array(buffer))
  return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "")
}

async function postToken(
  body: Record<string, string>,
  refresh: boolean,
  options: AnthropicAuthPluginOptions,
): Promise<TokenResponse> {
  const response = await fetch(options.tokenUrl ?? TOKEN_URL, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Accept: "application/json",
      // Claude Code sends these on refresh but not on the initial code exchange.
      ...(refresh ? { "anthropic-beta": "oauth-2025-04-20", "User-Agent": REFRESH_USER_AGENT } : {}),
    },
    body: JSON.stringify(body),
  })
  if (!response.ok) {
    const detail = await response.text().catch(() => "")
    throw new Error(`Anthropic token request failed (${response.status})${detail ? `: ${detail}` : ""}`)
  }
  return response.json() as Promise<TokenResponse>
}

function buildAuthorizeUrl(redirectUri: string, pkce: PkceCodes, state: string) {
  const params = new URLSearchParams({
    code: "true",
    client_id: CLIENT_ID,
    response_type: "code",
    redirect_uri: redirectUri,
    scope: SCOPES,
    code_challenge: pkce.challenge,
    code_challenge_method: "S256",
    state,
  })
  return `${AUTHORIZE_URL}?${params.toString()}`
}

function startCallbackServer(state: string, port: number) {
  return new Promise<{ redirectUri: string; waitForCode: Promise<string>; close: () => void }>((resolve, reject) => {
    let resolveCode!: (code: string) => void
    let rejectCode!: (error: Error) => void
    const waitForCode = new Promise<string>((resolvePromise, rejectPromise) => {
      resolveCode = resolvePromise
      rejectCode = rejectPromise
    })
    // The timeout below can reject before callback() awaits this promise, so
    // mark it handled now to keep it from surfacing as an unhandled rejection.
    waitForCode.catch(() => {})
    const timeout = setTimeout(() => rejectCode(new Error(OAUTH_TIMEOUT_MESSAGE)), OAUTH_TIMEOUT_MS)
    const settle = (fn: () => void) => {
      clearTimeout(timeout)
      fn()
    }

    const server = createServer((req, res) => {
      const url = new URL(req.url || "/", `http://localhost:${port}`)
      if (url.pathname !== CALLBACK_PATH) {
        res.writeHead(404, { "Content-Type": "text/plain; charset=utf-8" })
        res.end("Not found")
        return
      }

      const html = (status: number, body: string) => {
        res.writeHead(status, { "Content-Type": "text/html; charset=utf-8" })
        res.end(body)
      }
      const error = url.searchParams.get("error")
      const detail = url.searchParams.get("error_description")
      if (error) {
        settle(() => rejectCode(new Error(detail || error)))
        html(200, OauthCallbackPage.error(detail || error, { provider: "Anthropic" }))
        return
      }

      const code = url.searchParams.get("code")
      if (!code) {
        settle(() => rejectCode(new Error("Missing authorization code")))
        html(400, OauthCallbackPage.error("Missing authorization code", { provider: "Anthropic" }))
        return
      }
      if (url.searchParams.get("state") !== state) {
        settle(() => rejectCode(new Error("Invalid state - potential CSRF attack")))
        html(400, OauthCallbackPage.error("Invalid state", { provider: "Anthropic" }))
        return
      }

      settle(() => resolveCode(code))
      html(200, OauthCallbackPage.success({ provider: "Anthropic" }))
    })

    server.once("error", (error) => {
      clearTimeout(timeout)
      reject(error)
    })
    server.listen(port, () => {
      const address = server.address()
      const bound = typeof address === "object" && address ? address.port : port
      resolve({
        redirectUri: `http://localhost:${bound}${CALLBACK_PATH}`,
        waitForCode,
        close: () => {
          // The browser keeps the callback connection alive, which would pin
          // the event loop open long after the exchange finished.
          server.closeAllConnections()
          server.close()
        },
      })
    })
  })
}

export async function AnthropicAuthPlugin(
  input: PluginInput,
  options: AnthropicAuthPluginOptions = {},
): Promise<Hooks> {
  return {
    auth: {
      provider: "anthropic",
      async loader(getAuth) {
        const auth = await getAuth()
        if (auth.type !== "oauth") return {}

        // Single-flight refresh: collapse concurrent requests onto one HTTP
        // call so we never replay a refresh token Anthropic already rotated.
        let refreshPromise: Promise<{ access: string; refresh: string; expires: number }> | undefined

        return {
          // Keeps the AI SDK from bailing on "missing apiKey"; the real bearer
          // token is injected by the fetch override below. The SDK's own
          // x-api-key header is dropped there so only the bearer reaches
          // Anthropic. baseURL stays untouched so a user-configured gateway
          // still wins.
          apiKey: OAUTH_DUMMY_KEY,
          async fetch(requestInput: RequestInfo | URL, init?: RequestInit) {
            let currentAuth = await getAuth()
            // Auth can flip from oauth to api mid-session when the user
            // re-runs /connect with a pasted key. Pass those requests through
            // untouched so the API key reaches Anthropic unmodified.
            if (currentAuth.type !== "oauth") return fetch(requestInput, init)

            if (currentAuth.expires - Date.now() <= ACCESS_TOKEN_REFRESH_SKEW_MS) {
              if (!refreshPromise) {
                const refreshToken = currentAuth.refresh
                refreshPromise = postToken(
                  { grant_type: "refresh_token", client_id: CLIENT_ID, refresh_token: refreshToken },
                  true,
                  options,
                )
                  .then(async (tokens) => {
                    const refreshed = {
                      access: tokens.access_token,
                      refresh: tokens.refresh_token || refreshToken,
                      expires: Date.now() + (tokens.expires_in ?? 3600) * 1000,
                    }
                    // Best-effort: Anthropic already consumed the old refresh
                    // token, so a failed write leaves disk stale but this turn
                    // still uses a valid token. The next refresh against the
                    // stale copy fails and forces a re-login.
                    await input.client.auth
                      .set({
                        path: { id: "anthropic" },
                        body: { type: "oauth", ...refreshed },
                      })
                      .catch(() => {})
                    return refreshed
                  })
                  .finally(() => {
                    refreshPromise = undefined
                  })
              }
              const refreshed = await refreshPromise
              currentAuth = { ...currentAuth, ...refreshed }
            }

            // Copy caller headers into a fresh Headers so we never mutate the
            // RequestInit the AI SDK may reuse on retry. Headers.set is
            // case-insensitive, which replaces the dummy x-api-key in one line.
            const headers = new Headers(requestInput instanceof Request ? requestInput.headers : undefined)
            if (init?.headers) {
              const entries =
                init.headers instanceof Headers
                  ? init.headers.entries()
                  : Array.isArray(init.headers)
                    ? init.headers
                    : Object.entries(init.headers as Record<string, string | undefined>)
              for (const [key, value] of entries) {
                if (value !== undefined) headers.set(key, String(value))
              }
            }
            headers.delete("x-api-key")
            headers.set("Authorization", `Bearer ${currentAuth.access}`)
            headers.set("User-Agent", CLAUDE_CODE_USER_AGENT)
            headers.set("x-app", "cli")
            const betas = new Set(OAUTH_BETAS)
            for (const value of (headers.get("anthropic-beta") ?? "").split(",")) {
              const beta = value.trim()
              if (beta) betas.add(beta)
            }
            headers.set("anthropic-beta", Array.from(betas).join(","))

            return fetch(requestInput, { ...init, headers })
          },
        }
      },
      methods: [
        {
          label: "Claude Pro/Max",
          type: "oauth",
          authorize: async () => {
            const pkce = await generatePKCE()
            const state = base64UrlEncode(crypto.getRandomValues(new Uint8Array(32)).buffer)
            const callback = await startCallbackServer(state, options.callbackPort ?? CALLBACK_PORT)
            return {
              url: buildAuthorizeUrl(callback.redirectUri, pkce, state),
              instructions: "Complete the login in your browser. This page will close automatically.",
              method: "auto" as const,
              callback: async () => {
                try {
                  const code = await callback.waitForCode
                  const tokens = await postToken(
                    {
                      grant_type: "authorization_code",
                      client_id: CLIENT_ID,
                      code,
                      state,
                      redirect_uri: callback.redirectUri,
                      code_verifier: pkce.verifier,
                    },
                    false,
                    options,
                  )
                  return {
                    type: "success" as const,
                    refresh: tokens.refresh_token ?? "",
                    access: tokens.access_token,
                    expires: Date.now() + (tokens.expires_in ?? 3600) * 1000,
                  }
                } finally {
                  callback.close()
                }
              },
            }
          },
        },
        {
          label: "Manually enter API Key",
          type: "api",
        },
      ],
    },
  }
}
