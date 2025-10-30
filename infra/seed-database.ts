// Import Google's Gemini chat model and embeddings for AI text generation and vector creation
import {
  ChatGoogleGenerativeAI,
  GoogleGenerativeAIEmbeddings,
} from "@langchain/google-genai";
import { StructuredOutputParser } from "@langchain/core/output_parsers"; // AI returns data in specific format
import { MongoClient } from "mongodb";
import { MongoDBAtlasVectorSearch } from "@langchain/mongodb"; // storing and searching embeddings
import { z } from "zod";
import "dotenv/config";

const client = new MongoClient(process.env.MONGODB_ATLAS_URI ?? "");

const llm = new ChatGoogleGenerativeAI({
  model: "gemini-2.5-flash",
  temperature: 0.7, // creativity level
  apiKey: process.env.GOOGLE_API_KEY,
});

const itemSchema = z.object({
  item_id: z.string(),
  item_name: z.string(),
  item_description: z.string(),
  brand: z.string(),
  manufacturer_address: z.object({
    street: z.string(),
    city: z.string(),
    state: z.string(),
    postal_code: z.string(),
    country: z.string(),
  }),
  prices: z.object({
    full_price: z.number(),
    sale_price: z.number(),
  }),
  categories: z.array(z.string()),
  user_reviews: z.array(
    z.object({
      review_date: z.string(),
      rating: z.number(),
      comment: z.string(),
    })
  ),
  notes: z.string(),
});

type Item = z.infer<typeof itemSchema>;

// AI output matches schema
const parser = StructuredOutputParser.fromZodSchema(z.array(itemSchema));

async function setupDatabaseAndCollection(): Promise<void> {
  console.log("Setting up database and collection...");

  const db = client.db("inventoryDB");

  const collections = await db.listCollections({ name: "items" }).toArray();
  if (collections.length === 0) {
    await db.createCollection("items");
    console.log("Created 'items' collection in 'inventoryDB' database.");
  } else {
    console.log("'items' collection already exists in 'inventoryDB' database.");
  }
}

// Allowing quick vector searches; to enable search by meaning
async function createVectorSearchIndex(): Promise<void> {
  try {
    const db = client.db("inventoryDB");
    const collection = db.collection("items");
    await collection.dropIndexes();

    const vectorSearchIdx = {
      name: "vector_index",
      type: "vectorSearch",
      definition: {
        fields: [
          {
            type: "vector",
            path: "embedding",
            numDimensions: 768,
            similarity: "cosine",
          },
        ],
      },
    };

    console.log("Creating vector search index...");
    await collection.createSearchIndex(vectorSearchIdx);

    console.log("Vector search index created successfully.");
  } catch (error) {
    console.error("Error creating vector search index:", error);
  }
}

async function generateData(): Promise<Item[]> {
  const prompt = `You are a helpful assistant that generates furniture store item data. Generate 10 furniture store items. Each record should include the following fields: item_id, item_name, item_description, brand, manufacturer_address, prices, categories, user_reviews, notes. Ensure variety in the data and realistic values.
  ${parser.getFormatInstructions()}`;

  console.log("Generating data with AI model...");

  const response = await llm.invoke(prompt);

  return parser.parse(response.content as string);
}

// Creates a searchable text summary from furniture item data
async function createItemSummary(item: Item): Promise<string> {
  return new Promise((resolve) => {
    const manufacturerDetails = `Made in ${item.manufacturer_address.country}`;
    const categories = item.categories.join(", ");
    const userReviews = item.user_reviews
      .map(
        (review) =>
          `Rated ${review.rating} on ${review.review_date}: ${review.comment}`
      )
      .join(" ");
    const basicInfo = `${item.item_name} ${item.item_description} from the brand ${item.brand}`;
    const price = `At full price it costs: ${item.prices.full_price} USD, On sale it costs: ${item.prices.sale_price} USD`;
    const notes = item.notes;

    // Combine all information into summary for vector search
    const summary = `${basicInfo}. Manufacturer: ${manufacturerDetails}. Categories: ${categories}. Reviews: ${userReviews}. Price: ${price}. Notes: ${notes}`;

    // Resolve promise with complete summary
    resolve(summary);
  });
}

// Populates database
async function seedDatabase(): Promise<void> {
  try {
    await client.connect();
    await client.db("admin").command({ ping: 1 });
    console.log("Connected to MongoDB Atlas");

    await setupDatabaseAndCollection();
    await createVectorSearchIndex();

    const db = client.db("inventoryDB");
    const collection = db.collection("items");

    await collection.deleteMany({}); // Clear existing data
    console.log("Cleared existing data in 'items' collection.");

    const items = await generateData();

    const recordsWithSummaries = await Promise.all(
      items.map(async (item) => ({
        pageContent: await createItemSummary(item), // Searchable text summary
        metadata: { ...item }, // Original item data
      }))
    );

    // Store each record with vector embeddings in MongoDB
    for (const record of recordsWithSummaries) {
      // Create vector embeddings and store in MongoDB Atlas using Gemini
      await MongoDBAtlasVectorSearch.fromDocuments(
        [record],
        new GoogleGenerativeAIEmbeddings({
          apiKey: process.env.GOOGLE_API_KEY,
          modelName: "text-embedding-004",
        }),
        {
          collection, // MongoDB collection reference
          indexName: "vector_index",
          textKey: "embedding_text", // searchable text
          embeddingKey: "embedding", // vector embeddings
        }
      );

      console.log(
        "Successfully processed & saved record:",
        record.metadata.item_id
      );
    }

    console.log("Database seeding completed");
  } catch (error) {
    console.error("Error connecting to MongoDB Atlas:", error);
    return;
  } finally {
    await client.close();
    console.log("Disconnected from MongoDB Atlas");
  }
}

// Execute the database seeding function and handle any errors
seedDatabase().catch(console.error);
