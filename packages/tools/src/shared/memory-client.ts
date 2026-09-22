import {
	deduplicateMemoriesForMode,
	getMemoryText,
	normalizeMemoryFact,
} from "../tools-shared"
import type {
	Logger,
	MemoryMode,
	MemoryPromptData,
	ProfileStructure,
	PromptTemplate,
} from "./types"
import {
	convertProfileToMarkdown,
	defaultPromptTemplate,
} from "./prompt-builder"

/**
 * Fetches profile and search results from the Supermemory API.
 *
 * @param containerTag - The container tag/user ID for scoping memories
 * @param queryText - Optional query text for semantic search
 * @param baseUrl - The API base URL
 * @param apiKey - The API key for authentication
 * @param signal - Optional AbortSignal to cancel the request (e.g. retrieval timeout)
 * @returns The profile structure with static, dynamic, and search results
 */
export const supermemoryProfileSearch = async (
	containerTag: string,
	queryText: string,
	baseUrl: string,
	apiKey: string,
	signal?: AbortSignal,
): Promise<ProfileStructure> => {
	const payload = queryText
		? JSON.stringify({
				q: queryText,
				containerTag: containerTag,
				include: ["static", "dynamic"],
			})
		: JSON.stringify({
				containerTag: containerTag,
				include: ["static", "dynamic"],
			})

	try {
		const response = await fetch(`${baseUrl}/v4/profile`, {
			method: "POST",
			headers: {
				"Content-Type": "application/json",
				Authorization: `Bearer ${apiKey}`,
			},
			body: payload,
			...(signal ? { signal } : {}),
		})

		if (!response.ok) {
			const errorText = await response.text().catch(() => "Unknown error")
			throw new Error(
				`Supermemory profile search failed: ${response.status} ${response.statusText}. ${errorText}`,
			)
		}

		return await response.json()
	} catch (error) {
		if (error instanceof Error) {
			throw error
		}
		throw new Error(`Supermemory API request failed: ${error}`)
	}
}

/**
 * Options for building memories text.
 */
export interface BuildMemoriesTextOptions {
	containerTag: string
	queryText: string
	mode: MemoryMode
	baseUrl: string
	apiKey: string
	logger: Logger
	promptTemplate?: PromptTemplate
	signal?: AbortSignal
}

/**
 * Fetches memories from the API, deduplicates them, and formats them into
 * the final string to be injected into the system prompt.
 *
 * @param options - Configuration for building memories text
 * @returns The final formatted memories string ready for injection
 */
export const buildMemoriesText = async (
	options: BuildMemoriesTextOptions,
): Promise<string> => {
	const {
		containerTag,
		queryText,
		mode,
		baseUrl,
		apiKey,
		logger,
		promptTemplate = defaultPromptTemplate,
		signal,
	} = options

	const memoriesResponse = await supermemoryProfileSearch(
		containerTag,
		queryText,
		baseUrl,
		apiKey,
		signal,
	)

	const memoryCountStatic = memoriesResponse.profile.static?.length || 0
	const memoryCountDynamic = memoriesResponse.profile.dynamic?.length || 0

	logger.info("Memory search completed", {
		containerTag,
		memoryCountStatic,
		memoryCountDynamic,
		queryText:
			queryText.substring(0, 100) + (queryText.length > 100 ? "..." : ""),
		mode,
	})

	const rawSearchResults = memoriesResponse.searchResults?.results ?? []
	const deduplicated = deduplicateMemoriesForMode(mode, {
		static: memoriesResponse.profile.static,
		dynamic: memoriesResponse.profile.dynamic,
		searchResults: rawSearchResults,
	})

	logger.debug("Memory deduplication completed", {
		static: {
			original: memoryCountStatic,
			deduplicated: deduplicated.static.length,
		},
		dynamic: {
			original: memoryCountDynamic,
			deduplicated: deduplicated.dynamic.length,
		},
		searchResults: {
			original: memoriesResponse.searchResults?.results?.length,
			deduplicated: deduplicated.searchResults?.length,
		},
	})

	const userMemories =
		mode !== "query"
			? convertProfileToMarkdown({
					profile: {
						static: deduplicated.static,
						dynamic: deduplicated.dynamic,
					},
					searchResults: { results: [] },
				})
			: ""
	const generalSearchMemories =
		mode !== "profile" && deduplicated.searchResults.length > 0
			? `Search results for the current conversation context: \n${deduplicated.searchResults
					.map((memory) => `- ${memory}`)
					.join("\n")}`
			: ""
	const visibleSearchKeys = new Set(
		deduplicated.searchResults.map(normalizeMemoryFact),
	)
	const seenSearchKeys = new Set<string>()
	const deduplicatedSearchResults = rawSearchResults.flatMap((result) => {
		const memory = getMemoryText(result)
		if (!memory) return []
		const key = normalizeMemoryFact(memory)
		if (!visibleSearchKeys.has(key) || seenSearchKeys.has(key)) return []
		seenSearchKeys.add(key)
		return [{ ...result, memory }]
	})

	const promptData: MemoryPromptData = {
		userMemories,
		generalSearchMemories,
		searchResults: deduplicatedSearchResults,
	}

	const memories = promptTemplate(promptData)
	if (memories) {
		logger.debug("Memory content preview", {
			content: memories,
			fullLength: memories.length,
		})
	}

	return memories
}

/**
 * Generic interface for a message with role and content.
 * Framework-agnostic to support both Vercel AI SDK and Mastra.
 */
export interface GenericMessage {
	role: string
	content: unknown
}

const extractTextContent = (content: unknown): string => {
	if (typeof content === "string") {
		return content.trim()
	}

	if (Array.isArray(content)) {
		return content
			.filter(
				(part): part is { type: string; text?: string } =>
					typeof part === "object" &&
					part !== null &&
					"type" in part &&
					("text" in part || part.type === "text" || part.type === "input_text"),
			)
			.filter((part) => part.type === "text" || part.type === "input_text")
			.map((part) => part.text?.trim() || "")
			.filter(Boolean)
			.join(" ")
	}

	const objContent = content as
		| {
				content?: string
				parts?: Array<{ type: string; text?: string }>
		  }
		| null
		| undefined
	if (typeof objContent === "object" && objContent !== null) {
		if (typeof objContent.content === "string") {
			return objContent.content.trim()
		}
		if (Array.isArray(objContent.parts)) {
			return objContent.parts
				.filter((part) => part.type === "text" || part.type === "input_text")
				.map((part) => part.text?.trim() || "")
				.filter(Boolean)
				.join(" ")
		}
	}

	return ""
}

/**
 * Extracts the query text from messages based on mode.
 * For "profile" mode, returns empty string (no query needed).
 * For "query" or "full" mode, extracts the conversation context up to the
 * current user turn.
 *
 * This is a framework-agnostic version that works with any message array.
 *
 * @param messages - Array of messages with role and content
 * @param mode - The memory retrieval mode
 * @returns The query text for memory search
 */
export const extractQueryText = (
	messages: GenericMessage[],
	mode: MemoryMode,
): string => {
	if (mode === "profile") {
		return ""
	}

	let lastUserIndex = -1
	for (let index = messages.length - 1; index >= 0; index -= 1) {
		if (messages[index]?.role === "user") {
			lastUserIndex = index
			break
		}
	}
	if (lastUserIndex < 0) return ""

	return messages
		.slice(0, lastUserIndex + 1)
		.flatMap((message) => {
			if (message.role !== "user" && message.role !== "assistant") return []
			const content = extractTextContent(message.content)
			if (!content) return []
			const role = message.role === "user" ? "User" : "Assistant"
			return [`${role}: ${content}`]
		})
		.join("\n\n")
}

export const buildConversationContextQuery = (
	messages: GenericMessage[],
): string => extractQueryText(messages, "full")

/**
 * Extracts text content from the last user message in a message array.
 *
 * @param messages - Array of messages with role and content
 * @returns The last user message text, or undefined if not found
 */
export const getLastUserMessageText = (
	messages: GenericMessage[],
): string | undefined => {
	const lastUserMessage = messages
		.slice()
		.reverse()
		.find((msg) => msg.role === "user")

	if (!lastUserMessage) {
		return undefined
	}

	return extractTextContent(lastUserMessage.content) || undefined
}
