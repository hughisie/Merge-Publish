import { GoogleGenerativeAI } from '@google/generative-ai';
import dotenv from 'dotenv';
dotenv.config({ override: true });


const key = process.env.GEMINI_API_KEY?.trim();
if (!key) {
  console.error('❌ GEMINI_API_KEY is missing from environment variables!');
} else {
  console.log(`📡 Gemini API Key loaded (starts with: ${key.substring(0, 6)}... ends with: ${key.substring(key.length - 4)})`);
}

const genAI = new GoogleGenerativeAI(key);

const PRO_MODEL_CANDIDATES = [
  process.env.GEMINI_PRO_MODEL?.trim(),
  'gemini-2.5-pro',
  'gemini-2.0-flash',
  'gemini-1.5-flash',
].filter(Boolean);

const FLASH_MODEL_CANDIDATES = [
  process.env.GEMINI_FLASH_MODEL?.trim(),
  'gemini-2.0-flash',
  'gemini-1.5-flash',
].filter(Boolean);

let activeProModelName = PRO_MODEL_CANDIDATES[0];
let activeFlashModelName = FLASH_MODEL_CANDIDATES[0];

function isModelNotFoundError(err) {
  const message = String(err?.message || '').toLowerCase();
  return err?.status === 404 || message.includes('is not found') || message.includes('not supported for generatecontent');
}

function isRetryableStatusError(err) {
  return err?.status === 429 || err?.status === 503;
}

function isServerError(err) {
  return typeof err?.status === 'number' && err.status >= 500;
}

function isTransportError(err) {
  const message = String(err?.message || '').toLowerCase();
  const causeCode = String(err?.cause?.code || '').toLowerCase();
  return (
    message.includes('fetch failed') ||
    message.includes('network') ||
    message.includes('socket hang up') ||
    causeCode.includes('econnreset') ||
    causeCode.includes('enotfound') ||
    causeCode.includes('etimedout')
  );
}

function createProModel(modelName) {
  return genAI.getGenerativeModel({ model: modelName });
}

function createFlashModel(modelName) {
  return genAI.getGenerativeModel({
    model: modelName,
    tools: [{ googleSearch: {} }],
  });
}

/**
 * Research a topic using Gemini Flash with Google Search grounding.
 * Returns enriched context with verified links.
 */
export async function researchWithGrounding(prompt) {
  const maxRetries = 3;
  const orderedCandidates = [activeFlashModelName, ...FLASH_MODEL_CANDIDATES.filter(m => m !== activeFlashModelName)];
  let lastError = null;

  for (const modelName of orderedCandidates) {
    const flashModel = createFlashModel(modelName);
    for (let attempt = 0; attempt < maxRetries; attempt++) {
      try {
        const result = await flashModel.generateContent(prompt);
        const response = result.response;
        const text = response.text();

        // Extract grounding metadata if available
        const groundingMetadata = response.candidates?.[0]?.groundingMetadata;
        const searchResults = groundingMetadata?.groundingChunks?.map(chunk => ({
          title: chunk.web?.title || '',
          url: chunk.web?.uri || '',
        })) || [];

        activeFlashModelName = modelName;
        return { text, searchResults };
      } catch (err) {
        lastError = err;
        if (isModelNotFoundError(err)) {
          console.warn(`⚠️ Gemini flash model unavailable: ${modelName}. Trying fallback...`);
          break;
        }
        if (attempt < maxRetries - 1 && isRetryableStatusError(err)) {
          await new Promise(r => setTimeout(r, 2000 * (attempt + 1)));
          continue;
        }
        if (isTransportError(err) || isServerError(err) || isRetryableStatusError(err)) {
          console.warn(`⚠️ Gemini flash call failed on ${modelName} (${err.message}). Trying fallback model...`);
          break;
        }
        throw err;
      }
    }
  }

  const lastMessage = lastError?.message ? ` Last error: ${lastError.message}` : '';
  throw new Error(`No compatible Gemini flash model found. Tried: ${FLASH_MODEL_CANDIDATES.join(', ')}.${lastMessage}`);
}

/**
 * Generate content with Gemini Pro Preview (article writing, clustering, etc.)
 * Supports structured JSON output via response schema.
 */
export async function generateWithPro(prompt, { jsonMode = false } = {}) {
  const maxRetries = 3;
  const orderedCandidates = [activeProModelName, ...PRO_MODEL_CANDIDATES.filter(m => m !== activeProModelName)];
  let lastError = null;

  for (const modelName of orderedCandidates) {
    const proModel = createProModel(modelName);
    for (let attempt = 0; attempt < maxRetries; attempt++) {
      try {
        const genConfig = {};
        if (jsonMode) {
          genConfig.responseMimeType = 'application/json';
        }
        const result = await proModel.generateContent({
          contents: [{ role: 'user', parts: [{ text: prompt }] }],
          generationConfig: genConfig,
        });
        const text = result.response.text();
        activeProModelName = modelName;
        if (jsonMode) {
          return JSON.parse(text);
        }
        return text;
      } catch (err) {
        lastError = err;
        if (isModelNotFoundError(err)) {
          console.warn(`⚠️ Gemini pro model unavailable: ${modelName}. Trying fallback...`);
          break;
        }
        if (attempt < maxRetries - 1 && isRetryableStatusError(err)) {
          await new Promise(r => setTimeout(r, 2000 * (attempt + 1)));
          continue;
        }
        if (isTransportError(err) || isServerError(err) || isRetryableStatusError(err)) {
          console.warn(`⚠️ Gemini pro call failed on ${modelName} (${err.message}). Trying fallback model...`);
          break;
        }
        throw err;
      }
    }
  }

  const lastMessage = lastError?.message ? ` Last error: ${lastError.message}` : '';
  throw new Error(`No compatible Gemini pro model found. Tried: ${PRO_MODEL_CANDIDATES.join(', ')}.${lastMessage}`);
}
