import { ChatGoogleGenerativeAI } from "@langchain/google-genai";
import {
  ChatPromptTemplate,
  MessagesPlaceholder,
} from "@langchain/core/prompts";
import { DynamicStructuredTool } from "@langchain/core/tools";
import { BaseMessage } from "@langchain/core/messages";

export function createChatModel(tools: DynamicStructuredTool[]) {
  return new ChatGoogleGenerativeAI({
    model: "gemini-2.5-flash",
    temperature: 0,
    maxRetries: 0,
    apiKey: process.env.GOOGLE_API_KEY,
  }).bindTools(tools);
}

export function createPromptTemplate() {
  return ChatPromptTemplate.fromMessages<{
    time: string;
    messages: BaseMessage[];
  }>([
    [
      "system",
      `You are a helpful E-commerce Chatbot Agent for a furniture store. 

IMPORTANT: You have access to an item_lookup tool that searches the furniture inventory database. ALWAYS use this tool when customers ask about furniture items, even if the tool returns errors or empty results.

When using the item_lookup tool:
- If it returns results, provide helpful details about the furniture items
- If it returns an error or no results, acknowledge this and offer to help in other ways
- If the database appears to be empty, let the customer know that inventory might be being updated

Current time: {time}`,
    ],
    new MessagesPlaceholder("messages"),
  ]);
}
