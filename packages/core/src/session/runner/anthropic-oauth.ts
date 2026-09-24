import { LLMEvent, Message, ToolDefinition, type ContentPart, type Message as LLMMessage } from "@opencode-ai/llm"

// The subscription endpoint rejects the built-in tool's internal name.
export const alias = "TodoWrite"
export const toolAlias = (input: readonly ToolDefinition[]) =>
  input.some((tool) => tool.name === alias) ? "OpenCodeTodoWrite" : alias

export function messages(input: readonly LLMMessage[], wireName = alias) {
  return input.map((message) =>
    Message.make({
      id: message.id,
      role: message.role === "system" ? "user" : message.role,
      metadata: message.metadata,
      native: message.native,
      content: message.content.map(
        (part): ContentPart =>
          (part.type === "tool-call" || part.type === "tool-result") && part.name === "todowrite"
            ? { ...part, name: wireName }
            : part,
      ),
    }),
  )
}

export function tools(input: readonly ToolDefinition[], wireName = toolAlias(input)) {
  if (
    input.some((tool) => tool.name === wireName && tool.name !== "todowrite") &&
    input.some((tool) => tool.name === "todowrite")
  )
    throw new Error(`Anthropic OAuth tool alias ${wireName} conflicts with another tool`)
  return input.map((tool) => (tool.name === "todowrite" ? ToolDefinition.make({ ...tool, name: wireName }) : tool))
}

export function event(value: LLMEvent, wireName = alias): LLMEvent {
  if (!("name" in value) || value.name !== wireName) return value
  switch (value.type) {
    case "tool-input-start":
      return LLMEvent.toolInputStart({ ...value, name: "todowrite" })
    case "tool-input-delta":
      return LLMEvent.toolInputDelta({ ...value, name: "todowrite" })
    case "tool-input-end":
      return LLMEvent.toolInputEnd({ ...value, name: "todowrite" })
    case "tool-call":
      return LLMEvent.toolCall({ ...value, name: "todowrite" })
    case "tool-result":
      return LLMEvent.toolResult({ ...value, name: "todowrite" })
    case "tool-error":
      return LLMEvent.toolError({ ...value, name: "todowrite" })
    default:
      return value
  }
}
