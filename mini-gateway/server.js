const http = require('http');
const https = require('https');
const url = require('url');
const fs = require('fs');
const path = require('path');

// Load environment variables from .env if it exists
try {
  const envPath = path.join(__dirname, '.env');
  if (fs.existsSync(envPath)) {
    const envConfig = fs.readFileSync(envPath, 'utf-8');
    envConfig.split('\n').forEach(line => {
      const trimmed = line.trim();
      if (!trimmed || trimmed.startsWith('#')) return;
      const firstEqual = trimmed.indexOf('=');
      if (firstEqual === -1) return;
      const key = trimmed.slice(0, firstEqual).trim();
      const val = trimmed.slice(firstEqual + 1).trim();
      const unquoted = val.replace(/^['"]|['"]$/g, '');
      process.env[key] = unquoted;
    });
  }
} catch (err) {
  console.error('[Proxy] Failed to load .env file:', err.message);
}

// =============================================================================
// 1. Core State & GCP GCS Persistence Module (Zero External Dependencies)
// =============================================================================
const PORT = process.env.PORT || 8080;
const GCS_BUCKET_NAME = process.env.GCS_BUCKET_NAME || 'freellmapi-data-store';
const LOCAL_DATA_DIR = path.join(__dirname, 'data');

// Persisted file names — must match the readGcsJson call sites below
const CONFIG_FILE_NAME = 'config.json';
const LOGS_FILE_NAME = 'error_logs.json';

if (!fs.existsSync(LOCAL_DATA_DIR)) {
  try { fs.mkdirSync(LOCAL_DATA_DIR, { recursive: true }); } catch (e) {}
}

let cachedGcpAccessToken = null;
let gcpTokenExpiresAt = 0;

// Get GCP Application Default Credentials (ADC) access token from Metadata Server
function getGcpAccessToken() {
  return new Promise((resolve) => {
    if (cachedGcpAccessToken && Date.now() < gcpTokenExpiresAt - 60000) {
      return resolve(cachedGcpAccessToken);
    }
    const options = {
      hostname: 'metadata.google.internal',
      port: 80,
      path: '/computeMetadata/v1/instance/service-accounts/default/token',
      method: 'GET',
      headers: { 'Metadata-Flavor': 'Google' },
      timeout: 2000
    };
    const req = http.request(options, (res) => {
      let data = '';
      res.on('data', chunk => { data += chunk; });
      res.on('end', () => {
        try {
          if (res.statusCode === 200) {
            const parsed = JSON.parse(data);
            cachedGcpAccessToken = parsed.access_token;
            gcpTokenExpiresAt = Date.now() + (parsed.expires_in * 1000);
            return resolve(cachedGcpAccessToken);
          }
        } catch (e) {}
        resolve(null);
      });
    });
    req.on('error', () => resolve(null));
    req.on('timeout', () => { req.destroy(); resolve(null); });
    req.end();
  });
}

// Read JSON from GCS Bucket with local fallback
async function readGcsJson(objectName, localFallbackFile) {
  const token = await getGcpAccessToken();
  if (token) {
    try {
      const gcsData = await new Promise((resolve, reject) => {
        const options = {
          hostname: 'storage.googleapis.com',
          port: 443,
          path: `/storage/v1/b/${GCS_BUCKET_NAME}/o/${encodeURIComponent(objectName)}?alt=media`,
          method: 'GET',
          headers: { 'Authorization': `Bearer ${token}` }
        };
        const req = https.request(options, (res) => {
          let body = '';
          res.on('data', c => { body += c; });
          res.on('end', () => {
            if (res.statusCode === 200) resolve(body);
            else reject(new Error(`GCS status ${res.statusCode}`));
          });
        });
        req.on('error', reject);
        req.end();
      });
      return JSON.parse(gcsData);
    } catch (err) {
      console.warn(`[GCS] Reading ${objectName} from GCS failed (${err.message}). Falling back to local.`);
    }
  }
  const localPath = path.join(LOCAL_DATA_DIR, localFallbackFile);
  if (fs.existsSync(localPath)) {
    try { return JSON.parse(fs.readFileSync(localPath, 'utf-8')); } catch (e) {}
  }
  return null;
}

// Write JSON to GCS Bucket and local disk
async function writeGcsJson(objectName, localFallbackFile, dataObj) {
  const jsonStr = JSON.stringify(dataObj, null, 2);
  const localPath = path.join(LOCAL_DATA_DIR, localFallbackFile);
  try { fs.writeFileSync(localPath, jsonStr, 'utf-8'); } catch (e) {}

  const token = await getGcpAccessToken();
  if (token) {
    try {
      await new Promise((resolve, reject) => {
        const options = {
          hostname: 'storage.googleapis.com',
          port: 443,
          path: `/upload/storage/v1/b/${GCS_BUCKET_NAME}/o?uploadType=media&name=${encodeURIComponent(objectName)}`,
          method: 'POST',
          headers: {
            'Authorization': `Bearer ${token}`,
            'Content-Type': 'application/json',
            'Content-Length': Buffer.byteLength(jsonStr)
          }
        };
        const req = https.request(options, (res) => {
          if (res.statusCode >= 200 && res.statusCode < 300) resolve(true);
          else reject(new Error(`GCS write status ${res.statusCode}`));
        });
        req.on('error', reject);
        req.write(jsonStr);
        req.end();
      });
      console.log(`[GCS] Persisted ${objectName} to bucket '${GCS_BUCKET_NAME}'`);
    } catch (err) {
      console.warn(`[GCS] Writing ${objectName} to GCS failed: ${err.message}`);
    }
  }
}

// Global Application Configuration & Runtime State
let appConfig = {
  accessToken: process.env.ACCESS_TOKEN || '6ammYiLu4F7FuxElG8SSYlpUqYDiBHBuQE3svJOMyVUF1QN3',
  providers: []
};

// Error Logs Storage
let errorLogs = [];
const MAX_ERROR_LOGS = 200;

// Key Rotation Pointers per Provider ID
const providerKeyPointers = {};

// Statistics
const stats = {
  totalRequests: 0,
  failovers: 0,
  errors: 0,
  providerStats: {},
  startTime: new Date()
};

// Lightweight in-memory per-key health tracking.
// Pure RAM, no persistence, no extra deps — zero impact on cold start and scale-to-zero.
const keyHealth = {}; // providerId -> [ { fails, lastFailAt, lastStatus, lastMsg } ]
const KEY_COOLDOWN_FAILS = 3;
const KEY_BLOWN_FAILS = 8;

function markKeyFail(providerId, keyIndex, statusCode, errMsg) {
  if (!providerId) return;
  if (!keyHealth[providerId]) keyHealth[providerId] = [];
  if (!keyHealth[providerId][keyIndex]) keyHealth[providerId][keyIndex] = { fails: 0, lastFailAt: 0, lastStatus: null, lastMsg: '' };
  const k = keyHealth[providerId][keyIndex];
  k.fails++;
  k.lastFailAt = Date.now();
  k.lastStatus = statusCode || null;
  k.lastMsg = (errMsg || '').slice(0, 200);
}

function markKeySuccess(providerId, keyIndex) {
  if (!providerId) return;
  if (!keyHealth[providerId]) keyHealth[providerId] = [];
  if (!keyHealth[providerId][keyIndex]) keyHealth[providerId][keyIndex] = { fails: 0, lastFailAt: 0, lastStatus: null, lastMsg: '' };
  keyHealth[providerId][keyIndex].fails = 0;
}

function keyStateOf(k) {
  if (!k || k.fails === 0) return 'ok';
  if (k.fails >= KEY_BLOWN_FAILS) return 'blown';
  return 'cooling';
}

function maskSecretKey(full) {
  if (!full) return '';
  if (full.length <= 8) return full;
  return full.slice(0, 6) + '…' + full.slice(-4);
}

// Build a read-only view of key health for the dashboard.
// Exposes only masked key snippets — never the raw secrets.
function buildKeyHealthView() {
  const view = {};
  for (const provider of (appConfig.providers || [])) {
    const pid = provider.id || provider.name;
    if (!pid) continue;
    const keys = provider.apiKeys || [];
    const health = keyHealth[pid] || [];
    view[pid] = keys.map((fullKey, idx) => {
      const h = health[idx] || { fails: 0, lastFailAt: 0, lastStatus: null, lastMsg: '' };
      return {
        index: idx,
        masked: maskSecretKey(fullKey),
        state: keyStateOf(h),
        fails: h.fails || 0,
        lastFailAt: h.lastFailAt || 0,
        lastStatus: h.lastStatus || null
      };
    });
  }
  return view;
}

// Initialize default config if none exists
function buildInitialDefaultConfig() {
  const googleKeys = (process.env.GOOGLE_KEYS || '').split(',').map(k => k.trim()).filter(Boolean);
  const opencodeKeys = (process.env.OPENCODE_KEYS || '').split(',').map(k => k.trim()).filter(Boolean);
  const nvidiaKeys = (process.env.NVIDIA_KEYS || '').split(',').map(k => k.trim()).filter(Boolean);

  return {
    accessToken: process.env.ACCESS_TOKEN || '6ammYiLu4F7FuxElG8SSYlpUqYDiBHBuQE3svJOMyVUF1QN3',
    providers: [
      {
        id: 'google',
        name: 'Google AI Studio',
        type: 'gemini-native',
        baseUrl: 'https://generativelanguage.googleapis.com/v1beta',
        apiKeys: googleKeys,
        models: [
          { id: 'gemini-3.5-flash-lite', targetModel: 'gemini-3.5-flash-lite' },
          { id: 'gemini-3.1-flash-lite', targetModel: 'gemini-3.1-flash-lite' },
          { id: 'gemini-2.5-flash', targetModel: 'gemini-2.5-flash' },
          { id: 'gemini-2.5-pro', targetModel: 'gemini-2.5-pro' }
        ]
      },
      {
        id: 'opencode',
        name: 'OpenCode Zen',
        type: 'openai-passthrough',
        baseUrl: 'https://opencode.ai/zen/v1/chat/completions',
        apiKeys: opencodeKeys,
        models: [
          { id: 'deepseek-v4-flash-free', targetModel: 'deepseek-v4-flash-free' },
          { id: 'mimo-v2.5-free', targetModel: 'mimo-v2.5-free' },
          { id: 'hy3-free', targetModel: 'hy3-free' }
        ]
      },
      {
        id: 'nvidia',
        name: 'Nvidia NIM',
        type: 'openai-passthrough',
        baseUrl: 'https://integrate.api.nvidia.com/v1/chat/completions',
        apiKeys: nvidiaKeys,
        models: [
          { id: 'z-ai/glm-5.2', targetModel: 'z-ai/glm-5.2' },
          { id: 'minimaxai/minimax-m3', targetModel: 'minimaxai/minimax-m3' },
          { id: 'openai/gpt-oss-120b', targetModel: 'openai/gpt-oss-120b' },
          { id: 'stepfun-ai/step-3.7-flash', targetModel: 'stepfun-ai/step-3.7-flash' }
        ]
      }
    ]
  };
}

// Load System Config & Logs on Startup
async function initSystemState() {
  const loadedConfig = await readGcsJson('config.json', 'config.json');
  if (loadedConfig && Array.isArray(loadedConfig.providers)) {
    appConfig = loadedConfig;
    console.log('[System] Config loaded from persistent storage.');
  } else {
    appConfig = buildInitialDefaultConfig();
    console.log('[System] Config initialized from defaults. Saving to GCS...');
    await writeGcsJson('config.json', 'config.json', appConfig);
  }

  const loadedLogs = await readGcsJson('error_logs.json', 'error_logs.json');
  if (Array.isArray(loadedLogs)) {
    errorLogs = loadedLogs;
  }
}

// Save Config to GCS
async function saveConfig(newConfig) {
  appConfig = newConfig;
  await writeGcsJson('config.json', 'config.json', appConfig);
}

// Record 400/401/403/404/429/5xx Error Logs
let saveLogsTimeout = null;
function recordErrorLog(logEntry) {
  errorLogs.unshift({
    id: `err_${Date.now()}_${Math.random().toString(36).slice(2, 7)}`,
    timestamp: new Date().toISOString(),
    ...logEntry
  });
  // Track per-key health (lightweight, in-memory only)
  if (logEntry && logEntry.providerId && typeof logEntry.keyIndex === 'number') {
    markKeyFail(logEntry.providerId, logEntry.keyIndex, logEntry.statusCode, logEntry.errorMessage);
  }
  if (errorLogs.length > MAX_ERROR_LOGS) {
    errorLogs = errorLogs.slice(0, MAX_ERROR_LOGS);
  }
  if (!saveLogsTimeout) {
    saveLogsTimeout = setTimeout(() => {
      saveLogsTimeout = null;
      writeGcsJson('error_logs.json', 'error_logs.json', errorLogs);
    }, 5000);
  }
}

// Thought Signature Cache (Google Gemini tool calling requirements)
const THOUGHT_SIG_TTL_MS = 30 * 60 * 1000;
const THOUGHT_SIG_MAX = 5000;
const thoughtSigCache = new Map();

function rememberThoughtSig(callId, sig) {
  if (!callId || !sig) return;
  if (thoughtSigCache.size >= THOUGHT_SIG_MAX) {
    const oldest = thoughtSigCache.keys().next().value;
    if (oldest !== undefined) thoughtSigCache.delete(oldest);
  }
  thoughtSigCache.set(callId, { sig, exp: Date.now() + THOUGHT_SIG_TTL_MS });
}

function recallThoughtSig(callId) {
  if (!callId) return undefined;
  const hit = thoughtSigCache.get(callId);
  if (hit) {
    if (hit.exp > Date.now()) return hit.sig;
    thoughtSigCache.delete(callId);
  }
  return undefined;
}

// Upstream Error Classification for Retries & Key Rotation
function isRetryableError(statusCode, errMessage) {
  const msg = (errMessage || '').toLowerCase();
  if (statusCode === 401 || statusCode === 403 || statusCode === 408 || statusCode === 429) {
    return true;
  }
  if (statusCode >= 500) return true;
  // Network-level errors (no HTTP status code yet)
  return msg.includes('rate limit') || msg.includes('too many requests')
    || msg.includes('quota') || msg.includes('resource_exhausted')
    || msg.includes('timeout') || msg.includes('etimedout')
    || msg.includes('econnrefused') || msg.includes('econnreset')
    || msg.includes('fetch failed')
    || msg.includes('unavailable')
    || msg.includes('permission_denied') || msg.includes('denied access')
    || msg.includes('payment required') || msg.includes('insufficient_quota')
    || msg.includes('insufficient credit') || msg.includes('insufficient balance')
    || msg.includes('empty completion')
    || msg.includes('stream ended unexpectedly')
    || msg.includes('stream stalled')
    || msg.includes('socket hang up');
}

// =============================================================================
// 3. Google Gemini Message & Option Translation
// =============================================================================
const GEMINI_UNSUPPORTED_SCHEMA_KEYS = new Set([
  '$schema', '$id', '$ref', '$defs', '$comment',
  'definitions', 'exclusiveMinimum', 'exclusiveMaximum',
  'patternProperties', 'unevaluatedProperties', 'unevaluatedItems',
  'if', 'then', 'else', 'contentEncoding', 'contentMediaType',
  'contentSchema', 'dependentRequired', 'dependentSchemas', 'dependencies',
  'additionalProperties', 'examples', 'const', 'readOnly', 'writeOnly',
  'uniqueItems', 'not', 'allOf', 'oneOf', 'prefixItems',
  'contains', 'minContains', 'maxContains', 'propertyNames',
  'multipleOf', 'deprecated'
]);

function sanitizeSchema(schema, insideProperties = false) {
  if (Array.isArray(schema)) {
    return schema.map(s => sanitizeSchema(s, false));
  }
  if (schema && typeof schema === 'object') {
    const out = {};
    for (const [k, v] of Object.entries(schema)) {
      if (insideProperties) {
        out[k] = sanitizeSchema(v, false);
        continue;
      }
      if (GEMINI_UNSUPPORTED_SCHEMA_KEYS.has(k) || k.startsWith('x-')) continue;
      out[k] = sanitizeSchema(v, k === 'properties');
    }
    return out;
  }
  return schema;
}

function toGeminiTools(tools) {
  if (!tools || tools.length === 0) return undefined;
  const functionDeclarations = [];
  let grounding = false;
  for (const t of tools) {
    if (['google_search', 'googlesearch', 'google_search_retrieval'].includes(t.function.name.toLowerCase())) {
      grounding = true;
      continue;
    }
    functionDeclarations.push({
      name: t.function.name,
      description: t.function.description,
      parameters: sanitizeSchema(t.function.parameters)
    });
  }
  const out = [];
  if (grounding) out.push({ google_search: {} });
  if (functionDeclarations.length > 0) out.push({ functionDeclarations });
  return out.length > 0 ? out : undefined;
}

function buildGeminiThinkingConfig(effort, modelId) {
  const normalized = (modelId || '').toLowerCase();
  // Only apply to gemini models
  if (!normalized.includes('gemini')) {
    return null;
  }

  // If user explicitly requests to disable thoughts
  if (effort === 'none') {
    return { includeThoughts: false };
  }

  const includeThoughts = true;
  
  // Gemini 2.5: only supports includeThoughts, no thinkingLevel
  if (normalized.includes('gemini-2.5')) {
    return { includeThoughts };
  }

  // Gemini 3.0 / 3.1 Flash and Pro support thinkingConfig
  if (normalized.includes('gemini-3')) {
    const level = effort || 'medium';
    if (normalized.includes('pro')) {
      // 3.0 Pro supports only high or low
      return {
        includeThoughts,
        thinkingLevel: level === 'high' ? 'high' : 'low'
      };
    }
    // 3.0/3.1 Flash supports low, medium, high
    return {
      includeThoughts,
      thinkingLevel: level
    };
  }

  // For future or older versions, default to includeThoughts: true
  return { includeThoughts };
}

function fetchImage(imageUrl) {
  return new Promise((resolve, reject) => {
    const parsed = url.parse(imageUrl);
    const client = parsed.protocol === 'https:' ? https : http;
    client.get(imageUrl, { timeout: 15000 }, (res) => {
      if (res.statusCode !== 200) {
        reject(new Error(`Failed to fetch image: HTTP ${res.statusCode}`));
        return;
      }
      const mimeType = res.headers['content-type']?.split(';')[0]?.trim() || 'image/jpeg';
      const chunks = [];
      res.on('data', chunk => chunks.push(chunk));
      res.on('end', () => {
        const buf = Buffer.concat(chunks);
        resolve({ mimeType, data: buf.toString('base64') });
      });
    }).on('error', reject);
  });
}

function safeParseObject(raw) {
  if (typeof raw !== 'string') return {};
  try {
    const parsed = JSON.parse(raw);
    if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
      return parsed;
    }
    return { value: parsed };
  } catch {
    return { value: raw };
  }
}

async function extractContentParts(content) {
  const parts = [];
  if (!content) return parts;

  if (typeof content === 'string') {
    parts.push({ text: content });
  } else if (Array.isArray(content)) {
    for (const block of content) {
      if (!block) continue;
      if (typeof block === 'string') {
        parts.push({ text: block });
      } else if (typeof block === 'object') {
        if (block.type === 'text' && typeof block.text === 'string') {
          parts.push({ text: block.text });
        } else if (block.type === 'image_url') {
          const urlStr = typeof block.image_url === 'string' ? block.image_url : block.image_url?.url;
          if (urlStr) {
            try {
              const inlineData = await fetchImage(urlStr);
              parts.push({ inlineData });
            } catch (err) {
              console.error('[Proxy] Failed to fetch user image:', err.message);
            }
          }
        } else if (typeof block.text === 'string') {
          parts.push({ text: block.text });
        }
      }
    }
  } else if (typeof content === 'object') {
    if (typeof content.text === 'string') {
      parts.push({ text: content.text });
    }
  }

  return parts;
}

async function toGeminiContents(messages) {
  const systemMessages = messages
    .filter(m => m.role === 'system')
    .map(m => m.content)
    .filter(Boolean);

  // Phase 1: Convert to intermediate objects
  const rawContents = [];
  for (const m of messages) {
    if (m.role === 'system') continue;
    
    let role = 'user';
    let parts = [];

    if (m.role === 'assistant') {
      role = 'model';
      if (m.content) {
        const contentParts = await extractContentParts(m.content);
        parts.push(...contentParts);
      }
      if (m.tool_calls) {
        m.tool_calls.forEach(tc => {
          const sig = recallThoughtSig(tc.id);
          const part = {
            functionCall: {
              id: tc.id,
              name: tc.function.name,
              args: safeParseObject(tc.function.arguments)
            }
          };
          if (sig) {
            part.thoughtSignature = sig;
          }
          parts.push(part);
        });
      }
    } else if (m.role === 'tool') {
      role = 'user';
      parts.push({
        functionResponse: {
          name: m.name || 'tool',
          response: safeParseObject(m.content)
        }
      });
    } else { // user
      role = 'user';
      if (m.content) {
        const contentParts = await extractContentParts(m.content);
        parts.push(...contentParts);
      }
    }

    if (parts.length === 0) parts.push({ text: '' });
    rawContents.push({ role, parts });
  }

  // Phase 2: Merge consecutive roles (Gemini requires alternating user/model roles)
  const contents = [];
  for (const entry of rawContents) {
    if (contents.length > 0 && contents[contents.length - 1].role === entry.role) {
      contents[contents.length - 1].parts.push(...entry.parts);
    } else {
      contents.push(entry);
    }
  }

  // Phase 3: Ensure the conversation starts with a 'user' role
  if (contents.length > 0 && contents[0].role === 'model') {
    contents.unshift({ role: 'user', parts: [{ text: '' }] });
  }

  return {
    contents,
    systemInstruction: systemMessages.length > 0
      ? { parts: [{ text: systemMessages.join('\n\n') }] }
      : undefined
  };
}

function translateGeminiResponse(geminiData, modelId) {
  const candidate = geminiData.candidates?.[0];
  const parts = candidate?.content?.parts || [];
  
  let text = '';
  let reasoningText = '';
  const toolCalls = [];
  
  parts.forEach((p, idx) => {
    // Extract thinking blocks
    if (p.thought === true) {
      if (p.text) reasoningText += p.text;
      return;
    }
    if (p.text) text += p.text;
    if (p.functionCall) {
      const tcId = p.functionCall.id || `call_${Date.now()}_${idx}`;
      if (p.thoughtSignature) {
        rememberThoughtSig(tcId, p.thoughtSignature);
      }
      toolCalls.push({
        id: tcId,
        type: 'function',
        function: {
          name: p.functionCall.name,
          arguments: JSON.stringify(p.functionCall.args || {})
        }
      });
    }
  });

  return {
    id: `chatcmpl-${Date.now()}`,
    object: 'chat.completion',
    created: Math.floor(Date.now() / 1000),
    model: modelId,
    choices: [{
      index: 0,
      message: {
        role: 'assistant',
        content: text || null,
        ...(reasoningText ? { reasoning_content: reasoningText } : {}),
        ...(toolCalls.length > 0 ? { tool_calls: toolCalls } : {})
      },
      finish_reason: toolCalls.length > 0 ? 'tool_calls' : (candidate?.finishReason === 'MAX_TOKENS' ? 'length' : 'stop')
    }],
    usage: {
      prompt_tokens: geminiData.usageMetadata?.promptTokenCount || 0,
      completion_tokens: geminiData.usageMetadata?.candidatesTokenCount || 0,
      total_tokens: geminiData.usageMetadata?.totalTokenCount || 0
    }
  };
}

function streamGeminiToOpenAI(upstreamRes, res, modelId) {
  res.writeHead(200, {
    'Content-Type': 'text/event-stream',
    'Cache-Control': 'no-cache',
    'Connection': 'keep-alive',
    'X-Accel-Buffering': 'no'
  });

  let buffer = '';
  const id = `chatcmpl-${Date.now()}`;

  upstreamRes.on('data', (chunk) => {
    buffer += chunk.toString();
    const lines = buffer.split('\n');
    buffer = lines.pop() || '';

    for (const line of lines) {
      const trimmed = line.trim();
      if (!trimmed || !trimmed.startsWith('data: ')) continue;
      const raw = trimmed.slice(6);
      if (raw === '[DONE]') {
        res.write('data: [DONE]\n\n');
        continue;
      }

      try {
        const geminiObj = JSON.parse(raw);
        const candidate = geminiObj.candidates?.[0];
        const parts = candidate?.content?.parts || [];
        
        let text = '';
        const toolCalls = [];
        
        parts.forEach((p, idx) => {
          if (p.thought === true) {
            return;
          }
          if (p.text) text += p.text;
          if (p.functionCall) {
            const tcId = p.functionCall.id || `call_${Date.now()}_${idx}`;
            if (p.thoughtSignature) {
              rememberThoughtSig(tcId, p.thoughtSignature);
            }
            toolCalls.push({
              index: idx,
              id: tcId,
              type: 'function',
              function: {
                name: p.functionCall.name,
                arguments: JSON.stringify(p.functionCall.args || {})
              }
            });
          }
        });

        if (text || toolCalls.length > 0) {
          const payload = {
            id,
            object: 'chat.completion.chunk',
            created: Math.floor(Date.now() / 1000),
            model: modelId,
            choices: [{
              index: 0,
              delta: {
                ...(text ? { content: text } : {}),
                ...(toolCalls.length > 0 ? { tool_calls: toolCalls } : {})
              },
              finish_reason: candidate?.finishReason ? (toolCalls.length > 0 ? 'tool_calls' : 'stop') : null
            }]
          };
          res.write(`data: ${JSON.stringify(payload)}\n\n`);
        }
      } catch (err) {
        // Ignore JSON parse errors for incomplete chunk segments
      }
    }
  });

  upstreamRes.on('end', () => {
    res.write('data: [DONE]\n\n');
    res.end();
  });
}

function streamOpenAIWithModelRewrite(upstreamRes, res, originalModel, targetModel) {
  res.writeHead(200, {
    'Content-Type': 'text/event-stream',
    'Cache-Control': 'no-cache',
    'Connection': 'keep-alive',
    'X-Accel-Buffering': 'no'
  });

  let buffer = '';
  upstreamRes.on('data', (chunk) => {
    buffer += chunk.toString();
    const lines = buffer.split('\n');
    buffer = lines.pop() || '';

    for (const line of lines) {
      const trimmed = line.trim();
      if (!trimmed) continue;
      
      if (trimmed.startsWith('data: ')) {
        const raw = trimmed.slice(6);
        if (raw === '[DONE]') {
          res.write('data: [DONE]\n\n');
          continue;
        }
        try {
          const obj = JSON.parse(raw);
          if (obj.model === targetModel) {
            obj.model = originalModel;
          }
          res.write(`data: ${JSON.stringify(obj)}\n\n`);
        } catch (e) {
          // String replace fallback if JSON parse fails on incomplete lines
          const replaced = trimmed.replace(new RegExp(targetModel, 'g'), originalModel);
          res.write(`${replaced}\n`);
        }
      } else {
        res.write(`${line}\n`);
      }
    }
  });

  upstreamRes.on('end', () => {
    if (buffer) {
      const trimmed = buffer.trim();
      if (trimmed.startsWith('data: ')) {
        const raw = trimmed.slice(6);
        if (raw === '[DONE]') {
          res.write('data: [DONE]\n\n');
        } else {
          try {
            const obj = JSON.parse(raw);
            if (obj.model === targetModel) obj.model = originalModel;
            res.write(`data: ${JSON.stringify(obj)}\n\n`);
          } catch (e) {
            const replaced = trimmed.replace(new RegExp(targetModel, 'g'), originalModel);
            res.write(`${replaced}\n`);
          }
        }
      }
    }
    res.end();
  });
}

// =============================================================================
// 4. Routing Helper & Model Dictionary
// =============================================================================
function resolveProviderAndModel(requestedModel) {
  if (!requestedModel) return null;
  const reqLower = requestedModel.toLowerCase();

  for (const provider of appConfig.providers) {
    if (!Array.isArray(provider.apiKeys) || provider.apiKeys.length === 0) continue;
    if (!Array.isArray(provider.models)) continue;

    for (const m of provider.models) {
      if (typeof m === 'string') {
        if (m.toLowerCase() === reqLower) {
          return { provider, matchedModel: { id: m, targetModel: m } };
        }
      } else if (m && typeof m === 'object' && m.id) {
        if (m.id.toLowerCase() === reqLower) {
          return { provider, matchedModel: m };
        }
      }
    }
  }

  // Suffix fallback for *-free models -> OpenCode
  if (reqLower.endsWith('-free')) {
    const opencodeProvider = appConfig.providers.find(p => p.id === 'opencode' || p.name.toLowerCase().includes('opencode'));
    if (opencodeProvider && opencodeProvider.apiKeys.length > 0) {
      return { provider: opencodeProvider, matchedModel: { id: requestedModel, targetModel: requestedModel } };
    }
  }

  // Prefix fallback for gemini-* models -> Google
  if (reqLower.startsWith('gemini-')) {
    const googleProvider = appConfig.providers.find(p => p.type === 'gemini-native' || p.id === 'google');
    if (googleProvider && googleProvider.apiKeys.length > 0) {
      return { provider: googleProvider, matchedModel: { id: requestedModel, targetModel: requestedModel } };
    }
  }

  return null;
}

function getAvailableModelsList() {
  const models = [];
  const addedSet = new Set();

  for (const p of appConfig.providers) {
    if (!Array.isArray(p.apiKeys) || p.apiKeys.length === 0) continue;
    if (Array.isArray(p.models)) {
      p.models.forEach(m => {
        const id = typeof m === 'string' ? m : m.id;
        if (id && !addedSet.has(id)) {
          addedSet.add(id);
          models.push({
            id: id,
            object: 'model',
            created: 1718000000,
            owned_by: p.id || p.name.toLowerCase()
          });
        }
      });
    }
  }
  return models;
}

const STRIPPED_HEADERS = new Set([
  'host',
  'authorization',
  'content-length',
  'content-type',
  'connection',
  'accept-encoding',
  'x-cloud-trace-context',
  'x-forwarded-for',
  'x-forwarded-proto',
  'x-forwarded-port',
  'x-forwarded-server',
  'x-real-ip',
  'via',
  'forwarded',
  'cf-connecting-ip',
  'cf-ray',
  'cf-visitor',
  'cf-ipcountry'
]);

// =============================================================================
// 5. Request Dispatcher with Intelligent Retries & Full Translation
// =============================================================================
async function forwardRequest(req, res, provider, bodyData, attempt = 1, isStream = false, requestedModel = '', matchedModel = null) {
  const providerId = provider.id || provider.name;
  if (!providerKeyPointers[providerId]) providerKeyPointers[providerId] = 0;
  
  const keysPool = provider.apiKeys || [];
  if (keysPool.length === 0) {
    res.writeHead(500, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ error: { message: `No API keys configured for provider '${provider.name}'` } }));
    return;
  }

  const keyIndex = providerKeyPointers[providerId] % keysPool.length;
  const apiKey = keysPool[keyIndex];
  const maxAttempts = keysPool.length;

  console.log(`[Proxy] Forwarding attempt ${attempt}/${maxAttempts} for Provider '${provider.name}' (Key Index ${keyIndex}) - Model: ${requestedModel}`);

  const targetModelId = matchedModel?.targetModel || requestedModel;
  let finalUrl = provider.baseUrl;
  let finalBodyStr = bodyData;

  const headers = { 'Content-Type': 'application/json' };
  if (provider.type !== 'gemini-native') {
    headers['Authorization'] = `Bearer ${apiKey}`;
  }

  // Preserving original client User-Agent and custom headers
  if (req && req.headers) {
    for (const [k, v] of Object.entries(req.headers)) {
      if (!STRIPPED_HEADERS.has(k.toLowerCase())) {
        headers[k] = v;
      }
    }
  }
  if (!headers['user-agent'] && !headers['User-Agent']) {
    headers['User-Agent'] = 'OpenCode/1.0.0 (Desktop)';
  }

  // TYPE A: Gemini Native Adapter
  if (provider.type === 'gemini-native') {
    try {
      const openAIObj = JSON.parse(bodyData);
      const geminiObj = await toGeminiContents(openAIObj.messages);
      const tools = toGeminiTools(openAIObj.tools);
      const thinkingConfig = buildGeminiThinkingConfig(openAIObj.reasoning_effort, requestedModel);

      const requestBody = {
        contents: geminiObj.contents,
        generationConfig: {
          temperature: openAIObj.temperature,
          maxOutputTokens: openAIObj.max_tokens ?? 65535,
          topP: openAIObj.top_p,
          stopSequences: openAIObj.stop ? (Array.isArray(openAIObj.stop) ? openAIObj.stop : [openAIObj.stop]) : undefined,
          ...(thinkingConfig ? { thinkingConfig } : {})
        },
        tools
      };
      if (geminiObj.systemInstruction) {
        requestBody.systemInstruction = geminiObj.systemInstruction;
      }

      finalBodyStr = JSON.stringify(requestBody);
      const action = isStream ? 'streamGenerateContent?alt=sse&key=' : 'generateContent?key=';
      finalUrl = `${provider.baseUrl}/models/${targetModelId}:${action}${apiKey}`;
    } catch (err) {
      console.error('[Proxy] Gemini Body Translation Failed:', err.message);
      res.writeHead(400, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: { message: `Gemini Request Translation Failed: ${err.message}` } }));
      return;
    }
  } 
  // TYPE B: Zero-Loss Transparent Passthrough (OpenAI Compatible)
  else {
    if (targetModelId !== requestedModel) {
      try {
        const bodyObj = JSON.parse(bodyData);
        bodyObj.model = targetModelId;
        finalBodyStr = JSON.stringify(bodyObj);
      } catch (e) {}
    }
  }

  headers['Content-Length'] = Buffer.byteLength(finalBodyStr);

  const parsedUrl = url.parse(finalUrl);
  const options = {
    hostname: parsedUrl.hostname,
    port: parsedUrl.port || 443,
    path: parsedUrl.path,
    method: 'POST',
    headers: headers,
    servername: parsedUrl.hostname,
    agent: false,
    timeout: 45000
  };

  let hasResponded = false;

  const upstreamReq = https.request(options, (upstreamRes) => {
    hasResponded = true;
    const statusCode = upstreamRes.statusCode;

    // Handle Success Responses (2xx)
    if (statusCode >= 200 && statusCode < 300) {
      markKeySuccess(providerId, keyIndex);
      if (isStream) {
        if (provider.type === 'gemini-native') {
          streamGeminiToOpenAI(upstreamRes, res, requestedModel);
        } else {
          // Zero-loss stream pipe
          const resHeaders = {
            'Content-Type': 'text/event-stream',
            'Cache-Control': 'no-cache, no-transform',
            'Connection': 'keep-alive',
            'X-Accel-Buffering': 'no'
          };
          delete resHeaders['content-encoding'];
          res.writeHead(statusCode, resHeaders);
          upstreamRes.pipe(res);
        }
      } else {
        let resData = '';
        upstreamRes.on('data', chunk => { resData += chunk; });
        upstreamRes.on('end', () => {
          if (provider.type === 'gemini-native') {
            try {
              const geminiObj = JSON.parse(resData);
              const openAIObj = translateGeminiResponse(geminiObj, requestedModel);
              res.writeHead(200, { 'Content-Type': 'application/json' });
              res.end(JSON.stringify(openAIObj));
            } catch (err) {
              res.writeHead(500, { 'Content-Type': 'application/json' });
              res.end(JSON.stringify({ error: { message: `Failed to parse Gemini response: ${err.message}` } }));
            }
          } else {
            let finalResData = resData;
            if (targetModelId !== requestedModel) {
              try {
                const resObj = JSON.parse(resData);
                if (resObj.model === targetModelId) {
                  resObj.model = requestedModel;
                  finalResData = JSON.stringify(resObj);
                }
              } catch (e) {}
            }
            res.writeHead(statusCode, upstreamRes.headers);
            res.end(finalResData);
          }
        });
      }
      return;
    }

    // Handle Upstream Error (4xx, 5xx)
    let errData = '';
    upstreamRes.on('data', chunk => { errData += chunk; });
    upstreamRes.on('end', () => {
      let errMsg = errData;
      try {
        const parsed = JSON.parse(errData);
        errMsg = parsed.error?.message || parsed.message || errData;
      } catch (e) {}

      console.warn(`[Proxy] Upstream provider '${provider.name}' error HTTP ${statusCode}: ${errMsg.slice(0, 200)}`);

      if (isRetryableError(statusCode, errMsg) && attempt < maxAttempts) {
        console.warn(`[Proxy] Retryable error encountered. Rotating key index for ${provider.name}...`);
        stats.failovers++;
        providerKeyPointers[providerId] = (providerKeyPointers[providerId] + 1) % keysPool.length;
        forwardRequest(req, res, provider, bodyData, attempt + 1, isStream, requestedModel, matchedModel);
      } else {
        // Record log and mark key fail only if non-retryable or max attempts exhausted
        recordErrorLog({
          statusCode,
          model: requestedModel,
          providerId: providerId,
          providerName: provider.name,
          attempt,
          keyIndex,
          errorMessage: errMsg.slice(0, 300),
          userAgent: req.headers['user-agent'] || 'Unknown'
        });
        stats.errors++;
        res.writeHead(statusCode, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: { message: `Provider error (${provider.name}): ${errMsg}`, status: statusCode } }));
      }
    });
  });

  upstreamReq.on('timeout', () => {
    if (hasResponded) return;
    console.warn(`[Proxy] Upstream request to ${provider.name} timed out (45s).`);
    upstreamReq.destroy(new Error('Gateway Timeout (45s)'));
  });

  req.on('close', () => {
    if (!hasResponded) upstreamReq.destroy();
  });

  upstreamReq.on('error', (err) => {
    console.error(`[Proxy] Connection error to ${provider.name} (attempt ${attempt}/${maxAttempts}):`, err.message);

    if (isRetryableError(500, err.message) && attempt < maxAttempts) {
      stats.failovers++;
      providerKeyPointers[providerId] = (providerKeyPointers[providerId] + 1) % keysPool.length;
      forwardRequest(req, res, provider, bodyData, attempt + 1, isStream, requestedModel, matchedModel);
    } else {
      recordErrorLog({
        statusCode: 502,
        model: requestedModel,
        providerId: providerId,
        providerName: provider.name,
        attempt,
        keyIndex,
        errorMessage: `Connection failed: ${err.message}`,
        userAgent: req.headers['user-agent'] || 'Unknown'
      });
      stats.errors++;
      if (!res.headersSent) {
        res.writeHead(502, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: { message: `Bad Gateway: Connection failed to ${provider.name}. ${err.message}` } }));
      }
    }
  });

  upstreamReq.write(finalBodyStr);
  upstreamReq.end();
}

// =============================================================================
// 5. Dashboard HTML Web UI (Single Page Application)
// =============================================================================
function renderDashboardHtml(uptime, host) {
  return `<!DOCTYPE html>
<html lang="zh-CN">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>FreeLLMAPI Gateway 控制台</title>
<style>
:root {
  --bg: #f7f8fc;
  --card: #ffffff;
  --border: #e5e7eb;
  --border-soft: #f0f1f4;
  --muted: #71717a;
  --muted-2: #a1a1aa;
  --text: #0a0a0b;
  --primary: #1a73e8;
  --primary-soft: #ebf2fe;
  --ok-bg: #e8f5ec; --ok-fg: #1e7c3a; --ok-dot: #34a853;
  --cool-bg: #fef7e6; --cool-fg: #b45f06; --cool-dot: #f9ab00;
  --blown-bg: #fdebeb; --blown-fg: #c5362f; --blown-dot: #ea4335;
  --mono: ui-monospace, SFMono-Regular, Menlo, Consolas, "Roboto Mono", monospace;
  --sans: system-ui, -apple-system, "Segoe UI", Roboto, "PingFang SC", "Microsoft YaHei", sans-serif;
}
* { box-sizing: border-box; }
body { margin: 0; font-family: var(--sans); background: var(--bg); color: var(--text); font-size: 14px; }
a { color: var(--primary); text-decoration: none; }
button { font-family: inherit; cursor: pointer; }
.topbar { height: 56px; background: var(--card); border-bottom: 1px solid var(--border); display: flex; align-items: center; justify-content: space-between; padding: 0 32px; position: sticky; top: 0; z-index: 10; }
.brand { display: flex; align-items: center; gap: 10px; font-weight: 700; font-size: 15px; }
.brand .mark { width: 22px; height: 22px; border-radius: 6px; background: var(--primary); display: inline-flex; align-items: center; justify-content: center; color: #fff; font-size: 13px; font-weight: 700; }
.brand .sub { font-size: 12px; color: var(--muted-2); font-weight: 400; }
.topright { display: flex; align-items: center; gap: 12px; }
.status-pill { display: inline-flex; align-items: center; gap: 6px; background: var(--ok-bg); color: var(--ok-fg); padding: 5px 10px; border-radius: 999px; font-size: 12px; font-weight: 500; }
.status-pill .sdot { width: 8px; height: 8px; border-radius: 50%; background: var(--ok-dot); }
.btn-ghost { background: #fff; border: 1px solid var(--border); color: var(--muted); padding: 6px 12px; border-radius: 6px; font-size: 13px; }
.content { max-width: 1200px; margin: 0 auto; padding: 28px 32px 48px; }
.wrap-section { margin-bottom: 24px; }
.overview { background: var(--card); border: 1px solid var(--border); border-radius: 10px; overflow: hidden; }
.metrics { display: grid; grid-template-columns: repeat(4, 1fr); }
.metric { padding: 18px 22px; border-right: 1px solid var(--border-soft); }
.metric:last-child { border-right: none; }
.metric .mlabel { font-size: 12px; color: var(--muted); margin-bottom: 6px; }
.metric .mval { font-size: 24px; font-weight: 600; font-family: var(--mono); }
.metric.warn .mval { color: #b45f06; }
.metric.err .mval { color: var(--blown-fg); }
.access-row { display: flex; align-items: center; justify-content: space-between; gap: 24px; padding: 12px 22px; border-top: 1px solid var(--border-soft); flex-wrap: wrap; }
.access-group { display: flex; align-items: center; gap: 28px; flex-wrap: wrap; }
.access-item { display: flex; align-items: center; gap: 8px; }
.access-item .alabel { font-size: 12px; color: var(--muted-2); }
.access-item .aval { font-size: 12px; font-family: var(--mono); color: #3f3f46; }
.copy-ic { width: 14px; height: 14px; color: var(--muted-2); cursor: pointer; }
.sec-head { display: flex; align-items: center; justify-content: space-between; margin: 4px 0 14px; }
.sec-title { font-size: 16px; font-weight: 600; display: flex; align-items: center; gap: 8px; }
.count-badge { font-family: var(--mono); font-size: 11px; background: var(--border-soft); color: var(--muted); padding: 2px 7px; border-radius: 4px; }
.btn-primary { background: var(--primary); border: none; color: #fff; padding: 7px 14px; border-radius: 6px; font-size: 13px; font-weight: 500; display: inline-flex; align-items: center; gap: 6px; }
.pgrid { display: grid; grid-template-columns: repeat(2, 1fr); gap: 16px; }
.pcard { background: var(--card); border: 1px solid var(--border); border-radius: 10px; padding: 16px 18px; }
.pcard .phead { display: flex; align-items: center; justify-content: space-between; gap: 12px; }
.pname { font-size: 15px; font-weight: 600; display: flex; align-items: center; gap: 8px; }
.ptype { font-size: 11px; font-family: var(--mono); padding: 2px 7px; border-radius: 4px; background: var(--primary-soft); color: var(--primary); }
.pactions { display: flex; gap: 2px; }
.icon-btn { width: 28px; height: 28px; display: inline-flex; align-items: center; justify-content: center; border-radius: 4px; border: none; background: transparent; color: var(--muted); }
.icon-btn:hover { background: var(--border-soft); }
.purl { font-size: 12px; font-family: var(--mono); color: var(--muted-2); margin: 10px 0 12px; word-break: break-all; }
.keyblock { border-top: 1px solid var(--border-soft); padding-top: 12px; }
.keylabel { font-size: 12px; font-weight: 500; color: var(--muted); margin-bottom: 8px; display: flex; align-items: center; justify-content: space-between; }
.keylabel .ksum { font-size: 11px; color: var(--muted-2); font-weight: 400; }
.kgrid { display: flex; flex-wrap: wrap; gap: 8px; }
.key-pill { display: inline-flex; align-items: center; gap: 6px; padding: 6px 10px; border-radius: 6px; font-family: var(--mono); font-size: 12px; min-width: 120px; }
.key-pill .kdot { width: 7px; height: 7px; border-radius: 50%; flex: none; }
.key-pill .kidx { font-weight: 600; }
.key-pill .kmask { color: inherit; opacity: 0.85; }
.key-ok { background: var(--ok-bg); color: var(--ok-fg); }
.key-ok .kdot { background: var(--ok-dot); }
.key-cool { background: var(--cool-bg); color: var(--cool-fg); }
.key-cool .kdot { background: var(--cool-dot); }
.key-blown { background: var(--blown-bg); color: var(--blown-fg); }
.key-blown .kdot { background: var(--blown-dot); }
.lastfail { font-size: 11px; font-family: var(--mono); color: var(--muted-2); margin-top: 8px; }
.models { display: flex; flex-wrap: wrap; gap: 6px; margin-top: 12px; }
.model-tag { font-size: 11px; font-family: var(--mono); background: #f7f8fa; border: 1px solid var(--border-soft); color: var(--muted); padding: 3px 8px; border-radius: 4px; }
.logs-head { cursor: pointer; user-select: none; }
.logs-head .chev { transition: transform 0.15s; display: inline-block; color: var(--muted); }
.collapsed .chev { transform: rotate(-90deg); }
.logs-body { margin-top: 12px; }
.filterbar { display: flex; align-items: center; gap: 10px; flex-wrap: wrap; margin-bottom: 12px; }
.search-box { width: 240px; height: 32px; border: 1px solid var(--border); border-radius: 6px; padding: 0 10px; font-size: 12px; font-family: inherit; background: #fff; }
.chip { border: 1px solid var(--border); background: #fff; color: var(--muted); padding: 5px 10px; border-radius: 6px; font-size: 12px; font-family: var(--mono); }
.chip.active.ck-429 { background: var(--cool-bg); border-color: #fde6c0; color: var(--cool-fg); font-weight: 600; }
.chip.active.ck-5xx { background: var(--blown-bg); border-color: #f8d4d4; color: var(--blown-fg); font-weight: 600; }
.chip.active.ck-400 { background: var(--primary-soft); border-color: #c7dcfb; color: var(--primary); font-weight: 600; }
.sel { height: 32px; border: 1px solid var(--border); border-radius: 6px; padding: 0 10px; font-size: 12px; font-family: inherit; background: #fff; color: var(--muted); }
.ltable { width: 100%; border-collapse: collapse; background: var(--card); border: 1px solid var(--border); border-radius: 10px; overflow: hidden; }
.ltable th { text-align: left; font-size: 12px; color: var(--muted); font-weight: 600; background: #f7f8fa; padding: 10px 16px; border-bottom: 1px solid var(--border); }
.ltable td { font-size: 12px; padding: 10px 16px; border-bottom: 1px solid var(--border-soft); }
.ltable tr:last-child td { border-bottom: none; }
.ltable .mono { font-family: var(--mono); color: #3f3f46; }
.st-badge { font-family: var(--mono); font-weight: 600; padding: 2px 7px; border-radius: 4px; font-size: 11px; }
.st-4 { background: var(--primary-soft); color: var(--primary); }
.st-429 { background: var(--cool-bg); color: var(--cool-fg); }
.st-5 { background: var(--blown-bg); color: var(--blown-fg); }
.pager { display: flex; align-items: center; justify-content: space-between; padding: 10px 16px; background: var(--card); }
.pager .pinfo { font-size: 12px; color: var(--muted-2); }
.pager .pbtns { display: flex; gap: 6px; }
.pbtn { width: 28px; height: 28px; border: 1px solid var(--border); background: #fff; border-radius: 4px; color: var(--muted); display: inline-flex; align-items: center; justify-content: center; }
.pbtn:disabled { opacity: 0.4; cursor: default; }
.login-wrap { min-height: 100vh; display: flex; align-items: center; justify-content: center; background: var(--bg); }
.login-card { width: 380px; background: var(--card); border: 1px solid var(--border); border-radius: 12px; padding: 36px; text-align: center; }
.login-card .mark { width: 40px; height: 40px; border-radius: 10px; background: var(--primary); color: #fff; font-weight: 700; font-size: 18px; display: inline-flex; align-items: center; justify-content: center; margin-bottom: 16px; }
.login-card h2 { font-size: 20px; margin: 0 0 6px; }
.login-card p { color: var(--muted); font-size: 13px; margin: 0 0 22px; }
.login-input { width: 100%; height: 44px; border: 1px solid var(--border); border-radius: 6px; padding: 0 14px; font-size: 14px; font-family: inherit; }
.login-btn { width: 100%; height: 42px; background: var(--primary); border: none; color: #fff; border-radius: 6px; font-size: 14px; font-weight: 600; margin-top: 16px; }
.login-hint { font-size: 12px; color: var(--muted-2); margin-top: 14px; }
.modal-mask { position: fixed; inset: 0; background: rgba(10,10,11,0.45); display: none; align-items: center; justify-content: center; z-index: 100; }
.modal-mask.active { display: flex; }
.modal { width: 560px; max-width: 92vw; background: var(--card); border: 1px solid var(--border); border-radius: 12px; padding: 24px; max-height: 90vh; overflow-y: auto; }
.modal h3 { margin: 0 0 18px; font-size: 16px; }
.form-row { margin-bottom: 14px; }
.form-row label { display: block; font-size: 12px; color: var(--muted); margin-bottom: 6px; }
.form-row input, .form-row select, .form-row textarea { width: 100%; border: 1px solid var(--border); border-radius: 6px; padding: 9px 11px; font-size: 13px; font-family: inherit; background: #fff; }
.form-row textarea { font-family: var(--mono); resize: vertical; }
.modal-actions { display: flex; justify-content: flex-end; gap: 10px; margin-top: 18px; }
.toast { position: fixed; bottom: 24px; left: 50%; transform: translateX(-50%); background: #0a0a0b; color: #fff; padding: 10px 18px; border-radius: 8px; font-size: 13px; opacity: 0; transition: opacity 0.2s; pointer-events: none; z-index: 200; }
.toast.show { opacity: 0.95; }
</style>
</head>
<body>
<body>
<div id="topbar" class="topbar">
  <div class="brand"><span class="mark">F</span><span>FreeLLMAPI<span class="sub"> Gateway Console</span></span></div>
  <div class="topright">
    <span class="status-pill"><span class="sdot"></span><span id="runState">运行中</span></span>
    <button class="btn-ghost" id="authNavBtn" onclick="toggleAuthAction()">未登录</button>
  </div>
</div>

<div class="content">
  <!-- Public Metrics Bar: Always visible to everyone without login -->
  <div class="wrap-section">
    <div class="overview">
      <div class="metrics">
        <div class="metric"><div class="mlabel">运行时长</div><div class="mval" id="statUptime">0分 0秒</div></div>
        <div class="metric"><div class="mlabel">累计请求</div><div class="mval" id="statTotalReq">0</div></div>
        <div class="metric warn"><div class="mlabel">故障切换</div><div class="mval" id="statFailovers">0</div></div>
        <div class="metric err"><div class="mlabel">捕获错误</div><div class="mval" id="statErrors">0</div></div>
      </div>
    </div>
  </div>

  <!-- Login Card: Displayed when unauthenticated below public stats -->
  <div id="loginView" class="login-wrap" style="display:flex; min-height: initial; padding: 20px 0;">
    <div class="login-card" style="width: 420px; max-width: 100%;">
      <div class="mark">F</div>
      <h2>控制台身份验证</h2>
      <p>请输入后台 ACCESS_TOKEN 以解锁配置管理与错误日志</p>
      <form onsubmit="handleLogin(event)">
        <input class="login-input" type="password" id="tokenInput" placeholder="输入 ACCESS_TOKEN" autocomplete="off" required>
        <div id="loginError" style="display:none; color: var(--blown-fg); font-size: 13px; margin-top: 10px; text-align: left; background: var(--blown-bg); padding: 8px 12px; border-radius: 6px; border: 1px solid #f8d4d4;"></div>
        <button class="login-btn" type="submit" id="loginSubmitBtn">验证并登录</button>
      </form>
      <div class="login-hint">Token 存放于本地浏览器，密钥由 Cloud Run 安全管理</div>
    </div>
  </div>

  <!-- Main View: Protected details & management -->
  <div id="mainView" style="display:none;">
    <div class="wrap-section" style="margin-top: 16px;">
      <div class="overview" style="background: var(--card); border: 1px solid var(--border); border-radius: 10px; padding: 12px 22px;">
        <div class="access-row" style="border-top: none; padding: 0;">
          <div class="access-group">
            <div class="access-item"><span class="alabel">Base URL</span><span class="aval" id="baseUrl">-</span><svg class="copy-ic" onclick="copyText('baseUrl')" viewBox="0 0 14 14" fill="none"><rect x="4.6" y="4.6" width="7.9" height="7.9" rx="1.5" stroke="currentColor" stroke-width="1.2"/><path d="M9.4 2.5H2.6C2.05 2.5 1.6 2.95 1.6 3.5V10.3" stroke="currentColor" stroke-width="1.2" stroke-linecap="round"/></svg></div>
            <div class="access-item"><span class="alabel">API Key</span><span class="aval" id="apiKeyMask">-</span><svg class="copy-ic" onclick="copyText('apiKeyMask')" viewBox="0 0 14 14" fill="none"><rect x="4.6" y="4.6" width="7.9" height="7.9" rx="1.5" stroke="currentColor" stroke-width="1.2"/><path d="M9.4 2.5H2.6C2.05 2.5 1.6 2.95 1.6 3.5V10.3" stroke="currentColor" stroke-width="1.2" stroke-linecap="round"/></svg></div>
          </div>
          <div class="access-item"><span class="alabel">可用 Key</span><span class="aval" id="availKeys">-</span></div>
        </div>
      </div>
    </div>

    <div class="wrap-section">
      <div class="sec-head">
        <div class="sec-title">服务提供商 <span class="count-badge" id="provCount">0</span></div>
        <button class="btn-primary" onclick="openAddProviderModal()">+ 添加提供商</button>
      </div>
      <div class="pgrid" id="providerCards"></div>
    </div>

    <div class="wrap-section" id="logsSection">
      <div class="sec-head logs-head" onclick="toggleLogs()">
        <div class="sec-title"><span class="chev">▾</span>错误日志审计 <span class="count-badge" id="logCount">0</span></div>
        <button class="btn-ghost" onclick="event.stopPropagation();clearLogs()">清空日志</button>
      </div>
      <div class="logs-body" id="logsBody">
        <div class="filterbar">
          <input class="search-box" id="searchInput" placeholder="搜索模型或错误关键词" oninput="onFilterChange()">
          <button class="chip ck-400" id="chip-400" onclick="toggleChip('400')">400</button>
          <button class="chip ck-429" id="chip-429" onclick="toggleChip('429')">429</button>
          <button class="chip ck-5xx" id="chip-5xx" onclick="toggleChip('5xx')">5xx</button>
          <select class="sel" id="provFilter" onchange="onFilterChange()"></select>
        </div>
        <table class="ltable">
          <thead><tr><th style="width:170px;">时间</th><th style="width:70px;">状态码</th><th style="width:190px;">模型</th><th style="width:120px;">提供商</th><th style="width:70px;">Key</th><th>错误摘要</th></tr></thead>
          <tbody id="logsTable"></tbody>
        </table>
        <div class="pager">
          <div class="pinfo" id="pageInfo"></div>
          <div class="pbtns"><button class="pbtn" id="prevPage" onclick="changePage(-1)">‹</button><button class="pbtn" id="nextPage" onclick="changePage(1)">›</button></div>
        </div>
      </div>
    </div>
  </div>
</div>

<div class="modal-mask" id="providerModal">
  <div class="modal">
    <h3 id="modalTitle">添加提供商</h3>
    <form onsubmit="saveProviderForm(event)">
      <input type="hidden" id="provId">
      <div class="form-row"><label>提供商名称</label><input type="text" id="provName" required placeholder="如 OpenCode Zen"></div>
      <div class="form-row"><label>代理转发类型</label><select id="provType"><option value="openai-passthrough">OpenAI 兼容（无损透传）</option><option value="gemini-native">Google Gemini 原生转换</option></select></div>
      <div class="form-row"><label>上游 Base URL</label><input type="text" id="provBaseUrl" required placeholder="https://opencode.ai/zen/v1/chat/completions"></div>
      <div class="form-row"><label>API Keys 池（每行一个，自动轮换）</label><textarea id="provKeys" rows="5" required placeholder="sk-key1&#10;sk-key2"></textarea></div>
      <div class="form-row"><label>模型列表（逗号分隔）</label><textarea id="provModels" rows="3" required placeholder="deepseek-v4-flash-free, hy3-free"></textarea></div>
      <div class="modal-actions"><button type="button" class="btn-ghost" onclick="closeModal()">取消</button><button type="submit" class="btn-primary">保存配置</button></div>
    </form>
  </div>
</div>

<div class="toast" id="toast"></div>

<script>
function lsGet(k){ try { return localStorage.getItem(k); } catch(e){ return null; } }
function lsSet(k,v){ try { localStorage.setItem(k,v); } catch(e){} }
function lsDel(k){ try { localStorage.removeItem(k); } catch(e){} }
let authToken = lsGet('ACCESS_TOKEN') || '';
let currentConfig = { providers: [] };
let keyHealthView = {};
let allLogs = [];
let filterStatus = '';
let filterProvider = '';
let searchTerm = '';
let page = 1;
const PAGE_SIZE = 8;

function toast(msg) {
  const t = document.getElementById('toast');
  t.innerText = msg;
  t.classList.add('show');
  setTimeout(function(){ t.classList.remove('show'); }, 2200);
}
async function fetchPublicStats() {
  try {
    const res = await fetch('/api/public-stats');
    if (res.ok) {
      const data = await res.json();
      const up = data.uptime || 0;
      const mins = Math.floor(up / 60);
      const secs = up % 60;
      document.getElementById('statUptime').innerText = mins + '分 ' + secs + '秒';
      document.getElementById('statTotalReq').innerText = data.totalRequests || 0;
      document.getElementById('statFailovers').innerText = data.failovers || 0;
      document.getElementById('statErrors').innerText = data.errors || 0;
    }
  } catch(e) {}
}
function checkAuth() {
  fetchPublicStats();
  if (!authToken) {
    document.getElementById('loginView').style.display = 'flex';
    document.getElementById('mainView').style.display = 'none';
    document.getElementById('authNavBtn').innerText = '未登录';
  } else {
    document.getElementById('loginView').style.display = 'none';
    document.getElementById('mainView').style.display = 'block';
    document.getElementById('authNavBtn').innerText = '退出登录';
    fetchData();
  }
}
function toggleAuthAction() {
  if (authToken) {
    logout();
  } else {
    document.getElementById('tokenInput').focus();
  }
}
async function handleLogin(e) {
  e.preventDefault();
  const errEl = document.getElementById('loginError');
  const btn = document.getElementById('loginSubmitBtn');
  errEl.style.display = 'none';
  const inputVal = document.getElementById('tokenInput').value.trim();
  if (!inputVal) return;

  btn.disabled = true;
  btn.innerText = '正在验证密钥...';

  try {
    const res = await fetch('/api/config', {
      headers: { 'Authorization': 'Bearer ' + encodeURIComponent(inputVal) }
    });
    if (res.status === 200) {
      authToken = inputVal;
      lsSet('ACCESS_TOKEN', authToken);
      btn.disabled = false;
      btn.innerText = '验证并登录';
      checkAuth();
    } else {
      errEl.innerText = '密钥无效！ACCESS_TOKEN 错误，请检查后再试。';
      errEl.style.display = 'block';
      btn.disabled = false;
      btn.innerText = '验证并登录';
    }
  } catch (err) {
    errEl.innerText = '网络连接异常，无法完成验证。';
    errEl.style.display = 'block';
    btn.disabled = false;
    btn.innerText = '验证并登录';
  }
}
function logout() {
  lsDel('ACCESS_TOKEN');
  authToken = '';
  checkAuth();
}
async function fetchData() {
  try {
    const [resConfig, resLogs] = await Promise.all([
      fetch('/api/config', { headers: { 'Authorization': 'Bearer ' + encodeURIComponent(authToken) } }),
      fetch('/api/logs', { headers: { 'Authorization': 'Bearer ' + encodeURIComponent(authToken) } })
    ]);
    if (resConfig.status === 401 || resLogs.status === 401) {
      toast('ACCESS_TOKEN 错误，已自动注销');
      logout();
      return;
    }
    currentConfig = await resConfig.json();
    const logsData = await resLogs.json();
    allLogs = logsData.logs || [];
    keyHealthView = logsData.keyHealth || {};
    renderStats(logsData.stats || {});
    renderProviders();
    renderLogs();
  } catch (e) { console.error(e); }
}
function maskToken(t) {
  if (!t) return '-';
  if (t.length <= 8) return t;
  return t.slice(0, 6) + '…' + t.slice(-4);
}
function renderStats(s) {
  document.getElementById('statTotalReq').innerText = s.totalRequests || 0;
  document.getElementById('statFailovers').innerText = s.failovers || 0;
  document.getElementById('statErrors').innerText = s.errors || 0;
  if (s.startTime) {
    const up = Math.floor((Date.now() - new Date(s.startTime).getTime()) / 1000);
    const mins = Math.floor(up / 60);
    const secs = up % 60;
    document.getElementById('statUptime').innerText = mins + '分 ' + secs + '秒';
  }
  document.getElementById('baseUrl').innerText = 'https://' + (location.host) + '/v1';
  document.getElementById('apiKeyMask').innerText = maskToken(currentConfig.accessToken);
  let ok = 0, total = 0;
  for (const pid in keyHealthView) {
    keyHealthView[pid].forEach(function(k){ total++; if (k.state === 'ok') ok++; });
  }
  document.getElementById('availKeys').innerText = ok + ' / ' + total;
}
function stateClass(state) {
  if (state === 'cooling') return 'key-cool';
  if (state === 'blown') return 'key-blown';
  return 'key-ok';
}
function renderProviders() {
  const container = document.getElementById('providerCards');
  const providers = currentConfig.providers || [];
  document.getElementById('provCount').innerText = providers.length;
  container.innerHTML = providers.map(function(p, idx) {
    const pid = p.id || p.name;
    const keys = keyHealthView[pid] || [];
    const keysHtml = keys.map(function(k) {
      return '<div class="key-pill ' + stateClass(k.state) + '"><span class="kdot"></span><span class="kidx">#' + k.index + '</span><span class="kmask">' + (k.masked || '') + '</span></div>';
    }).join('');
    let okN = 0, coolN = 0, blownN = 0;
    keys.forEach(function(k){ if (k.state === 'cooling') coolN++; else if (k.state === 'blown') blownN++; else okN++; });
    const ksum = keys.length ? (okN + ' 正常 · ' + coolN + ' 冷却 · ' + blownN + ' 熔断') : '无 Key';
    const lastFail = lastFailOf(pid);
    const modelsHtml = (p.models || []).map(function(m){ const id = typeof m === 'string' ? m : m.id; return '<span class="model-tag">' + id + '</span>'; }).join('');
    return '<div class="pcard">' +
      '<div class="phead"><div class="pname">' + p.name + ' <span class="ptype">' + p.type + '</span></div>' +
      '<div class="pactions"><button class="icon-btn" title="编辑" onclick="editProvider(' + idx + ')"><svg width="15" height="15" viewBox="0 0 15 15" fill="none"><path d="M9.8 3.1L11.9 5.2" stroke="#71717a" stroke-width="1.2" stroke-linecap="round"/><path d="M2.6 12.4L3.3 9.8L10.2 2.9C10.6 2.5 11.2 2.5 11.6 2.9L12.1 3.4C12.5 3.8 12.5 4.4 12.1 4.8L5.2 11.7L2.6 12.4Z" stroke="#71717a" stroke-width="1.2" stroke-linecap="round" stroke-linejoin="round"/></svg></button>' +
      '<button class="icon-btn" title="删除" onclick="deleteProvider(' + idx + ')"><svg width="15" height="15" viewBox="0 0 15 15" fill="none"><path d="M2.9 4.3H12.1M5.9 2.6H9.1M4.3 4.3L4.9 12C4.94 12.5 5.3 12.8 5.8 12.8H9.2C9.7 12.8 10.06 12.5 10.1 12L10.7 4.3" stroke="#71717a" stroke-width="1.2" stroke-linecap="round" stroke-linejoin="round"/></svg></button></div></div>' +
      '<div class="purl">' + (p.baseUrl || '') + '</div>' +
      '<div class="keyblock"><div class="keylabel"><span>Key 池</span><span class="ksum">' + ksum + '</span></div><div class="kgrid">' + (keysHtml || '<span class="kmask" style="color:#a1a1aa;">未配置 Key</span>') + '</div>' +
      (lastFail ? '<div class="lastfail">最近失败 · ' + lastFail + '</div>' : '') +
      (modelsHtml ? '<div class="models">' + modelsHtml + '</div>' : '') +
      '</div></div>';
  }).join('');
}
function lastFailOf(pid) {
  let best = null;
  allLogs.forEach(function(l){
    if ((l.providerId || l.providerName) === pid) {
      if (!best || new Date(l.timestamp) > new Date(best.timestamp)) best = l;
    }
  });
  if (!best) return '';
  const t = new Date(best.timestamp);
  const mins = Math.floor((Date.now() - t.getTime()) / 60000);
  const ago = mins < 1 ? '刚刚' : (mins < 60 ? mins + ' 分钟前' : Math.floor(mins / 60) + ' 小时前');
  return 'Key #' + best.keyIndex + ' · ' + best.statusCode + ' ' + (best.errorMessage || '').slice(0, 40) + ' · ' + ago;
}
function filteredLogs() {
  return allLogs.filter(function(l){
    if (filterStatus === '400' && l.statusCode !== 400) return false;
    if (filterStatus === '429' && l.statusCode !== 429) return false;
    if (filterStatus === '5xx' && !(l.statusCode >= 500)) return false;
    if (filterProvider && (l.providerId || l.providerName) !== filterProvider) return false;
    if (searchTerm) {
      const hay = ((l.model || '') + ' ' + (l.errorMessage || '')).toLowerCase();
      if (hay.indexOf(searchTerm) === -1) return false;
    }
    return true;
  });
}
function renderLogs() {
  const tbody = document.getElementById('logsTable');
  const list = filteredLogs();
  const total = list.length;
  const pages = Math.max(1, Math.ceil(total / PAGE_SIZE));
  if (page > pages) page = pages;
  const start = (page - 1) * PAGE_SIZE;
  const slice = list.slice(start, start + PAGE_SIZE);
  tbody.innerHTML = slice.map(function(l){
    const st = l.statusCode >= 500 ? 'st-5' : (l.statusCode === 429 ? 'st-429' : 'st-4');
    return '<tr><td class="mono">' + new Date(l.timestamp).toLocaleString() + '</td>' +
      '<td><span class="st-badge ' + st + '">' + l.statusCode + '</span></td>' +
      '<td class="mono">' + (l.model || '') + '</td>' +
      '<td>' + (l.providerName || l.providerId || '') + '</td>' +
      '<td class="mono">#' + l.keyIndex + '</td>' +
      '<td class="mono" style="color:#71717a;">' + ((l.errorMessage || '').slice(0, 120)) + '</td></tr>';
  }).join('');
  if (total === 0) tbody.innerHTML = '<tr><td colspan="6" style="text-align:center;color:#a1a1aa;padding:24px;">暂无错误日志</td></tr>';
  document.getElementById('logCount').innerText = total;
  document.getElementById('pageInfo').innerText = '共 ' + total + ' 条 · 第 ' + start + '-' + (start + slice.length) + ' 条';
  document.getElementById('prevPage').disabled = page <= 1;
  document.getElementById('nextPage').disabled = page >= pages;
}
function onFilterChange() {
  filterProvider = document.getElementById('provFilter').value;
  searchTerm = document.getElementById('searchInput').value.trim().toLowerCase();
  page = 1;
  renderLogs();
}
function toggleChip(code) {
  filterStatus = (filterStatus === code) ? '' : code;
  document.getElementById('chip-400').classList.toggle('active', filterStatus === '400');
  document.getElementById('chip-429').classList.toggle('active', filterStatus === '429');
  document.getElementById('chip-5xx').classList.toggle('active', filterStatus === '5xx');
  page = 1;
  renderLogs();
}
function changePage(d) { page += d; renderLogs(); }
function toggleLogs() {
  const body = document.getElementById('logsBody');
  const sec = document.getElementById('logsSection');
  const hidden = body.style.display === 'none';
  body.style.display = hidden ? 'block' : 'none';
  sec.classList.toggle('collapsed', !hidden);
}
function refreshProvFilter() {
  const sel = document.getElementById('provFilter');
  const opts = ['<option value="">全部提供商</option>'];
  (currentConfig.providers || []).forEach(function(p){ opts.push('<option value="' + (p.id || p.name) + '">' + p.name + '</option>'); });
  sel.innerHTML = opts.join('');
  sel.value = filterProvider;
}
function openAddProviderModal() {
  document.getElementById('modalTitle').innerText = '添加提供商';
  document.getElementById('provId').value = '';
  document.getElementById('provName').value = '';
  document.getElementById('provType').value = 'openai-passthrough';
  document.getElementById('provBaseUrl').value = '';
  document.getElementById('provKeys').value = '';
  document.getElementById('provModels').value = '';
  document.getElementById('providerModal').classList.add('active');
}
function editProvider(idx) {
  const p = currentConfig.providers[idx];
  document.getElementById('modalTitle').innerText = '编辑提供商';
  document.getElementById('provId').value = idx;
  document.getElementById('provName').value = p.name;
  document.getElementById('provType').value = p.type || 'openai-passthrough';
  document.getElementById('provBaseUrl').value = p.baseUrl;
  document.getElementById('provKeys').value = (p.apiKeys || []).join('\\n');
  document.getElementById('provModels').value = (p.models || []).map(function(m){ return typeof m === 'string' ? m : m.id; }).join(', ');
  document.getElementById('providerModal').classList.add('active');
}
function closeModal() { document.getElementById('providerModal').classList.remove('active'); }
async function saveProviderForm(e) {
  e.preventDefault();
  const idxStr = document.getElementById('provId').value;
  const keys = document.getElementById('provKeys').value.split('\\n').map(function(k){ return k.trim(); }).filter(Boolean);
  const modelsStr = document.getElementById('provModels').value;
  const models = modelsStr.split(',').map(function(m){ return m.trim(); }).filter(Boolean).map(function(m){ return { id: m, targetModel: m }; });
  const providerObj = {
    id: document.getElementById('provName').value.toLowerCase().replace(/\\s+/g, '-'),
    name: document.getElementById('provName').value.trim(),
    type: document.getElementById('provType').value,
    baseUrl: document.getElementById('provBaseUrl').value.trim(),
    apiKeys: keys,
    models: models
  };
  if (idxStr !== '') currentConfig.providers[parseInt(idxStr)] = providerObj;
  else currentConfig.providers.push(providerObj);
  await syncConfig();
  closeModal();
  toast('配置已保存');
  fetchData();
}
async function deleteProvider(idx) {
  if (!confirm('确定删除该提供商配置？')) return;
  currentConfig.providers.splice(idx, 1);
  await syncConfig();
  toast('已删除');
  fetchData();
}
async function syncConfig() {
  await fetch('/api/config', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'Authorization': 'Bearer ' + authToken },
    body: JSON.stringify(currentConfig)
  });
}
async function clearLogs() {
  if (!confirm('确定清空所有错误日志？')) return;
  await fetch('/api/logs/clear', { method: 'POST', headers: { 'Authorization': 'Bearer ' + authToken } });
  toast('日志已清空');
  fetchData();
}
function copyText(elId) {
  const txt = document.getElementById(elId).innerText;
  if (navigator.clipboard) navigator.clipboard.writeText(txt);
  toast('已复制');
}
setInterval(function(){ if (authToken) fetchData(); }, 10000);
checkAuth();
</script>
</body>
</html>`;
}

// =============================================================================
// 6. Router Listener
// =============================================================================
const server = http.createServer((req, res) => {
  // CORS setup
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');

  if (req.method === 'OPTIONS') {
    res.writeHead(204);
    res.end();
    return;
  }

  const parsedUrl = url.parse(req.url, true);

  // 1. Dashboard UI (GET /)
  if (req.method === 'GET' && parsedUrl.pathname === '/') {
    res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
    const uptime = Math.floor((Date.now() - stats.startTime) / 1000);
    res.end(renderDashboardHtml(uptime, req.headers.host));
    return;
  }

  // 2. OpenAI Models (GET /v1/models or GET /models or GET /api/v1/models or GET /api/tags)
  const isModelsPath = parsedUrl.pathname === '/v1/models' || 
                       parsedUrl.pathname === '/models' || 
                       parsedUrl.pathname === '/api/v1/models' || 
                       parsedUrl.pathname === '/api/tags';

  if (req.method === 'GET' && isModelsPath) {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({
      object: 'list',
      data: getAvailableModelsList()
    }));
    return;
  }

  // 3. OpenAI Chat Completions (POST /v1/chat/completions or POST /chat/completions)
  if (req.method === 'POST' && (parsedUrl.pathname === '/v1/chat/completions' || parsedUrl.pathname === '/chat/completions')) {
    stats.totalRequests++;

    if (appConfig.accessToken) {
      const authHeader = req.headers['authorization'] || '';
      const token = authHeader.replace(/^Bearer\s+/i, '').trim();
      if (token !== appConfig.accessToken) {
        res.writeHead(401, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: { message: 'Unauthorized: Invalid access token.', type: 'invalid_request_error' } }));
        return;
      }
    }

    let bodyData = '';
    req.on('data', chunk => { bodyData += chunk; });
    req.on('end', () => {
      let bodyObj;
      try {
        bodyObj = JSON.parse(bodyData);
      } catch (err) {
        res.writeHead(400, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: { message: 'Invalid JSON body.', type: 'invalid_request_error' } }));
        return;
      }

      const requestedModel = bodyObj.model || '';
      const resolved = resolveProviderAndModel(requestedModel);

      if (!resolved) {
        res.writeHead(400, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: { message: `Model '${requestedModel}' is not supported or no keys are configured.`, type: 'invalid_request_error' } }));
        return;
      }

      const { provider, matchedModel } = resolved;
      const isStream = bodyObj.stream === true;
      forwardRequest(req, res, provider, bodyData, 1, isStream, requestedModel, matchedModel);
    });
    return;
  }

  // 3.5. Public Stats API (No authentication required)
  if (req.method === 'GET' && parsedUrl.pathname === '/api/public-stats') {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    const uptimeSec = Math.floor((Date.now() - stats.startTime.getTime()) / 1000);
    res.end(JSON.stringify({
      status: 'ok',
      uptime: uptimeSec,
      totalRequests: stats.totalRequests,
      failovers: stats.failovers,
      errors: stats.errors,
      startTime: stats.startTime
    }));
    return;
  }

  // 4. Admin API - GET /api/config
  if (req.method === 'GET' && parsedUrl.pathname === '/api/config') {
    if (appConfig.accessToken) {
      const authHeader = req.headers['authorization'] || '';
      const token = authHeader.replace(/^Bearer\s+/i, '').trim();
      if (token !== appConfig.accessToken) {
        res.writeHead(401, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: { message: 'Unauthorized' } }));
        return;
      }
    }
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify(appConfig));
    return;
  }

  // 5. Admin API - POST /api/config
  if (req.method === 'POST' && parsedUrl.pathname === '/api/config') {
    if (appConfig.accessToken) {
      const authHeader = req.headers['authorization'] || '';
      const token = authHeader.replace(/^Bearer\s+/i, '').trim();
      if (token !== appConfig.accessToken) {
        res.writeHead(401, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: { message: 'Unauthorized' } }));
        return;
      }
    }
    let body = '';
    req.on('data', chunk => { body += chunk; });
    req.on('end', async () => {
      try {
        const newConfig = JSON.parse(body);
        if (Array.isArray(newConfig.providers)) {
          appConfig.providers = newConfig.providers;
        }
        if (newConfig.accessToken !== undefined) {
          appConfig.accessToken = newConfig.accessToken;
        }
        await writeGcsJson(CONFIG_FILE_NAME, CONFIG_FILE_NAME, appConfig);
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ success: true, config: appConfig }));
      } catch (err) {
        res.writeHead(400, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: { message: `Invalid config format: ${err.message}` } }));
      }
    });
    return;
  }

  // 6. Admin API - GET /api/logs
  if (req.method === 'GET' && parsedUrl.pathname === '/api/logs') {
    if (appConfig.accessToken) {
      const authHeader = req.headers['authorization'] || '';
      const token = authHeader.replace(/^Bearer\s+/i, '').trim();
      if (token !== appConfig.accessToken) {
        res.writeHead(401, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: { message: 'Unauthorized' } }));
        return;
      }
    }
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ stats, logs: errorLogs, keyHealth: buildKeyHealthView() }));
    return;
  }

  // 7. Admin API - POST /api/logs/clear
  if (req.method === 'POST' && parsedUrl.pathname === '/api/logs/clear') {
    if (appConfig.accessToken) {
      const authHeader = req.headers['authorization'] || '';
      const token = authHeader.replace(/^Bearer\s+/i, '').trim();
      if (token !== appConfig.accessToken) {
        res.writeHead(401, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: { message: 'Unauthorized' } }));
        return;
      }
    }
    errorLogs = [];
    writeGcsJson(LOGS_FILE_NAME, LOGS_FILE_NAME, errorLogs);
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ success: true }));
    return;
  }

  // 8. Page Not Found Fallback
  res.writeHead(404, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify({ error: { message: `Path ${parsedUrl.pathname} not found.` } }));
});

// Boot System
initSystemState().then(() => {
  server.listen(PORT, '0.0.0.0', () => {
    console.log(`[Proxy] Gateway server launched on port ${PORT}`);
    console.log(`[Proxy] Loaded ${appConfig.providers.length} provider configuration(s).`);
  });
});
