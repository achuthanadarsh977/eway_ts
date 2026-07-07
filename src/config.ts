/**
 * Configuration.
 *
 * PROVIDER = "groq"   -> cloud, ~2 seconds, accurate (needs GROQ_API_KEY)
 * PROVIDER = "ollama" -> local, keyless, but slow on CPU
 */
import "dotenv/config";

// "openai" | "groq" | "openrouter" (cloud, fast) | "ollama" (local, keyless)
export const PROVIDER = (process.env.PROVIDER || "groq").toLowerCase();

// --- Ollama (local, keyless) ---
export const OLLAMA_HOST = process.env.OLLAMA_HOST || "http://localhost:11434";
export const OLLAMA_MODEL = process.env.OLLAMA_MODEL || "gemma3:4b";

// --- Groq (cloud, fast, free tier) ---
// llama-4-scout is currently the only vision-capable model this account can
// reach on Groq (llama-4-maverick 404s: "model does not exist or you do not
// have access to it"). Accuracy on hard photos therefore has to come from
// the schema/prompt tightening in llmExtract.ts and the shape validation,
// not from a bigger Groq model — see README for the tradeoff.
export const GROQ_API_KEY = process.env.GROQ_API_KEY || "";
export const GROQ_MODEL = process.env.GROQ_MODEL || "meta-llama/llama-4-scout-17b-16e-instruct";
export const GROQ_URL = "https://api.groq.com/openai/v1/chat/completions";

// --- OpenAI (cloud, fast, paid) ---
export const OPENAI_API_KEY = process.env.OPENAI_API_KEY || "";
export const OPENAI_MODEL = process.env.OPENAI_MODEL || "gpt-4o-mini"; // vision-capable
export const OPENAI_URL = "https://api.openai.com/v1/chat/completions";

// --- OpenRouter (cloud, fast, free tier, no card) ---
export const OPENROUTER_API_KEY = process.env.OPENROUTER_API_KEY || "";
export const OPENROUTER_MODEL = process.env.OPENROUTER_MODEL || "qwen/qwen2.5-vl-72b-instruct:free";
export const OPENROUTER_URL = "https://openrouter.ai/api/v1/chat/completions";

export const UPLOAD_DIR = "uploads";
export const OUTPUT_DIR = "outputs";
export const PORT = Number(process.env.PORT || 5000);
