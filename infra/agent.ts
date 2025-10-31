import { MongoClient } from "mongodb";
import { AIMessage, HumanMessage } from "@langchain/core/messages";
import { StateGraph } from "@langchain/langgraph";
import { ToolNode } from "@langchain/langgraph/prebuilt";
import { MongoDBSaver } from "@langchain/langgraph-checkpoint-mongodb";
import { retryWithBackoff } from "./utils/retry";
import { GraphState, AgentError } from "./types";
import { createItemLookupTool } from "./tools/item-lookup";
import { createChatModel, createPromptTemplate } from "./config/model";
import "dotenv/config";

export async function callAgent(
  client: MongoClient,
  query: string,
  thread_id: string
) {
  try {
    const dbName = "inventoryDB";
    const db = client.db(dbName);
    const collection = db.collection("items");

    // Initialize tools
    const itemLookupTool = createItemLookupTool(collection);
    const tools = [itemLookupTool];
    const toolNode = new ToolNode<typeof GraphState.State>(tools);

    // Initialize model and prompt
    const model = createChatModel(tools);
    const prompt = createPromptTemplate();

    // Decision function: determines next step in the workflow
    function shouldContinue(state: typeof GraphState.State) {
      const messages = state.messages;
      const lastMessage = messages[messages.length - 1] as AIMessage;
      const toolCalls = lastMessage.tool_calls || [];
      return toolCalls.length > 0 ? "tools" : "__end__";
    }

    // Function that calls the AI model with retry logic
    async function callModel(state: typeof GraphState.State) {
      return retryWithBackoff(async () => {
        const formattedPrompt = await prompt.formatMessages({
          time: new Date().toISOString(),
          messages: state.messages,
        });

        const result = await model.invoke(formattedPrompt);
        return { messages: [result] };
      });
    }

    // Build the workflow graph
    const workflow = new StateGraph(GraphState)
      .addNode("agent", callModel)
      .addNode("tools", toolNode)
      .addEdge("__start__", "agent")
      .addConditionalEdges("agent", shouldContinue)
      .addEdge("tools", "agent");

    // Initialize conversation state persistence
    const checkpointer = new MongoDBSaver({ client, dbName });
    const app = workflow.compile({ checkpointer });

    // Execute the workflow
    const finalState = await app.invoke(
      {
        messages: [new HumanMessage(query)],
      },
      {
        recursionLimit: 15,
        configurable: { thread_id },
      }
    );

    // Extract the final response from the conversation
    const response =
      finalState.messages[finalState.messages.length - 1].content;
    console.log("Agent response:", response);

    const responseContent =
      typeof response === "string" ? response : JSON.stringify(response);
    return responseContent; // Return the AI's final response
  } catch (error) {
    if (error instanceof Error) {
      console.error("Error in callAgent:", error.message);
      const agentError = error as AgentError;

      if (agentError.status === 429) {
        // Rate limit error
        throw new Error(
          "Service temporarily unavailable due to rate limits. Please try again in a minute."
        );
      } else if (agentError.status === 401) {
        // Authentication error
        throw new Error(
          "Authentication failed. Please check your API configuration."
        );
      } else {
        // Known Error with message
        throw new Error(`Agent failed: ${error.message}`);
      }
    } else {
      // Unknown error type
      throw new Error(`Agent failed: ${String(error)}`);
    }
  }
}
