import { createServer } from "node:http"
import type { IntegrationOAuthMethodRegistration } from "@opencode-ai/plugin/v2/effect/integration"
import { Deferred, Effect, Schema } from "effect"
import { Credential } from "../../credential"
import { Integration } from "../../integration"
import { OauthCallbackPage } from "../../oauth/page"
import { methodID } from "./anthropic-oauth-constants"

const clientID = atob("OWQxYzI1MGEtZTYxYi00NGQ5LTg4ZWQtNTk0NGQxOTYyZjVl")
const port = 54545
const redirect = `http://localhost:${port}/callback`
const tokens = Schema.Struct({
  access_token: Schema.String,
  refresh_token: Schema.optional(Schema.String),
  expires_in: Schema.optional(Schema.Number),
})

function request(body: Record<string, string>, refreshing: boolean) {
  return Effect.tryPromise({
    try: async (signal) => {
      const response = await fetch("https://api.anthropic.com/v1/oauth/token", {
        method: "POST",
        signal: AbortSignal.any([signal, AbortSignal.timeout(30_000)]),
        headers: {
          "Content-Type": "application/json",
          Accept: "application/json",
          ...(refreshing
            ? {
                "anthropic-beta": "oauth-2025-04-20",
                "User-Agent": "anthropic-sdk-typescript/0.112.1 userOAuthProvider",
              }
            : {}),
        },
        body: JSON.stringify(body),
      })
      if (!response.ok) throw new Error(`Anthropic token request failed (${response.status}): ${await response.text()}`)
      return Schema.decodeUnknownSync(tokens)(await response.json())
    },
    catch: (cause) => cause,
  })
}

export const registration = {
  integrationID: Integration.ID.make("anthropic"),
  method: { id: methodID, type: "oauth", label: "Claude Pro/Max" },
  authorize: () =>
    Effect.gen(function* () {
      const verifier = Array.from(
        crypto.getRandomValues(new Uint8Array(64)),
        (byte) => "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-._~"[byte % 66],
      ).join("")
      const challenge = Buffer.from(
        yield* Effect.promise(() => crypto.subtle.digest("SHA-256", new TextEncoder().encode(verifier))),
      ).toString("base64url")
      const state = Buffer.from(crypto.getRandomValues(new Uint8Array(32))).toString("base64url")
      const code = yield* Deferred.make<string, Error>()
      const server = createServer((req, res) => {
        const url = new URL(req.url ?? "/", redirect)
        if (url.pathname !== "/callback") return void res.writeHead(404).end("Not found")
        if (url.searchParams.get("state") !== state) {
          res
            .writeHead(400, { "Content-Type": "text/html" })
            .end(OauthCallbackPage.error("Invalid state", { provider: "Anthropic" }))
          return
        }
        const error = url.searchParams.get("error_description") ?? url.searchParams.get("error")
        if (error) {
          Effect.runFork(Deferred.fail(code, new Error(error)))
          res
            .writeHead(400, { "Content-Type": "text/html" })
            .end(OauthCallbackPage.error(error, { provider: "Anthropic" }))
          return
        }
        const value = url.searchParams.get("code")
        if (!value) {
          Effect.runFork(Deferred.fail(code, new Error("Missing authorization code")))
          res
            .writeHead(400, { "Content-Type": "text/html" })
            .end(OauthCallbackPage.error("Missing authorization code", { provider: "Anthropic" }))
          return
        }
        Effect.runFork(Deferred.succeed(code, value))
        res.writeHead(200, { "Content-Type": "text/html" }).end(OauthCallbackPage.success({ provider: "Anthropic" }))
      })
      yield* Effect.callback<void, Error>((resume) => {
        server.once("error", (error) => resume(Effect.fail(error)))
        server.listen(port, "localhost", () => resume(Effect.void))
      })
      yield* Effect.addFinalizer(() =>
        Effect.sync(() => {
          server.closeAllConnections()
          server.close()
        }),
      )
      return {
        mode: "auto" as const,
        url: `https://claude.ai/oauth/authorize?${new URLSearchParams({
          code: "true",
          client_id: clientID,
          response_type: "code",
          redirect_uri: redirect,
          scope:
            "org:create_api_key user:profile user:inference user:sessions:claude_code user:mcp_servers user:file_upload",
          code_challenge: challenge,
          code_challenge_method: "S256",
          state,
        })}`,
        instructions: "Complete the login in your browser. This page will close automatically.",
        callback: Deferred.await(code).pipe(
          Effect.flatMap((value) =>
            request(
              {
                grant_type: "authorization_code",
                client_id: clientID,
                code: value,
                state,
                redirect_uri: redirect,
                code_verifier: verifier,
              },
              false,
            ),
          ),
          Effect.map((value) =>
            Credential.OAuth.make({
              type: "oauth",
              methodID,
              access: value.access_token,
              refresh: value.refresh_token ?? "",
              expires: Date.now() + (value.expires_in ?? 3600) * 1000,
            }),
          ),
        ),
      }
    }),
  refresh: (credential) =>
    request({ grant_type: "refresh_token", client_id: clientID, refresh_token: credential.refresh }, true).pipe(
      Effect.map((value) =>
        Credential.OAuth.make({
          type: "oauth",
          methodID,
          access: value.access_token,
          refresh: value.refresh_token ?? credential.refresh,
          expires: Date.now() + (value.expires_in ?? 3600) * 1000,
          metadata: credential.metadata,
        }),
      ),
    ),
} satisfies IntegrationOAuthMethodRegistration
