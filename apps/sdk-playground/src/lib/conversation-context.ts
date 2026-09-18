import { buildConversationContextQuery as buildConversationMemoryQuery } from "@supermemory/tools"

type ConversationMessage = {
	role: "user" | "assistant" | "system"
	content: string
}

export function buildConversationContextQuery(
	messages: ConversationMessage[],
): string {
	return buildConversationMemoryQuery(messages)
}
