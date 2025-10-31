import { BaseMessage } from "@langchain/core/messages";
import { Annotation } from "@langchain/langgraph";
import { z } from "zod";

export interface SearchResult {
  results: Record<string, unknown>[];
  searchType: "vector" | "text";
  query: string;
  count: number;
}

export interface SearchError {
  error: string;
  details?: string;
  query?: string;
}

export interface ItemLookupParams {
  query: string;
  n?: number;
}

export const ItemLookupSchema = z.object({
  query: z.string().describe("The search query"),
  n: z.number().optional().default(10).describe("Number of results to return"),
});

export interface BaseMessageWithToolCalls extends BaseMessage {
  tool_calls?: unknown[];
}

export interface AgentError extends Error {
  status?: number;
}

// Define the state structure for the agent workflow
export const GraphState = Annotation.Root({
  messages: Annotation<BaseMessage[]>({
    reducer: (x: BaseMessage[], y: BaseMessage[]) => x.concat(y),
  }),
});