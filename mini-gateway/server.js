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
    || msg.includes('stream stalled');
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
    timeout: 45000
  };

  let hasResponded = false;

  const upstreamReq = https.request(options, (upstreamRes) => {
    hasResponded = true;
    const statusCode = upstreamRes.statusCode;

    // Handle Success Responses (2xx)
    if (statusCode >= 200 && statusCode < 300) {
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

      // Log 400/401/403/404/429/5xx Error to Audit Log
      recordErrorLog({
        statusCode,
        model: requestedModel,
        providerId: provider.id,
        providerName: provider.name,
        attempt,
        keyIndex,
        errorMessage: errMsg.slice(0, 300),
        userAgent: req.headers['user-agent'] || 'Unknown'
      });

      if (isRetryableError(statusCode, errMsg) && attempt < maxAttempts) {
        console.warn(`[Proxy] Retryable error encountered. Rotating key index for ${provider.name}...`);
        stats.failovers++;
        providerKeyPointers[providerId] = (providerKeyPointers[providerId] + 1) % keysPool.length;
        forwardRequest(req, res, provider, bodyData, attempt + 1, isStream, requestedModel, matchedModel);
      } else {
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
    console.error(`[Proxy] Connection error to ${provider.name}:`, err.message);
    recordErrorLog({
      statusCode: 502,
      model: requestedModel,
      providerId: provider.id,
      providerName: provider.name,
      attempt,
      keyIndex,
      errorMessage: `Connection failed: ${err.message}`,
      userAgent: req.headers['user-agent'] || 'Unknown'
    });

    if (isRetryableError(500, err.message) && attempt < maxAttempts) {
      stats.failovers++;
      providerKeyPointers[providerId] = (providerKeyPointers[providerId] + 1) % keysPool.length;
      forwardRequest(req, res, provider, bodyData, attempt + 1, isStream, requestedModel, matchedModel);
    } else {
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
  <title>FreeLLMAPI Gateway Cockpit</title>
  <link rel="stylesheet" href="https://fonts.googleapis.com/css2?family=Inter:wght@400;500;600;700&display=swap">
  <style>
    :root {
      --bg: #0b0f19;
      --card-bg: #131b2e;
      --card-border: #1e293b;
      --primary: #6366f1;
      --primary-hover: #4f46e5;
      --success: #10b981;
      --warning: #f59e0b;
      --danger: #ef4444;
      --text: #f8fafc;
      --text-muted: #94a3b8;
      --input-bg: #0f172a;
    }
    * { box-sizing: border-box; }
    body {
      font-family: 'Inter', system-ui, -apple-system, sans-serif;
      background-color: var(--bg);
      color: var(--text);
      margin: 0;
      padding: 0;
      display: flex;
      flex-direction: column;
      min-height: 100vh;
    }
    header {
      background: #0f172a;
      border-bottom: 1px solid var(--card-border);
      padding: 1rem 2rem;
      display: flex;
      justify-content: space-between;
      align-items: center;
    }
    .logo { font-size: 1.25rem; font-weight: 700; background: linear-gradient(135deg, #6366f1, #a855f7); -webkit-background-clip: text; -webkit-text-fill-color: transparent; }
    .nav-tabs { display: flex; gap: 0.5rem; margin-top: 1rem; border-bottom: 1px solid var(--card-border); padding: 0 2rem; }
    .tab-btn { background: none; border: none; color: var(--text-muted); padding: 0.75rem 1.25rem; font-size: 0.95rem; font-weight: 500; cursor: pointer; border-bottom: 2px solid transparent; }
    .tab-btn.active { color: #fff; border-bottom-color: var(--primary); }
    main { flex: 1; padding: 2rem; max-width: 1200px; margin: 0 auto; width: 100%; }
    .grid { display: grid; grid-template-columns: repeat(auto-fit, minmax(240px, 1fr)); gap: 1rem; margin-bottom: 2rem; }
    .card { background: var(--card-bg); border: 1px solid var(--card-border); border-radius: 12px; padding: 1.5rem; }
    .card .label { font-size: 0.8rem; color: var(--text-muted); text-transform: uppercase; margin-bottom: 0.4rem; }
    .card .value { font-size: 1.6rem; font-weight: 700; }
    .btn { background: var(--primary); color: #fff; border: none; padding: 0.6rem 1.2rem; border-radius: 8px; font-weight: 600; cursor: pointer; transition: 0.2s; }
    .btn:hover { background: var(--primary-hover); }
    .btn-danger { background: var(--danger); }
    .btn-secondary { background: #334155; }
    table { width: 100%; border-collapse: collapse; margin-top: 1rem; text-align: left; }
    th, td { padding: 0.75rem 1rem; border-bottom: 1px solid var(--card-border); font-size: 0.9rem; }
    th { color: var(--text-muted); font-weight: 600; }
    input, select, textarea { width: 100%; background: var(--input-bg); border: 1px solid var(--card-border); color: #fff; padding: 0.6rem 0.8rem; border-radius: 6px; font-family: inherit; font-size: 0.9rem; margin-top: 0.4rem; }
    .modal { position: fixed; inset: 0; background: rgba(0,0,0,0.7); display: none; justify-content: center; align-items: center; z-index: 100; }
    .modal.active { display: flex; }
    .modal-content { background: var(--card-bg); border: 1px solid var(--card-border); border-radius: 12px; max-width: 600px; width: 90%; padding: 2rem; max-height: 90vh; overflow-y: auto; }
    .login-container { max-width: 400px; margin: 5rem auto; text-align: center; }
    .badge { padding: 0.2rem 0.6rem; border-radius: 4px; font-size: 0.75rem; font-weight: 600; }
    .badge-success { background: rgba(16, 185, 129, 0.2); color: var(--success); }
    .badge-danger { background: rgba(239, 68, 68, 0.2); color: var(--danger); }
    .badge-warning { background: rgba(245, 158, 11, 0.2); color: var(--warning); }
  </style>
</head>
<body>
  <header>
    <div class="logo">🚀 FreeLLMAPI Gateway Cockpit</div>
    <div id="authStatus">
      <button class="btn btn-secondary" onclick="logout()">退出登录</button>
    </div>
  </header>

  <div id="loginView" class="login-container card" style="display: none;">
    <h2>🔐 管理员身份验证</h2>
    <p style="color: var(--text-muted); font-size: 0.9rem;">请输入后台 ACCESS_TOKEN 访问控制面板</p>
    <form onsubmit="handleLogin(event)">
      <input type="password" id="tokenInput" placeholder="输入 ACCESS_TOKEN" required>
      <button class="btn" style="width: 100%; margin-top: 1.5rem;" type="submit">登录系统</button>
    </form>
  </div>

  <div id="mainView" style="display: none;">
    <div class="nav-tabs">
      <button class="tab-btn active" onclick="switchTab('dashboard')">📊 状态总览</button>
      <button class="tab-btn" onclick="switchTab('providers')">⚙️ 提供商与 Key 管理</button>
      <button class="tab-btn" onclick="switchTab('logs')">📝 错误日志审计 (400/429/5xx)</button>
    </div>

    <main>
      <!-- TAB 1: DASHBOARD -->
      <section id="tab-dashboard">
        <div class="grid">
          <div class="card"><div class="label">运行时长</div><div class="value" id="statUptime">0h 0m</div></div>
          <div class="card"><div class="label">累计请求数</div><div class="value" style="color: var(--primary);" id="statTotalReq">0</div></div>
          <div class="card"><div class="label">自动故障切 Key</div><div class="value" style="color: var(--warning);" id="statFailovers">0</div></div>
          <div class="card"><div class="label">捕获错误数</div><div class="value" style="color: var(--danger);" id="statErrors">0</div></div>
        </div>

        <div class="card">
          <h3>📡 接入终端配置说明</h3>
          <p style="color: var(--text-muted); font-size: 0.95rem; line-height: 1.6;">
            在 LobeChat, Cursor, OpenCode, Cline 等客户端中添加 OpenAI 格式接口：<br>
            • <b>Base URL</b>: <code>https://${host || 'your-gateway.run.app'}/v1</code> <br>
            • <b>API Key</b>: <code>填入您设置的 ACCESS_TOKEN</code>
          </p>
        </div>
      </section>

      <!-- TAB 2: PROVIDERS -->
      <section id="tab-providers" style="display: none;">
        <div style="display: flex; justify-content: space-between; align-items: center; margin-bottom: 1rem;">
          <h2>提供商与 Key 池管理</h2>
          <button class="btn" onclick="openAddProviderModal()">+ 添加提供商</button>
        </div>
        <div id="providerCardsList"></div>
      </section>

      <!-- TAB 3: LOGS -->
      <section id="tab-logs" style="display: none;">
        <div style="display: flex; justify-content: space-between; align-items: center; margin-bottom: 1rem;">
          <h2>错误日志审计 (仅记录 400 / 429 / 5xx)</h2>
          <button class="btn btn-secondary" onclick="clearLogs()">清空日志</button>
        </div>
        <div class="card">
          <table>
            <thead>
              <tr>
                <th>时间</th>
                <th>状态码</th>
                <th>请求模型</th>
                <th>提供商</th>
                <th>Key索引</th>
                <th>错误详细信息截取</th>
              </tr>
            </thead>
            <tbody id="logsTableBody"></tbody>
          </table>
        </div>
      </section>
    </main>
  </div>

  <!-- MODAL: ADD/EDIT PROVIDER -->
  <div class="modal" id="providerModal">
    <div class="modal-content">
      <h3 id="modalTitle">添加提供商</h3>
      <form onsubmit="saveProviderForm(event)">
        <input type="hidden" id="provId">
        <div>
          <label class="label">提供商名称</label>
          <input type="text" id="provName" required placeholder="如 OpenCode Zen">
        </div>
        <div style="margin-top: 1rem;">
          <label class="label">代理转发类型</label>
          <select id="provType">
            <option value="openai-passthrough">标准 OpenAI 协议无损透传 (全特性无缝支持)</option>
            <option value="gemini-native">Google Gemini 原生 REST 格式转换</option>
          </select>
        </div>
        <div style="margin-top: 1rem;">
          <label class="label">上游 Base URL 接口地址</label>
          <input type="text" id="provBaseUrl" required placeholder="如 https://opencode.ai/zen/v1/chat/completions">
        </div>
        <div style="margin-top: 1rem;">
          <label class="label">API Keys 池 (每行一个，自动池化轮换)</label>
          <textarea id="provKeys" rows="5" required placeholder="sk-key1&#10;sk-key2"></textarea>
        </div>
        <div style="margin-top: 1rem;">
          <label class="label">包含的模型列表 (JSON 格式或逗号分隔)</label>
          <textarea id="provModels" rows="3" required placeholder="deepseek-v4-flash-free, hy3-free"></textarea>
        </div>
        <div style="display: flex; gap: 1rem; justify-content: flex-end; margin-top: 1.5rem;">
          <button type="button" class="btn btn-secondary" onclick="closeModal()">取消</button>
          <button type="submit" class="btn">保存配置</button>
        </div>
      </form>
    </div>
  </div>

  <script>
    let authToken = localStorage.getItem('ACCESS_TOKEN') || '';
    let currentConfig = { providers: [] };

    function checkAuth() {
      if (!authToken) {
        document.getElementById('loginView').style.display = 'block';
        document.getElementById('mainView').style.display = 'none';
        document.getElementById('authStatus').style.display = 'none';
      } else {
        document.getElementById('loginView').style.display = 'none';
        document.getElementById('mainView').style.display = 'block';
        document.getElementById('authStatus').style.display = 'block';
        fetchData();
      }
    }

    function handleLogin(e) {
      e.preventDefault();
      authToken = document.getElementById('tokenInput').value.trim();
      localStorage.setItem('ACCESS_TOKEN', authToken);
      checkAuth();
    }

    function logout() {
      localStorage.removeItem('ACCESS_TOKEN');
      authToken = '';
      checkAuth();
    }

    function switchTab(name) {
      document.querySelectorAll('.tab-btn').forEach(b => b.classList.remove('active'));
      document.querySelectorAll('section[id^="tab-"]').forEach(s => s.style.display = 'none');
      event.target.classList.add('active');
      document.getElementById('tab-' + name).style.display = 'block';
    }

    async function fetchData() {
      try {
        const resConfig = await fetch('/api/config', { headers: { 'Authorization': 'Bearer ' + authToken } });
        if (resConfig.status === 401) return logout();
        currentConfig = await resConfig.json();
        renderProviders();

        const resLogs = await fetch('/api/logs', { headers: { 'Authorization': 'Bearer ' + authToken } });
        const logsData = await resLogs.json();
        renderLogs(logsData.logs || []);
        renderStats(logsData.stats || {});
      } catch (e) {
        console.error(e);
      }
    }

    function renderStats(s) {
      document.getElementById('statTotalReq').innerText = s.totalRequests || 0;
      document.getElementById('statFailovers').innerText = s.failovers || 0;
      document.getElementById('statErrors').innerText = s.errors || 0;
      if (s.startTime) {
        const uptimeSec = Math.floor((Date.now() - new Date(s.startTime).getTime()) / 1000);
        document.getElementById('statUptime').innerText = \`\${Math.floor(uptimeSec / 3600)}h \${Math.floor((uptimeSec % 3600) / 60)}m\`;
      }
    }

    function renderProviders() {
      const container = document.getElementById('providerCardsList');
      container.innerHTML = currentConfig.providers.map((p, idx) => \`
        <div class="card" style="margin-bottom: 1rem;">
          <div style="display: flex; justify-content: space-between; align-items: center;">
            <h3>\${p.name} <span class="badge \${p.type === 'gemini-native' ? 'badge-warning' : 'badge-success'}">\${p.type}</span></h3>
            <div>
              <button class="btn btn-secondary" onclick="editProvider(\${idx})">编辑</button>
              <button class="btn btn-danger" onclick="deleteProvider(\${idx})">删除</button>
            </div>
          </div>
          <p style="font-family: monospace; font-size: 0.85rem; color: var(--text-muted);">Base URL: \${p.baseUrl}</p>
          <p><b>Keys 数量</b>: \${(p.apiKeys || []).length} 个池化 Key</p>
          <div>
            <b>支持模型</b>: \${(p.models || []).map(m => \`<code style="background: rgba(255,255,255,0.1); padding: 0.2rem 0.4rem; border-radius: 4px; margin-right: 0.4rem;">\${typeof m === 'string' ? m : m.id}</code>\`).join(' ')}
          </div>
        </div>
      \`).join('');
    }

    function renderLogs(logs) {
      const tbody = document.getElementById('logsTableBody');
      tbody.innerHTML = logs.map(l => \`
        <tr>
          <td>\${new Date(l.timestamp).toLocaleString()}</td>
          <td><span class="badge \${l.statusCode >= 500 ? 'badge-danger' : 'badge-warning'}">\${l.statusCode}</span></td>
          <td><code>\${l.model}</code></td>
          <td>\${l.providerName || l.providerId}</td>
          <td>#\${l.keyIndex}</td>
          <td style="font-family: monospace; font-size: 0.8rem; color: var(--danger);">\${(l.errorMessage || '').slice(0, 150)}</td>
        </tr>
      \`).join('');
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
      document.getElementById('provModels').value = (p.models || []).map(m => typeof m === 'string' ? m : m.id).join(', ');
      document.getElementById('providerModal').classList.add('active');
    }

    function closeModal() {
      document.getElementById('providerModal').classList.remove('active');
    }

    async function saveProviderForm(e) {
      e.preventDefault();
      const idxStr = document.getElementById('provId').value;
      const keys = document.getElementById('provKeys').value.split('\\n').map(k => k.trim()).filter(Boolean);
      const modelsStr = document.getElementById('provModels').value;
      const models = modelsStr.split(',').map(m => m.trim()).filter(Boolean).map(m => ({ id: m, targetModel: m }));

      const providerObj = {
        id: document.getElementById('provName').value.toLowerCase().replace(/\\s+/g, '-'),
        name: document.getElementById('provName').value.trim(),
        type: document.getElementById('provType').value,
        baseUrl: document.getElementById('provBaseUrl').value.trim(),
        apiKeys: keys,
        models: models
      };

      if (idxStr !== '') {
        currentConfig.providers[parseInt(idxStr)] = providerObj;
      } else {
        currentConfig.providers.push(providerObj);
      }

      await syncConfig();
      closeModal();
      fetchData();
    }

    async function deleteProvider(idx) {
      if (!confirm('确定删除该提供商配置？')) return;
      currentConfig.providers.splice(idx, 1);
      await syncConfig();
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
      await fetch('/api/logs/clear', {
        method: 'POST',
        headers: { 'Authorization': 'Bearer ' + authToken }
      });
      fetchData();
    }

    checkAuth();
    setInterval(fetchData, 10000);
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

  // 7. Page Not Found Fallback
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
