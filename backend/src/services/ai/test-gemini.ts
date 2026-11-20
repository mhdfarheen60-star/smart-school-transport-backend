import "dotenv/config";
import { GoogleGenAI } from "@google/genai";

const apiKey = process.env.GEMINI_API_KEY;

if (!apiKey) {
  throw new Error("GEMINI_API_KEY is missing");
}

const ai = new GoogleGenAI({ apiKey });

async function testGemini() {
  try {
    console.log("Connecting to Google Gemini...");

    const response = await ai.models.generateContent({
      model: "gemini-3.8-flash",
      contents: "Explain how AI can improve school transportation management.",
    });

    console.log("\nGemini Response:");
    console.log(response.text);

    console.log("\nSUCCESS: Gemini connection established!");
  } catch (error) {
    console.error("Gemini connection failed:", error);
  }
}

testGemini();
