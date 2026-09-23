import { describe, expect, test } from "bun:test"
import { Effect } from "effect"
import { jsonSchema } from "ai"
import { AnthropicAuthPlugin, CLAUDE_CODE_SYSTEM } from "../../src/plugin/anthropic"
import { LLMRequestPrep } from "@/session/llm/request"

type Credentials = { type: "oauth"; access: string; refresh: string; expires: number } | { type: "api"; key: string }

const CLIENT_ID = atob("OWQxYzI1MGEtZTYxYi00NGQ5LTg4ZWQtNTk0NGQxOTYyZjVl")

function oauth(overrides: Partial<Extract<Credentials, { type: "oauth" }>> = {}): Credentials {
  return {
    type: "oauth",
    access: "access-token",
    refresh: "refresh-token",
    expires: Date.now() + 3_600_000,
    ...overrides,
  }
}

function makeInput() {
  const setCalls: Array<{ path: { id: string }; body: Record<string, unknown> }> = []
  return {
    input: {
      client: {
        auth: {
          set: async (request: { path: { id: string }; body: Record<string, unknown> }) => {
            setCalls.push(request)
          },
        },
      },
    } as any,
    setCalls,
  }
}

/** Stand-in for both api.anthropic.com inference and the OAuth token endpoint. */
function makeServer() {
  const requests: { url: string; headers: Headers; body: string }[] = []
  const server = Bun.serve({
    port: 0,
    fetch: async (request) => {
      requests.push({ url: request.url, headers: request.headers, body: await request.text() })
      return new Response(
        JSON.stringify({ access_token: "rotated", refresh_token: "rotated-refresh", expires_in: 3600 }),
        {
          headers: { "content-type": "application/json" },
        },
      )
    },
  })
  return {
    requests,
    server,
    url: (path: string) => new URL(path, server.url).toString(),
    tokenRequests: () => requests.filter((request) => request.url.includes("/oauth/token")),
    messageRequests: () => requests.filter((request) => request.url.includes("/messages")),
  }
}

function loaderOptions(credentials: Credentials, input: ReturnType<typeof makeInput>["input"], tokenUrl?: string) {
  const hooks = AnthropicAuthPlugin(input, tokenUrl ? { tokenUrl } : {})
  return hooks.then((result) => result.auth!.loader!(async () => credentials, undefined as any))
}

describe("plugin.anthropic", () => {
  test("exposes a Claude Pro/Max method alongside the API key", async () => {
    const hooks = await AnthropicAuthPlugin(makeInput().input)
    const methods = hooks.auth!.methods

    expect(methods.map((method) => method.type)).toEqual(["oauth", "api"])
    // The desktop connect dialog keys its Claude Pro/Max title off this label.
    expect(methods[0].label.toLowerCase()).toContain("max")
  })

  test("loader is a no-op when credentials are not an oauth token", async () => {
    const options = await loaderOptions({ type: "api", key: "sk-ant-api" }, makeInput().input)
    expect(options).toEqual({})
  })

  test("swaps the SDK api key for a Claude Code bearer and beta list", async () => {
    const srv = makeServer()
    const options = await loaderOptions(oauth(), makeInput().input)
    expect(options.apiKey).toBe("opencode-oauth-dummy-key")

    const init: RequestInit = {
      method: "POST",
      headers: {
        "x-api-key": "opencode-oauth-dummy-key",
        "Content-Type": "application/json",
        "anthropic-beta": "interleaved-thinking-2025-05-14",
      },
      body: "{}",
    }
    await (options.fetch as (input: RequestInfo | URL, init?: RequestInit) => Promise<Response>)(
      new Request(srv.url("/v1/messages")),
      init,
    )

    const sent = srv.requests[0].headers
    expect(sent.get("authorization")).toBe("Bearer access-token")
    expect(sent.get("x-api-key")).toBeNull()
    expect(sent.get("user-agent")).toBe("claude-cli/2.1.281 (external, cli)")
    expect(sent.get("x-app")).toBe("cli")
    expect(sent.get("anthropic-beta")?.split(",")).toEqual(
      expect.arrayContaining(["claude-code-20250219", "oauth-2025-04-20", "interleaved-thinking-2025-05-14"]),
    )
    // The caller's init is reused by the AI SDK on retry, so it must stay intact.
    expect((init.headers as Record<string, string>)["x-api-key"]).toBe("opencode-oauth-dummy-key")
    expect(init.headers).not.toHaveProperty("set")

    srv.server.stop(true)
  })

  test("collapses concurrent refreshes onto one rotated refresh token", async () => {
    const srv = makeServer()
    const { input, setCalls } = makeInput()
    const options = await loaderOptions(oauth({ expires: Date.now() - 1 }), input, srv.url("/v1/oauth/token"))
    const fetchOption = options.fetch as (input: RequestInfo | URL, init?: RequestInit) => Promise<Response>

    await Promise.all([
      fetchOption(new Request(srv.url("/v1/messages")), {
        method: "POST",
        headers: { "x-api-key": "dummy" },
        body: "{}",
      }),
      fetchOption(new Request(srv.url("/v1/messages")), {
        method: "POST",
        headers: { "x-api-key": "dummy" },
        body: "{}",
      }),
    ])

    expect(srv.tokenRequests().length).toBe(1)
    expect(srv.messageRequests().length).toBe(2)

    const token = srv.tokenRequests()[0]
    expect(JSON.parse(token.body)).toEqual({
      grant_type: "refresh_token",
      client_id: CLIENT_ID,
      refresh_token: "refresh-token",
    })
    expect(token.headers.get("anthropic-beta")).toBe("oauth-2025-04-20")
    expect(token.headers.get("user-agent")).toBe("anthropic-sdk-typescript/0.112.1 userOAuthProvider")

    // Anthropic rotates the refresh token on every use, so the new copy is the
    // only one that can refresh again.
    expect(setCalls.length).toBe(1)
    expect(setCalls[0].body).toMatchObject({ type: "oauth", access: "rotated", refresh: "rotated-refresh" })
    expect(srv.messageRequests().every((request) => request.headers.get("authorization") === "Bearer rotated")).toBe(
      true,
    )

    srv.server.stop(true)
  })

  test("passes requests through untouched once credentials become an api key", async () => {
    const srv = makeServer()
    let credentials: Credentials = oauth()
    const hooks = await AnthropicAuthPlugin(makeInput().input)
    const options = await hooks.auth!.loader!(async () => credentials, undefined as any)

    credentials = { type: "api", key: "sk-ant-live" }
    const init: RequestInit = { headers: { "x-api-key": "sk-ant-live" } }
    await (options.fetch as (input: RequestInfo | URL, init?: RequestInit) => Promise<Response>)(
      new Request(srv.url("/v1/messages")),
      init,
    )

    expect(srv.requests[0].headers.get("x-api-key")).toBe("sk-ant-live")
    expect(srv.requests[0].headers.get("authorization")).toBeNull()

    srv.server.stop(true)
  })

  test("exchanges the loopback callback for a subscription token", async () => {
    const srv = makeServer()
    const hooks = await AnthropicAuthPlugin(makeInput().input, {
      tokenUrl: srv.url("/v1/oauth/token"),
      callbackPort: 0,
    })
    const method = hooks.auth!.methods[0]
    if (method.type !== "oauth") throw new Error("expected an oauth method")

    const started = await method.authorize()
    expect(started.method).toBe("auto")
    if (started.method !== "auto") throw new Error("expected an auto callback")

    const url = new URL(started.url)
    expect(url.origin + url.pathname).toBe("https://claude.ai/oauth/authorize")
    expect(url.searchParams.get("client_id")).toBe(CLIENT_ID)
    expect(url.searchParams.get("code")).toBe("true")
    expect(url.searchParams.get("code_challenge_method")).toBe("S256")
    expect(url.searchParams.get("scope")).toContain("user:inference")
    const redirect = url.searchParams.get("redirect_uri")!
    const state = url.searchParams.get("state")!
    expect(redirect).toMatch(/^http:\/\/localhost:\d+\/callback$/)

    const response = await fetch(`${redirect}?code=auth-code&state=${state}`)
    expect(response.status).toBe(200)

    const result = await started.callback()
    expect(result).toMatchObject({ type: "success", access: "rotated", refresh: "rotated-refresh" })

    const exchange = srv.tokenRequests()[0]
    expect(JSON.parse(exchange.body)).toEqual({
      grant_type: "authorization_code",
      client_id: CLIENT_ID,
      code: "auth-code",
      state,
      redirect_uri: redirect,
      code_verifier: expect.any(String),
    })

    srv.server.stop(true)
  })

  test("rejects a callback carrying a mismatched state", async () => {
    const srv = makeServer()
    const hooks = await AnthropicAuthPlugin(makeInput().input, {
      tokenUrl: srv.url("/v1/oauth/token"),
      callbackPort: 0,
    })
    const method = hooks.auth!.methods[0]
    if (method.type !== "oauth") throw new Error("expected an oauth method")

    const started = await method.authorize()
    if (started.method !== "auto") throw new Error("expected an auto callback")
    const redirect = new URL(started.url).searchParams.get("redirect_uri")!
    await fetch(`${redirect}?code=auth-code&state=someone-elses`)

    await expect(started.callback()).rejects.toThrow("Invalid state")

    srv.server.stop(true)
  })
})

describe("plugin.anthropic subscription system prompt", () => {
  const instructions = "You are opencode, a CLI coding agent."

  function prepareRequest(auth: { type: "oauth" } | { type: "api"; key: string }) {
    return Effect.runPromise(
      LLMRequestPrep.prepare({
        user: {
          id: "msg_test",
          sessionID: "ses_test",
          role: "user",
          time: { created: Date.now() },
          agent: "test",
          model: { providerID: "anthropic", modelID: "claude-sonnet-5", variant: "medium" },
        } as any,
        sessionID: "ses_test",
        model: {
          id: "anthropic/claude-sonnet-5",
          providerID: "anthropic",
          api: { id: "claude-sonnet-5", url: "https://api.anthropic.com", npm: "@ai-sdk/anthropic" },
          name: "Claude Sonnet 5",
          capabilities: {
            temperature: false,
            reasoning: false,
            attachment: false,
            toolcall: true,
            input: { text: true, audio: false, image: false, video: false, pdf: false },
            output: { text: true, audio: false, image: false, video: false, pdf: false },
            interleaved: false,
          },
          cost: { input: 0, output: 0, cache: { read: 0, write: 0 } },
          limit: { context: 200_000, output: 64_000 },
          options: {},
        } as any,
        agent: {
          name: "test",
          mode: "primary",
          prompt: instructions,
          options: {},
          permission: [],
        } as any,
        system: ["Follow AGENTS.md."],
        messages: [{ role: "user", content: "Hello" }],
        tools: {
          lookup: {
            description: "Look up a value",
            inputSchema: jsonSchema({ type: "object", properties: {} }),
          },
          todowrite: {
            description: "Update the todo list",
            inputSchema: jsonSchema({ type: "object", properties: {} }),
          },
        },
        provider: { id: "anthropic", options: {} } as any,
        auth: auth as any,
        plugin: {
          trigger: (_name: string, _input: unknown, output: unknown) => Effect.succeed(output),
          list: () => Effect.succeed([]),
          init: () => Effect.void,
        } as any,
        flags: { outputTokenMax: 32_000, client: "test" } as any,
        isWorkflow: false,
      }),
    )
  }

  test("claims the Claude Code identity and demotes opencode instructions to the conversation", async () => {
    const result = await prepareRequest({ type: "oauth" })

    // Anthropic rejects anything but this exact string as system.
    expect(result.messages[0]).toEqual({ role: "system", content: CLAUDE_CODE_SYSTEM })
    expect(result.messages[0]).toEqual({
      role: "system",
      content: "You are Claude Code, Anthropic's official CLI for Claude.",
    })
    // The instructions survive as the first user message instead.
    expect(result.messages[1]).toEqual({ role: "user", content: `${instructions}\nFollow AGENTS.md.` })
    expect(result.messages[2]).toEqual({ role: "user", content: "Hello" })
    // Callers that read the prepared system (workflow prompts) still get them.
    expect(result.system.join("\n")).toContain("Follow AGENTS.md.")
  })

  test("keeps the opencode system prompt when credentials are an api key", async () => {
    const result = await prepareRequest({ type: "api", key: "sk-ant-api" })

    expect(result.messages).toHaveLength(2)
    expect(result.messages[0]).toEqual({ role: "system", content: `${instructions}\nFollow AGENTS.md.` })
    expect(result.messages[0].content).not.toContain(CLAUDE_CODE_SYSTEM)
  })

  test("renames todowrite, the tool Anthropic rejects on subscription requests", async () => {
    const result = await prepareRequest({ type: "oauth" })

    // A verbatim `todowrite` in `tools` gets a 400 "out of extra usage" back.
    expect(result.tools.todowrite).toBeUndefined()
    expect(Object.keys(result.tools).sort()).toEqual(["TodoWrite", "lookup"])
    // The alias only relabels the key; the tool itself is untouched.
    expect(result.tools.TodoWrite.description).toBe("Update the todo list")
  })

  test("keeps the todowrite tool name when credentials are an api key", async () => {
    const result = await prepareRequest({ type: "api", key: "sk-ant-api" })

    expect(Object.keys(result.tools).sort()).toEqual(["lookup", "todowrite"])
    expect(result.tools.TodoWrite).toBeUndefined()
  })
})
