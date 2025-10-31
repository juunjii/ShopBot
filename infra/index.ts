import "dotenv/config";
import express, { Express, Request, Response } from "express";
import { MongoClient } from "mongodb";
import { callAgent } from "./agent";
import cors from "cors";

const app: Express = express();
app.use(express.json());
app.use(cors());

const client = new MongoClient(process.env.MONGODB_ATLAS_URI ?? "");

async function startServer() {
  try {
    await client.connect();
    await client.db("admin").command({ ping: 1 });
    console.log("Connected to MongoDB Atlas");

    // Health check
    app.get("/", (req: Request, res: Response) => {
      res.send("Shop Bot Infra is running");
    });

    // Endpoint for conversations
    app.post("/chat", async (req: Request, res: Response) => {
      const message = req.body.message;
      const threadId = Date.now().toString(); // Keeps conversations unique

      console.log(`Received message: ${message} in thread ${threadId}`);

      try {
        const response = await callAgent(client, message, threadId);
        res.json({ threadId, response });
      } catch (error) {
        console.error("Error processing message:", error);
        res.status(500).json({ error: "Internal Server Error" });
      }
    });

    // Endpoint to continue conversations
    app.post("/chat/:threadId", async (req: Request, res: Response) => {
      const threadId = req.params.threadId;
      const message = req.body.message; // Follow-up message

      try {
        const response = await callAgent(client, message, threadId);
        res.json({ response });
      } catch (error) {
        console.error("Error in chat:", error);
        res.status(500).json({ error: "Internal Server Error" });
      }
    });

    const PORT = process.env.PORT || 8000;
    app.listen(PORT, () => {
      console.log(`Server is running on port ${PORT}`);
    });
  } catch (error) {
    console.error("Error connecting to MongoDB Atlas:", error);
  }
}

startServer();