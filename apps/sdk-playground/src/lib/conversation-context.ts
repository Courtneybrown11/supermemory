import { extractQueryText } from "../../../../packages/tools/src/shared/memory-client"

type ConversationMessage = {
	role: "user" | "assistant" | "system"
	content: string
}

export function buildConversationContextQuery(
	messages: ConversationMessage[],
): string {
	return extractQueryText(messages, "full")
}
