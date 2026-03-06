import { GoogleGenerativeAI } from '@google/generative-ai';
import dotenv from 'dotenv';
import path from 'path';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const projectRoot = path.resolve(__dirname, '..', '..');
dotenv.config({ path: path.join(projectRoot, '.env'), override: true });


const key = process.env.GEMINI_API_KEY?.trim();
if (!key) {
  console.error('❌ GEMINI_API_KEY is missing from environment variables!');
} else {
  console.log(`📡 Gemini API Key loaded (starts with: ${key.substring(0, 6)}... ends with: ${key.substring(key.length - 4)})`);
}

/**
 * Grounded search helper that hard-prefers Gemini 2.5 Flash.
 * Used for auto-repair tasks where web-grounded URL recovery is required.
 */
export async function researchWithGroundingPreferred25(prompt, { stage = 'research_grounded_25' } = {}) {
  const maxRetries = 3;
  const preferred = 'gemini-2.5-flash';
  const orderedCandidates = [
    preferred,
    activeFlashModelName,
    ...FLASH_MODEL_CANDIDATES,
  ].filter((value, index, arr) => value && arr.indexOf(value) === index);
  let lastError = null;
  const promptText = normalizePromptText(prompt);

  for (const modelName of orderedCandidates) {
    const flashModel = createFlashModel(modelName);
    for (let attempt = 0; attempt < maxRetries; attempt++) {
      try {
        const startedAt = Date.now();
        const result = await flashModel.generateContent(prompt);
        const response = result.response;
        const text = response.text();

        const groundingMetadata = response.candidates?.[0]?.groundingMetadata;
        const searchResults = groundingMetadata?.groundingChunks?.map(chunk => ({
          title: chunk.web?.title || '',
          url: chunk.web?.uri || '',
        })) || [];

        activeFlashModelName = modelName;
        recordUsage({ modelName, stage, promptText, responseText: text, elapsedMs: Date.now() - startedAt });
        return { text, searchResults, modelName };
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
          console.warn(`⚠️ Gemini grounded call failed on ${modelName} (${err.message}). Trying fallback model...`);
          break;
        }
        throw err;
      }
    }
  }

  const lastMessage = lastError?.message ? ` Last error: ${lastError.message}` : '';
  throw new Error(`No compatible grounded Gemini flash model found. Tried: ${orderedCandidates.join(', ')}.${lastMessage}`);
}

function createPlainFlashModel(modelName) {
  return genAI.getGenerativeModel({ model: modelName });
}

const genAI = new GoogleGenerativeAI(key);

const PRO_MODEL_CANDIDATES = [
  process.env.GEMINI_PRO_MODEL?.trim(),
  'gemini-2.5-pro',
  'gemini-2.5-pro-latest',
  'gemini-2.5-flash',
  'gemini-2.5-flash-latest',
  'gemini-2.0-flash',
].filter(Boolean);

const FLASH_MODEL_CANDIDATES = [
  process.env.GEMINI_FLASH_MODEL?.trim(),
  'gemini-2.5-flash',
  'gemini-2.5-flash-latest',
  'gemini-2.0-flash',
].filter(Boolean);

const MODEL_PRICING = {
  'gemini-2.5-pro': { inputPer1k: 0.0035, outputPer1k: 0.0105 },
  'gemini-2.5-flash': { inputPer1k: 0.00035, outputPer1k: 0.00105 },
  'gemini-2.0-flash': { inputPer1k: 0.0002, outputPer1k: 0.0006 },
  'gemini-1.5-flash': { inputPer1k: 0.00012, outputPer1k: 0.00036 },
  default: { inputPer1k: 0.0003, outputPer1k: 0.0009 },
};

const usageState = {
  calls: [],
  totals: {
    calls: 0,
    inputTokens: 0,
    outputTokens: 0,
    estimatedCostUsd: 0,
    byStage: {},
    byStageModels: {},
  },
};

let activeProModelName = PRO_MODEL_CANDIDATES[0];
let activeFlashModelName = FLASH_MODEL_CANDIDATES[0];

function getProCandidatesForStage(stage = '') {
  const normalizedStage = String(stage || '').trim().toLowerCase();
  const strictWriteCandidates = [
    process.env.GEMINI_PRO_MODEL?.trim(),
    'gemini-2.5-pro',
    'gemini-2.5-pro-latest',
  ].filter((value, index, arr) => value && arr.indexOf(value) === index);

  if (normalizedStage === 'write_article') {
    return strictWriteCandidates;
  }

  const baseline = [activeProModelName, ...PRO_MODEL_CANDIDATES]
    .filter((value, index, arr) => value && arr.indexOf(value) === index);
  return baseline;
}

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

function normalizePromptText(prompt) {
  if (typeof prompt === 'string') return prompt;
  try {
    return JSON.stringify(prompt);
  } catch {
    return String(prompt || '');
  }
}

function estimateTokens(text = '') {
  const len = String(text || '').length;
  if (!len) return 0;
  return Math.max(1, Math.ceil(len / 4));
}

function getModelPricing(modelName = '') {
  const lower = String(modelName || '').toLowerCase();
  if (lower.includes('2.5-pro')) return MODEL_PRICING['gemini-2.5-pro'];
  if (lower.includes('2.5-flash')) return MODEL_PRICING['gemini-2.5-flash'];
  if (lower.includes('2.0-flash')) return MODEL_PRICING['gemini-2.0-flash'];
  if (lower.includes('1.5-flash')) return MODEL_PRICING['gemini-1.5-flash'];
  return MODEL_PRICING.default;
}

function sanitizeJsonText(rawText = '') {
  const text = String(rawText || '').trim();
  if (!text) return '';

  const fencedMatch = text.match(/```(?:json)?\s*([\s\S]*?)\s*```/i);
  if (fencedMatch?.[1]) {
    return fencedMatch[1].trim();
  }

  return text;
}

function extractLikelyJsonPayload(rawText = '') {
  const text = sanitizeJsonText(rawText);
  if (!text) return text;

  const firstArray = text.indexOf('[');
  const firstObject = text.indexOf('{');
  const firstIndex = [firstArray, firstObject].filter(i => i >= 0).sort((a, b) => a - b)[0];
  if (firstIndex == null) return text;

  const lastArray = text.lastIndexOf(']');
  const lastObject = text.lastIndexOf('}');
  const lastIndex = Math.max(lastArray, lastObject);
  if (lastIndex < firstIndex) return text;

  return text.slice(firstIndex, lastIndex + 1).trim();
}

function parseModelJson(text = '') {
  const attempts = [sanitizeJsonText(text), extractLikelyJsonPayload(text)];
  let lastErr = null;

  for (const candidate of attempts) {
    if (!candidate) continue;
    try {
      return JSON.parse(candidate);
    } catch (err) {
      lastErr = err;
    }
  }

  const parseError = new Error(`Model returned invalid JSON: ${lastErr?.message || 'parse failed'}`);
  parseError.code = 'INVALID_JSON_MODEL_OUTPUT';
  throw parseError;
}

function recordUsage({ modelName, stage = 'unknown', promptText = '', responseText = '', elapsedMs = 0 }) {
  const inputTokens = estimateTokens(promptText);
  const outputTokens = estimateTokens(responseText);
  const pricing = getModelPricing(modelName);
  const estimatedCostUsd =
    (inputTokens / 1000) * pricing.inputPer1k +
    (outputTokens / 1000) * pricing.outputPer1k;

  const call = {
    ts: new Date().toISOString(),
    model: modelName,
    stage,
    elapsedMs: Math.max(0, Math.round(Number(elapsedMs) || 0)),
    inputTokens,
    outputTokens,
    estimatedCostUsd,
  };

  usageState.calls.push(call);
  if (usageState.calls.length > 2000) {
    usageState.calls = usageState.calls.slice(-2000);
  }

  usageState.totals.calls += 1;
  usageState.totals.inputTokens += inputTokens;
  usageState.totals.outputTokens += outputTokens;
  usageState.totals.estimatedCostUsd += estimatedCostUsd;

  if (!usageState.totals.byStage[stage]) {
    usageState.totals.byStage[stage] = { calls: 0, inputTokens: 0, outputTokens: 0, estimatedCostUsd: 0 };
  }
  usageState.totals.byStage[stage].calls += 1;
  usageState.totals.byStage[stage].inputTokens += inputTokens;
  usageState.totals.byStage[stage].outputTokens += outputTokens;
  usageState.totals.byStage[stage].estimatedCostUsd += estimatedCostUsd;

  if (!usageState.totals.byStageModels[stage]) {
    usageState.totals.byStageModels[stage] = {};
  }
  if (!usageState.totals.byStageModels[stage][modelName]) {
    usageState.totals.byStageModels[stage][modelName] = { calls: 0, inputTokens: 0, outputTokens: 0, estimatedCostUsd: 0 };
  }
  usageState.totals.byStageModels[stage][modelName].calls += 1;
  usageState.totals.byStageModels[stage][modelName].inputTokens += inputTokens;
  usageState.totals.byStageModels[stage][modelName].outputTokens += outputTokens;
  usageState.totals.byStageModels[stage][modelName].estimatedCostUsd += estimatedCostUsd;
}

export function getUsageSnapshot() {
  return {
    calls: usageState.calls.length,
    inputTokens: usageState.totals.inputTokens,
    outputTokens: usageState.totals.outputTokens,
    estimatedCostUsd: usageState.totals.estimatedCostUsd,
    byStage: JSON.parse(JSON.stringify(usageState.totals.byStage || {})),
    byStageModels: JSON.parse(JSON.stringify(usageState.totals.byStageModels || {})),
  };
}

export function diffUsageSnapshots(before = {}, after = {}) {
  const delta = {
    calls: Math.max(0, (after.calls || 0) - (before.calls || 0)),
    inputTokens: Math.max(0, (after.inputTokens || 0) - (before.inputTokens || 0)),
    outputTokens: Math.max(0, (after.outputTokens || 0) - (before.outputTokens || 0)),
    estimatedCostUsd: Math.max(0, (after.estimatedCostUsd || 0) - (before.estimatedCostUsd || 0)),
    byStage: {},
    byStageModels: {},
  };

  const stages = new Set([
    ...Object.keys(before.byStage || {}),
    ...Object.keys(after.byStage || {}),
  ]);
  for (const stage of stages) {
    const b = before.byStage?.[stage] || {};
    const a = after.byStage?.[stage] || {};
    const calls = Math.max(0, (a.calls || 0) - (b.calls || 0));
    const inputTokens = Math.max(0, (a.inputTokens || 0) - (b.inputTokens || 0));
    const outputTokens = Math.max(0, (a.outputTokens || 0) - (b.outputTokens || 0));
    const estimatedCostUsd = Math.max(0, (a.estimatedCostUsd || 0) - (b.estimatedCostUsd || 0));
    if (calls || inputTokens || outputTokens || estimatedCostUsd) {
      delta.byStage[stage] = { calls, inputTokens, outputTokens, estimatedCostUsd };
    }

    const beforeModels = before.byStageModels?.[stage] || {};
    const afterModels = after.byStageModels?.[stage] || {};
    const models = new Set([...Object.keys(beforeModels), ...Object.keys(afterModels)]);
    for (const modelName of models) {
      const bModel = beforeModels[modelName] || {};
      const aModel = afterModels[modelName] || {};
      const mCalls = Math.max(0, (aModel.calls || 0) - (bModel.calls || 0));
      const mInput = Math.max(0, (aModel.inputTokens || 0) - (bModel.inputTokens || 0));
      const mOutput = Math.max(0, (aModel.outputTokens || 0) - (bModel.outputTokens || 0));
      const mCost = Math.max(0, (aModel.estimatedCostUsd || 0) - (bModel.estimatedCostUsd || 0));
      if (mCalls || mInput || mOutput || mCost) {
        if (!delta.byStageModels[stage]) delta.byStageModels[stage] = {};
        delta.byStageModels[stage][modelName] = {
          calls: mCalls,
          inputTokens: mInput,
          outputTokens: mOutput,
          estimatedCostUsd: mCost,
        };
      }
    }
  }

  return delta;
}

/**
 * Research a topic using Gemini Flash with Google Search grounding.
 * Returns enriched context with verified links.
 */
export async function researchWithGrounding(prompt, { stage = 'research' } = {}) {
  const maxRetries = 3;
  const orderedCandidates = [activeFlashModelName, ...FLASH_MODEL_CANDIDATES.filter(m => m !== activeFlashModelName)];
  let lastError = null;
  const promptText = normalizePromptText(prompt);

  for (const modelName of orderedCandidates) {
    const flashModel = createFlashModel(modelName);
    for (let attempt = 0; attempt < maxRetries; attempt++) {
      try {
        const startedAt = Date.now();
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
        recordUsage({ modelName, stage, promptText, responseText: text, elapsedMs: Date.now() - startedAt });
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
 * Generate content with Gemini Flash (without Google Search grounding).
 */
export async function generateWithFlash(prompt, { jsonMode = false, stage = 'generate_flash' } = {}) {
  const maxRetries = 3;
  const orderedCandidates = [activeFlashModelName, ...FLASH_MODEL_CANDIDATES.filter(m => m !== activeFlashModelName)];
  let lastError = null;
  const promptText = normalizePromptText(prompt);

  for (const modelName of orderedCandidates) {
    const flashModel = createPlainFlashModel(modelName);
    for (let attempt = 0; attempt < maxRetries; attempt++) {
      try {
        const startedAt = Date.now();
        const genConfig = {};
        if (jsonMode) {
          genConfig.responseMimeType = 'application/json';
        }
        const result = await flashModel.generateContent({
          contents: [{ role: 'user', parts: [{ text: prompt }] }],
          generationConfig: genConfig,
        });

        const text = result.response.text();
        activeFlashModelName = modelName;
        recordUsage({ modelName, stage, promptText, responseText: text, elapsedMs: Date.now() - startedAt });
        if (jsonMode) {
          return parseModelJson(text);
        }
        return text;
      } catch (err) {
        lastError = err;
        if (jsonMode && err?.code === 'INVALID_JSON_MODEL_OUTPUT') {
          if (attempt < maxRetries - 1) {
            console.warn(`⚠️ Gemini flash returned malformed JSON on ${modelName}. Retrying...`);
            continue;
          }
          console.warn(`⚠️ Gemini flash repeatedly returned malformed JSON on ${modelName}. Trying fallback model...`);
          break;
        }
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
export async function generateWithPro(prompt, { jsonMode = false, stage = 'generate_pro' } = {}) {
  const maxRetries = 3;
  const orderedCandidates = getProCandidatesForStage(stage);
  let lastError = null;
  const promptText = normalizePromptText(prompt);

  for (const modelName of orderedCandidates) {
    const proModel = createProModel(modelName);
    for (let attempt = 0; attempt < maxRetries; attempt++) {
      try {
        const startedAt = Date.now();
        const genConfig = {};
        if (jsonMode) {
          genConfig.responseMimeType = 'application/json';
        }
        const result = await proModel.generateContent({
          contents: [{ role: 'user', parts: [{ text: prompt }] }],
          generationConfig: genConfig,
        });
        const text = result.response.text();
        if (String(modelName).toLowerCase().includes('2.5-pro')) {
          activeProModelName = modelName;
        }
        recordUsage({ modelName, stage, promptText, responseText: text, elapsedMs: Date.now() - startedAt });
        if (jsonMode) {
          return parseModelJson(text);
        }
        return text;
      } catch (err) {
        lastError = err;
        if (jsonMode && err?.code === 'INVALID_JSON_MODEL_OUTPUT') {
          if (attempt < maxRetries - 1) {
            console.warn(`⚠️ Gemini pro returned malformed JSON on ${modelName}. Retrying...`);
            continue;
          }
          console.warn(`⚠️ Gemini pro repeatedly returned malformed JSON on ${modelName}. Trying fallback model...`);
          break;
        }
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

  const normalizedStage = String(stage || '').trim().toLowerCase();
  if (normalizedStage !== 'write_article') {
    console.warn(`⚠️ Falling back to Gemini flash for stage "${stage}" after pro-model exhaustion.`);
    return generateWithFlash(prompt, { jsonMode, stage: `${stage}_flash_fallback` });
  }

  const lastMessage = lastError?.message ? ` Last error: ${lastError.message}` : '';
  throw new Error(`No compatible Gemini pro model found. Tried: ${orderedCandidates.join(', ')}.${lastMessage}`);
}
