import dotenv from "dotenv";
import { GoogleGenAI } from "@google/genai";

dotenv.config();

const apiKey = process.env.GEMINI_API_KEY || process.env.AI_LLM_API_KEY;
if (!apiKey) {
  console.error("Gemini connection failed: missing GEMINI_API_KEY (or AI_LLM_API_KEY).");
  process.exit(1);
}

const ai = new GoogleGenAI({ apiKey });

try {
  console.log("Connecting to Gemini...");
  const response = await ai.models.generateContent({
    model: process.env.GEMINI_MODEL || "gemini-1.5-flash",
    contents: "Explain how AI can improve school transportation.",
  });
  console.log("\nGemini Response:");
  console.log(response.text);
  console.log("\nSUCCESS: Gemini is connected.");
} catch (error) {
  const msg = error?.message || String(error);
  console.error("Gemini connection failed:", msg);
  if (error?.status) console.error("Status:", error.status);
  process.exitCode = 1;
}
