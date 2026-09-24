import { describe, expect, test } from "bun:test"
import { LLMEvent, Message, ToolCallPart, ToolDefinition, ToolResultPart } from "@opencode-ai/llm"
import { event, messages, toolAlias, tools } from "../src/session/runner/anthropic-oauth"
import { registration } from "../src/plugin/provider/anthropic-oauth"

describe("V2 Anthropic OAuth", () => {
  test("registers a subscription login with refresh", () => {
    expect(registration.method).toMatchObject({ type: "oauth", label: "Claude Pro/Max" })
    expect(registration.refresh).toBeFunction()
  })

  test("maps only the subscription todo name and preserves tool history", () => {
    const history = messages([
      Message.system("Changed instructions"),
      Message.assistant(ToolCallPart.make({ id: "call_1", name: "todowrite", input: {} })),
      Message.tool(ToolResultPart.make({ id: "call_1", name: "todowrite", result: "done" })),
    ])
    expect(history[0].role).toBe("user")
    expect(history[1].content[0]).toMatchObject({ type: "tool-call", name: "TodoWrite" })
    expect(history[2].content[0]).toMatchObject({ type: "tool-result", name: "TodoWrite" })
    expect(
      tools([ToolDefinition.make({ name: "todowrite", description: "Todo", inputSchema: { type: "object" } })])[0].name,
    ).toBe("TodoWrite")
    expect(event(LLMEvent.toolCall({ id: "call_2", name: "TodoWrite", input: {} }))).toMatchObject({
      name: "todowrite",
    })
  })

  test("keeps a user-defined TodoWrite distinct from the built-in todo tool", () => {
    const definitions = ["todowrite", "TodoWrite"].map((name) =>
      ToolDefinition.make({ name, description: name, inputSchema: { type: "object" } }),
    )
    const wireName = toolAlias(definitions)

    expect(tools(definitions, wireName).map((tool) => tool.name)).toEqual(["OpenCodeTodoWrite", "TodoWrite"])
    expect(event(LLMEvent.toolCall({ id: "call_1", name: wireName, input: {} }), wireName)).toMatchObject({
      name: "todowrite",
    })
    expect(event(LLMEvent.toolCall({ id: "call_2", name: "TodoWrite", input: {} }), wireName)).toMatchObject({
      name: "TodoWrite",
    })
  })
})
