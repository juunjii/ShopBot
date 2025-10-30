import { GoogleGenerativeAIEmbeddings } from "@langchain/google-genai"; // For creating vector embeddings from text using Gemini
import { ChatGoogleGenerativeAI } from "@langchain/google-genai";
import { AIMessage, BaseMessage, HumanMessage } from "@langchain/core/messages"; // Message types for conversations
import {
  ChatPromptTemplate, // For creating structured prompts with placeholders
  MessagesPlaceholder, // Placeholder for dynamic message history
} from "@langchain/core/prompts";
import { StateGraph } from "@langchain/langgraph"; // State-based workflow orchestration
import { Annotation } from "@langchain/langgraph"; // Type annotations for state management
import { tool } from "@langchain/core/tools"; // For creating custom tools/functions
import { ToolNode } from "@langchain/langgraph/prebuilt"; // Pre-built node for executing tools
import { MongoDBSaver } from "@langchain/langgraph-checkpoint-mongodb"; // For saving conversation state
import { MongoDBAtlasVectorSearch } from "@langchain/mongodb";
import { MongoClient } from "mongodb";
import { z } from "zod";
import "dotenv/config";

// Utility function to handle API rate limits with exponential backoff
async function retryWithBackoff<T>(
  fn: () => Promise<T>, // The function to retry
  maxRetries = 3 // Maximum number of retry attempts
): Promise<T> {
  // Loop through retry attempts
  for (let attempt = 1; attempt <= maxRetries; attempt++) {
    try {
      return await fn(); // Try to execute the function
    } catch (error: any) {
      // Check if it's a rate limit error (HTTP 429) and we have retries left
      if (error.status === 429 && attempt < maxRetries) {
        // Calculate exponential backoff delay: 2^attempt seconds, max 30 seconds
        const delay = Math.min(1000 * Math.pow(2, attempt), 30000);
        console.error(`Rate limit hit. Retrying in ${delay / 1000} seconds...`);
        // Wait for the calculated delay before retrying
        await new Promise((resolve) => setTimeout(resolve, delay));
        continue; // Go to next iteration (retry)
      }
      throw error;
    }
  }
  throw new Error("Max retries exceeded");
}

// Main function that creates and runs the AI agent
export async function callAgent(
  client: MongoClient,
  query: string,
  thread_id: string
) {
  try {
    const dbName = "inventoryDB";
    const db = client.db(dbName);
    const collection = db.collection("items");

    // Define the state structure for the agent workflow
    const GraphState = Annotation.Root({
      messages: Annotation<BaseMessage[]>({
        // Reducer function: how to combine old and new messages
        reducer: (x, y) => x.concat(y), // Simply concatenate old messages (x) with new messages (y)
      }),
    });

    // Tool for searching furniture inventory
    const itemLookupTool = tool(
      async ({ query, n = 10 }) => {
        try {
          console.log("Item lookup tool called with query:", query);

          // Check if database has any data at all
          const totalCount = await collection.countDocuments();
          console.log(`Total documents in collection: ${totalCount}`);

          // Early return if database is empty
          if (totalCount === 0) {
            console.log("Collection is empty");
            return JSON.stringify({
              error: "No items found in inventory",
              message: "The inventory database appears to be empty",
              count: 0,
            });
          }

          // Get sample documents for debugging purposes
          const sampleDocs = await collection.find({}).limit(3).toArray();
          console.log("Sample documents:", sampleDocs);

          // Create vector store instance for semantic search using Google Gemini embeddings
          const vectorStore = new MongoDBAtlasVectorSearch(
            new GoogleGenerativeAIEmbeddings({
              apiKey: process.env.GOOGLE_API_KEY,
              model: "text-embedding-004",
            }),
            {
              collection,
              indexName: "vector_index",
              textKey: "embedding_text", // Text used for embeddings
              embeddingKey: "embedding",
            }
          );

          console.log("Performing vector search...");
          // Perform semantic search using vector embeddings
          const result = await vectorStore.similaritySearchWithScore(query, n);
          console.log(`Vector search returned ${result.length} results`);

          // If vector search returns no results, fall back to text search
          if (result.length === 0) {
            console.log(
              "Vector search returned no results, trying text search..."
            );
            // MongoDB text search using regular expressions
            const textResults = await collection
              .find({
                $or: [
                  // OR condition - match any of these fields; case insensitive
                  { item_name: { $regex: query, $options: "i" } }, 
                  { item_description: { $regex: query, $options: "i" } },
                  { categories: { $regex: query, $options: "i" } }, 
                  { embedding_text: { $regex: query, $options: "i" } }, 
                ],
              })
              .limit(n)
              .toArray(); // Limit results and convert to array

            console.log(`Text search returned ${textResults.length} results`);
            // Return text search results as JSON string
            return JSON.stringify({
              results: textResults,
              searchType: "text", // Indicate this was a text search
              query: query,
              count: textResults.length,
            });
          }

          // Return vector search results as JSON string
          return JSON.stringify({
            results: result,
            searchType: "vector", // Indicate this was a vector search
            query: query,
            count: result.length,
          });
        } catch (error: any) {
          // Log detailed error information for debugging
          console.error("Error in item lookup:", error);
          console.error("Error details:", {
            message: error.message,
            stack: error.stack,
            name: error.name,
          });

          // Return error information as JSON string
          return JSON.stringify({
            error: "Failed to search inventory",
            details: error.message,
            query: query,
          });
        }
      },
      // Tool metadata and schema definition
      {
        name: "item_lookup", // Tool name that the AI will reference
        description:
          "Gathers furniture item details from the Inventory database",
        schema: z.object({
          // Input validation schema
          query: z.string().describe("The search query"),
          n: z
            .number()
            .optional()
            .default(10)
            .describe("Number of results to return"),
        }),
      }
    );

    // Array of all available tools
    const tools = [itemLookupTool];
    // Create a tool execution node for the workflow
    const toolNode = new ToolNode<typeof GraphState.State>(tools);

    const model = new ChatGoogleGenerativeAI({
      model: "gemini-2.5-flash",
      temperature: 0, // Deterministic responses
      maxRetries: 0,
      apiKey: process.env.GOOGLE_API_KEY,
    }).bindTools(tools); 

    // Decision function: determines next step in the workflow
    function shouldContinue(state: typeof GraphState.State) {
      const messages = state.messages; // Get all messages
      const lastMessage = messages[messages.length - 1] as AIMessage; // Get the most recent message
      const toolCalls = lastMessage.tool_calls || []; 

      // If the AI wants to use tools, go to tools node; otherwise end
      if (toolCalls.length > 0) {
        return "tools"; // Route to tool execution
      }
      return "__end__"; // End the workflow
    }

    // Function that calls the AI model with retry logic
    async function callModel(state: typeof GraphState.State) {
      return retryWithBackoff(async () => {
        // Create a structured prompt template
        const prompt = ChatPromptTemplate.fromMessages([
          [
            "system", // System message defines the AI's role and behavior
            `You are a helpful E-commerce Chatbot Agent for a furniture store. 

IMPORTANT: You have access to an item_lookup tool that searches the furniture inventory database. ALWAYS use this tool when customers ask about furniture items, even if the tool returns errors or empty results.

When using the item_lookup tool:
- If it returns results, provide helpful details about the furniture items
- If it returns an error or no results, acknowledge this and offer to help in other ways
- If the database appears to be empty, let the customer know that inventory might be being updated

Current time: {time}`,
          ],
          new MessagesPlaceholder("messages"), // Placeholder for conversation history
        ]);

        // Fill in the prompt template with actual values
        const formattedPrompt = await prompt.formatMessages({
          time: new Date().toISOString(), // Current timestamp
          messages: state.messages, // All previous messages
        });

        // Call the AI model with the formatted prompt
        const result = await model.invoke(formattedPrompt);
        // Return new state with the AI's response added
        return { messages: [result] };
      });
    }

    // Build the workflow graph
    const workflow = new StateGraph(GraphState)
      .addNode("agent", callModel) // Add AI model node
      .addNode("tools", toolNode) // Add tool execution node
      .addEdge("__start__", "agent") // Start workflow at agent
      .addConditionalEdges("agent", shouldContinue) // Agent decides: tools or end
      .addEdge("tools", "agent"); // After tools, go back to agent

    // Initialize conversation state persistence
    const checkpointer = new MongoDBSaver({ client, dbName });
    // Compile the workflow with state saving
    const app = workflow.compile({ checkpointer });

    // Execute the workflow
    const finalState = await app.invoke(
      {
        messages: [new HumanMessage(query)], // Start with user's question
      },
      {
        recursionLimit: 15, // Prevent infinite loops
        configurable: { thread_id: thread_id }, // Conversation thread identifier
      }
    );

    // Extract the final response from the conversation
    const response =
      finalState.messages[finalState.messages.length - 1].content;
    console.log("Agent response:", response);

    return response; // AI's final response
  } catch (error: any) {
    // Handle different types of errors with user-friendly messages
    console.error("Error in callAgent:", error.message);

    if (error.status === 429) {
      // Rate limit error
      throw new Error(
        "Service temporarily unavailable due to rate limits. Please try again in a minute."
      );
    } else if (error.status === 401) {
      // Authentication error
      throw new Error(
        "Authentication failed. Please check your API configuration."
      );
    } else {
      // Generic error
      throw new Error(`Agent failed: ${error.message}`);
    }
  }
}
