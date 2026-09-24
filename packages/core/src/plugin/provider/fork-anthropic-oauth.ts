import type { IntegrationOAuthMethodRegistration } from "@opencode/plugin/effect/integration"
import { define } from "@opencode/plugin/effect/plugin"
import { Deferred, Effect, Option, Schema, Semaphore, Stream } from "effect"
import { Bus } from "../../bus.js"
import { Credential } from "../../credential.js"
import { Integration } from "../../integration.js"
import { OauthCallbackPage } from "../../oauth/page.js"
import { Provider } from "../../provider.js"
import type { PluginInternal } from "../internal.js"

// fork: Claude Pro/Max login for Anthropic. The subscription endpoint accepts a
// request only when it looks like Claude Code: bearer auth (upstream already
// sends OAuth credentials as a bearer), the Claude Code system identity as the
// whole system field, and the Claude Code client headers.

const integrationID = Integration.ID.make("anthropic")
export const methodID = Integration.MethodID.make("claude-pro-max")
export const identity = "You are Claude Code, Anthropic's official CLI for Claude."
export const userAgent = "claude-cli/2.1.281 (external, cli)"
export const betas = ["claude-code-20250219", "oauth-2025-04-20"]
// Pro/Max usage windows are quotas, not throttling. Upstream already stops on
// "usage limit"; these are the other phrasings the subscription returns.
export const exhausted = /out of extra usage|weekly (?:usage )?limit|(?:five|5)[- ]hour (?:usage )?limit/i

const clientID = atob("OWQxYzI1MGEtZTYxYi00NGQ5LTg4ZWQtNTk0NGQxOTYyZjVl")
const port = 54545
const redirect = `http://localhost:${port}/callback`
const Tokens = Schema.Struct({
  access_token: Schema.String,
  refresh_token: Schema.optional(Schema.String),
  expires_in: Schema.optional(Schema.Number),
})

export const registration = {
  integrationID,
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
      // Lazy so runtimes without a loopback listener (workerd) never evaluate node:http.
      const { createServer } = yield* Effect.promise(() => import("node:http"))
      const server = createServer((request, response) => {
        const url = new URL(request.url ?? "/", redirect)
        if (url.pathname !== "/callback") {
          response.writeHead(404).end("Not found")
          return
        }
        const error = url.searchParams.get("error_description") ?? url.searchParams.get("error")
        const value = url.searchParams.get("code")
        if (!value || error || url.searchParams.get("state") !== state) {
          const message =
            url.searchParams.get("state") !== state ? "Invalid OAuth state" : (error ?? "Missing authorization code")
          Effect.runFork(Deferred.fail(code, new Error(message)))
          response
            .writeHead(400, { "Content-Type": "text/html" })
            .end(OauthCallbackPage.error(message, { provider: "Anthropic" }))
          return
        }
        Effect.runFork(Deferred.succeed(code, value))
        response
          .writeHead(200, { "Content-Type": "text/html" })
          .end(OauthCallbackPage.success({ provider: "Anthropic" }))
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
            token(
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
  refresh: (credential) => joinRefresh(credential.refresh, rotate(credential)),
} satisfies IntegrationOAuthMethodRegistration

// fork: Anthropic rotates refresh tokens and rejects a replayed one. Upstream
// refreshes per resolve without a lock, so concurrent sessions in one process
// would replay the same token; they share the in-flight or finished refresh instead.
const refreshes = new Map<string, Deferred.Deferred<Credential.OAuth, unknown>>()
const refreshLock = Semaphore.makeUnsafe(1)

/** Runs `refresh` once per refresh token; every caller holding that token gets its result. */
export function joinRefresh(key: string, refresh: Effect.Effect<Credential.OAuth, unknown>) {
  return Effect.gen(function* () {
    const claimed = yield* Effect.uninterruptible(
      refreshLock.withPermit(
        Effect.gen(function* () {
          const existing = refreshes.get(key)
          if (existing) return existing
          const deferred = yield* Deferred.make<Credential.OAuth, unknown>()
          refreshes.set(key, deferred)
          for (const old of Array.from(refreshes.keys()).slice(0, -16)) refreshes.delete(old)
          // Detached so an interrupted caller cannot strand the others.
          yield* Effect.forkDetach(Deferred.into(refresh, deferred))
          return deferred
        }),
      ),
    )
    return yield* Deferred.await(claimed).pipe(
      Effect.tapError(() =>
        Effect.sync(() => {
          if (refreshes.get(key) === claimed) refreshes.delete(key)
        }),
      ),
    )
  })
}

function rotate(credential: Credential.OAuth) {
  return token({ grant_type: "refresh_token", client_id: clientID, refresh_token: credential.refresh }, true).pipe(
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
  )
}

export const ForkAnthropicOAuthPlugin = define({
  id: "fork.provider.anthropic.oauth",
  effect: Effect.fn(function* (ctx) {
    const bus = yield* Bus.Service
    const loading = Semaphore.makeUnsafe(1)
    let subscription = false

    const load = Effect.fn("ForkAnthropicOAuthPlugin.load")(function* () {
      const connection = yield* ctx.integration.connection.active(integrationID)
      const credential = connection
        ? yield* ctx.integration.connection.resolve(connection).pipe(Effect.orElseSucceed(() => undefined))
        : undefined
      subscription = credential?.type === "oauth" && credential.methodID === methodID
    })

    yield* ctx.integration.transform((editor) => editor.method.update(registration))
    yield* load()
    yield* bus.subscribe(Credential.Event.Switched).pipe(
      Stream.filter((event) => event.data.integrationID === integrationID),
      Stream.runForEach(() => loading.withPermit(load())),
      Effect.forkScoped({ startImmediately: true }),
    )

    const options = { providerID: Provider.ID.anthropic }
    // Rewrites the final wire request, after every context hook (including
    // config and user plugins that register later) has shaped the system prompt,
    // and so betas that the route or catalog already set survive.
    yield* ctx.session.hook(
      "http.request",
      (evt) =>
        Effect.gen(function* () {
          if (!subscription) return
          const current = (evt.request.headers.get("anthropic-beta") ?? "")
            .split(",")
            .map((item) => item.trim())
            .filter(Boolean)
          evt.request.headers.delete("x-api-key")
          evt.request.headers.set("anthropic-beta", [...new Set([...current, ...betas])].join(","))
          evt.request.headers.set("User-Agent", userAgent)
          evt.request.headers.set("x-app", "cli")
          const body = Option.getOrUndefined(decodeJson(yield* Effect.promise(() => evt.request.clone().text())))
          if (!isBody(body)) return
          evt.request.headers.delete("content-length")
          evt.request = new Request(evt.request, { body: JSON.stringify(claudeCode(body)) })
        }),
      options,
    )
    yield* ctx.session.hook(
      "retry",
      (evt) =>
        Effect.sync(() => {
          if (evt.decision.retry && exhausted.test(evt.error.message)) evt.decision = { retry: false }
        }),
      options,
    )
  }),
} satisfies PluginInternal.InternalPlugin)

/**
 * The subscription endpoint requires the system field to be exactly the Claude
 * Code identity. opencode's instructions move, cache hints included, to a user
 * turn in front of the history so the model still follows them.
 */
export function claudeCode(body: Body) {
  const instructions = typeof body.system === "string" ? [{ type: "text", text: body.system }] : (body.system ?? [])
  return {
    ...body,
    system: [{ type: "text", text: identity }],
    messages: instructions.length === 0 ? body.messages : [{ role: "user", content: instructions }, ...body.messages],
  }
}

type Body = typeof BodySchema.Type
const BodySchema = Schema.Struct({
  system: Schema.optional(Schema.Union([Schema.String, Schema.Array(Schema.Unknown)])),
  messages: Schema.Array(Schema.Unknown),
})
const isBody = Schema.is(BodySchema)
const decodeJson = Schema.decodeUnknownOption(Schema.fromJsonString(Schema.Unknown))

function token(body: Record<string, string>, refreshing: boolean) {
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
      return Schema.decodeUnknownSync(Tokens)(await response.json())
    },
    catch: (cause) => cause,
  })
}
