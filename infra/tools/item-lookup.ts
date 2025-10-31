import { tool } from "@langchain/core/tools";
import { z } from "zod";
import { GoogleGenerativeAIEmbeddings } from "@langchain/google-genai";
import { MongoDBAtlasVectorSearch } from "@langchain/mongodb";
import { Collection } from "mongodb";
import { SearchError } from "../types";

export const createItemLookupTool = (collection: Collection) =>
  tool(
    async ({ query, n = 10 }: { query: string; n?: number }) => {
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
        //   const sampleDocs = await collection.find({}).limit(3).toArray();
        //   console.log("Sample documents:", sampleDocs);

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
      } catch (error) {
        // Log detailed error information for debugging
        console.error("Error in item lookup:", error);

        const errorDetails =
          error instanceof Error
            ? {
                message: error.message,
                stack: error.stack,
                name: error.name,
              }
            : String(error);

        console.error("Error details:", errorDetails);

        // Return error information as JSON string
        const errorResponse: SearchError = {
          error: "Failed to search inventory",
          details: error instanceof Error ? error.message : String(error),
          query,
        };
        return JSON.stringify(errorResponse);
      }
    },
    // Tool metadata and schema definition
    {
      name: "item_lookup", // Tool name that the AI will reference
      description: "Gathers furniture item details from the Inventory database",
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
