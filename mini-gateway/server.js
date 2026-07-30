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
function selectProvider(modelName) {
  const model = (modelName || '').toLowerCase();
  
  // If EXPOSED_MODELS is configured, restrict routing to only those allowed models
  if (EXPOSED_MODELS.length > 0) {
    const isExposed = EXPOSED_MODELS.some(m => m.toLowerCase() === model.toLowerCase());
    if (!isExposed) return null;
  }
  
  // 1. Google Gemini Routing (Explicit prefix matches)
  if (model.startsWith('gemini-') && GOOGLE_KEYS.length > 0) {
    return {
      name: 'google',
      url: 'https://generativelanguage.googleapis.com/v1beta',
      keySelector: {
        getKey: () => GOOGLE_KEYS[googleKeyIndex],
        rotate: () => { googleKeyIndex = (googleKeyIndex + 1) % GOOGLE_KEYS.length; },
        length: GOOGLE_KEYS.length
      }
    };
  }
  
  // 2. Custom Provider Routing (Explicit list only!)
  if (CUSTOM_ENDPOINT && CUSTOM_KEYS.length > 0 && CUSTOM_MODELS.includes(model)) {
    return {
      name: 'custom',
      url: CUSTOM_ENDPOINT,
      keySelector: {
        getKey: () => CUSTOM_KEYS[customKeyIndex],
        rotate: () => { customKeyIndex = (customKeyIndex + 1) % CUSTOM_KEYS.length; },
        length: CUSTOM_KEYS.length
      }
    };
  }
  
  // 2.5. OpenCode Routing
  if (model.endsWith('-free') && OPENCODE_KEYS.length > 0) {
    return {
      name: 'opencode',
      url: 'https://opencode.ai/zen/v1/chat/completions',
      keySelector: {
        getKey: () => OPENCODE_KEYS[opencodeKeyIndex],
        rotate: () => { opencodeKeyIndex = (opencodeKeyIndex + 1) % OPENCODE_KEYS.length; },
        length: OPENCODE_KEYS.length
      }
    };
  }
  
  // 3. Nvidia NIM Routing (Catch-all for all other models if Nvidia keys are set)
  // Since Gemini is handled explicitly, and Custom is handled by explicit listing,
  // everything else goes to Nvidia NIM (which hosts all organization-prefixed models like minimaxai/, meta/, z-ai/, microsoft/, qwen/ etc.)
  if (NVIDIA_KEYS.length > 0) {
    return {
      name: 'nvidia',
      url: 'https://integrate.api.nvidia.com/v1/chat/completions',
      keySelector: {
        getKey: () => NVIDIA_KEYS[nvidiaKeyIndex],
        rotate: () => { nvidiaKeyIndex = (nvidiaKeyIndex + 1) % NVIDIA_KEYS.length; },
        length: NVIDIA_KEYS.length
      }
    };
  }

  return null;
}

function getAvailableModelsList() {
  if (EXPOSED_MODELS.length > 0) {
    return EXPOSED_MODELS.map(m => {
      let ownedBy = 'custom';
      const ml = m.toLowerCase();
      if (ml.startsWith('gemini-')) ownedBy = 'google';
      else if (ml.endsWith('-free')) ownedBy = 'opencode';
      else if (ml.includes('nvidia') || ml.startsWith('meta/') || ml.startsWith('mistralai/') || ml.startsWith('deepseek/') || ml.startsWith('google/')) ownedBy = 'nvidia';
      return { id: m, object: 'model', created: 1718000000, owned_by: ownedBy };
    });
  }

  const models = [];
  if (GOOGLE_KEYS.length > 0) {
    models.push(
      { id: 'gemini-1.5-flash', object: 'model', created: 1718000000, owned_by: 'google' },
      { id: 'gemini-1.5-pro', object: 'model', created: 1718000000, owned_by: 'google' },
      { id: 'gemini-2.0-flash-exp', object: 'model', created: 1718000000, owned_by: 'google' },
      { id: 'gemini-2.5-flash', object: 'model', created: 1718000000, owned_by: 'google' },
      { id: 'gemini-2.5-pro', object: 'model', created: 1718000000, owned_by: 'google' },
      { id: 'gemini-3.5-flash-lite', object: 'model', created: 1718000000, owned_by: 'google' },
      { id: 'gemini-3.5-flash', object: 'model', created: 1718000000, owned_by: 'google' }
    );
  }
  if (NVIDIA_KEYS.length > 0) {
    models.push(
      { id: 'nvidia/glm-5.2', object: 'model', created: 1718000000, owned_by: 'nvidia' },
      { id: 'meta/llama-3.3-70b-instruct', object: 'model', created: 1718000000, owned_by: 'nvidia' },
      { id: 'deepseek/deepseek-r1', object: 'model', created: 1718000000, owned_by: 'nvidia' }
    );
  }
  if (OPENCODE_KEYS.length > 0) {
    models.push(
      { id: 'deepseek-v4-flash-free', object: 'model', created: 1718000000, owned_by: 'opencode' },
      { id: 'hy3-free', object: 'model', created: 1718000000, owned_by: 'opencode' }
    );
  }
  CUSTOM_MODELS.forEach(m => {
    models.push({ id: m, object: 'model', created: 1718000000, owned_by: 'custom' });
  });
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
async function forwardRequest(req, res, provider, bodyStr, attempt = 1, isStream = false, model = '') {
  const keySelector = provider.keySelector;
  const apiKey = keySelector.getKey();
  const maxAttempts = keySelector.length;

  console.log(`[Proxy] Forwarding attempt ${attempt}/${maxAttempts} for ${provider.name} (using key index ${provider.name === 'google' ? googleKeyIndex : provider.name === 'nvidia' ? nvidiaKeyIndex : provider.name === 'opencode' ? opencodeKeyIndex : customKeyIndex})`);

  let finalUrl = provider.url;
  let finalBodyStr = bodyStr;
  let targetModel = model;
  
  const headers = { 'Content-Type': 'application/json' };
  if (provider.name !== 'google') {
    headers['Authorization'] = `Bearer ${apiKey}`;
  }

  // Forward original client headers (User-Agent, x-opencode-*, x-client-*, etc.) while stripping gateway tracing leaks
  if (req && req.headers) {
    for (const [key, val] of Object.entries(req.headers)) {
      if (!STRIPPED_HEADERS.has(key.toLowerCase())) {
        headers[key] = val;
      }
    }
  }

  // Fallback realistic User-Agent if client didn't provide one
  if (!headers['user-agent'] && !headers['User-Agent']) {
    headers['User-Agent'] = 'OpenCode/1.0.0 (Desktop)';
  }

  // Rewrite model ID for Nvidia NIM / other mappings
  if (provider.name === 'nvidia' && MODEL_MAPPINGS[model]) {
    targetModel = MODEL_MAPPINGS[model];
    try {
      const bodyObj = JSON.parse(bodyStr);
      bodyObj.model = targetModel;
      finalBodyStr = JSON.stringify(bodyObj);
    } catch (e) {
      console.error('[Proxy] Failed to rewrite body for Nvidia model:', e.message);
    }
  }

  // Google Gemini API Custom Translation
  if (provider.name === 'google') {
    try {
      const openAIObj = JSON.parse(bodyStr);
      const geminiObj = await toGeminiContents(openAIObj.messages);
      const tools = toGeminiTools(openAIObj.tools);

      const thinkingConfig = buildGeminiThinkingConfig(openAIObj.reasoning_effort, model);

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
      finalUrl = `${provider.url}/models/${model}:${action}${apiKey}`;
    } catch (err) {
      console.error('[Proxy] Failed to build native Gemini body:', err.message);
      res.writeHead(400, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: { message: `Failed to translate OpenAI request to Gemini format: ${err.message}` } }));
      return;
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
    timeout: 45000 // Set a strict 45-second timeout for first-byte response
  };

  let hasResponded = false;

  const upstreamReq = https.request(options, (upstreamRes) => {
    hasResponded = true;
    const statusCode = upstreamRes.statusCode;

    // Handle Success Response
    if (statusCode >= 200 && statusCode < 300) {
      if (isStream) {
        if (provider.name === 'google') {
          streamGeminiToOpenAI(upstreamRes, res, model);
        } else if (targetModel !== model) {
          streamOpenAIWithModelRewrite(upstreamRes, res, model, targetModel);
        } else {
          res.writeHead(statusCode, upstreamRes.headers);
          upstreamRes.pipe(res);
        }
      } else {
        let resData = '';
        upstreamRes.on('data', chunk => { resData += chunk; });
        upstreamRes.on('end', () => {
          if (provider.name === 'google') {
            try {
              const geminiObj = JSON.parse(resData);
              const openAIObj = translateGeminiResponse(geminiObj, model);
              res.writeHead(200, { 'Content-Type': 'application/json' });
              res.end(JSON.stringify(openAIObj));
            } catch (err) {
              res.writeHead(500, { 'Content-Type': 'application/json' });
              res.end(JSON.stringify({ error: { message: `Failed to parse Gemini response: ${err.message}` } }));
            }
          } else {
            let finalResData = resData;
            if (targetModel !== model) {
              try {
                const resObj = JSON.parse(resData);
                if (resObj.model === targetModel) {
                  resObj.model = model;
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

    // Handle Upstream Error: buffer body and check if retryable
    let errData = '';
    upstreamRes.on('data', chunk => { errData += chunk; });
    upstreamRes.on('end', () => {
      let errMsg = errData;
      try {
        const parsed = JSON.parse(errData);
        errMsg = parsed.error?.message || parsed.message || errData;
      } catch (e) {}

      console.warn(`[Proxy] Upstream provider ${provider.name} failed with HTTP ${statusCode}: ${errMsg.slice(0, 200)}`);

      if (isRetryableError(statusCode, errMsg) && attempt < maxAttempts) {
        console.warn(`[Proxy] Error classified as retryable. Rotating key and trying again...`);
        stats.failovers++;
        keySelector.rotate();
        forwardRequest(req, res, provider, bodyStr, attempt + 1, isStream, model);
      } else {
        stats.errors++;
        res.writeHead(statusCode, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: { message: `Provider error (${provider.name}): ${errMsg}`, status: statusCode } }));
      }
    });
  });

  // Handle Timeout
  upstreamReq.on('timeout', () => {
    if (hasResponded) return;
    console.warn(`[Proxy] Upstream provider ${provider.name} request timed out after 45 seconds.`);
    upstreamReq.destroy(new Error('Gateway Timeout (45s)'));
  });

  // Clean up upstream connection if the client aborts their request
  req.on('close', () => {
    if (!hasResponded) {
      console.log(`[Proxy] Client disconnected early. Aborting upstream request for ${provider.name}.`);
      upstreamReq.destroy();
    }
  });

  upstreamReq.on('error', (err) => {
    console.error(`[Proxy] Connection error to ${provider.name}:`, err.message);
    if (isRetryableError(500, err.message) && attempt < maxAttempts) {
      stats.failovers++;
      keySelector.rotate();
      forwardRequest(req, res, provider, bodyStr, attempt + 1, isStream, model);
    } else {
      stats.errors++;
      // Check if headers have already been sent to prevent crash
      if (!res.headersSent) {
        res.writeHead(502, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: { message: `Bad Gateway: connection failed to upstream provider. ${err.message}` } }));
      }
    }
  });

  upstreamReq.write(finalBodyStr);
  upstreamReq.end();
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
    const html = `
    <!DOCTYPE html>
    <html lang="zh-CN">
    <head>
      <meta charset="UTF-8">
      <meta name="viewport" content="width=device-width, initial-scale=1.0">
      <title>HF Multi-Key Proxy Gateway</title>
      <style>
        :root {
          --bg-color: #0b0f19;
          --container-bg: #161f30;
          --primary-color: #6366f1;
          --accent-color: #10b981;
          --text-color: #f3f4f6;
          --text-muted: #9ca3af;
          --border-color: #2e3c54;
        }
        body {
          font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, "Helvetica Neue", Arial, sans-serif;
          background-color: var(--bg-color);
          color: var(--text-color);
          margin: 0;
          padding: 2rem 1rem;
          display: flex;
          justify-content: center;
        }
        .container {
          max-width: 650px;
          width: 100%;
          background-color: var(--container-bg);
          border: 1px solid var(--border-color);
          border-radius: 12px;
          padding: 2.5rem;
          box-shadow: 0 10px 25px -5px rgba(0, 0, 0, 0.3);
        }
        h1 {
          font-size: 1.75rem;
          margin-top: 0;
          margin-bottom: 0.5rem;
          background: linear-gradient(135deg, #6366f1, #a855f7);
          -webkit-background-clip: text;
          -webkit-text-fill-color: transparent;
        }
        p {
          color: var(--text-muted);
          font-size: 0.95rem;
          margin-bottom: 2rem;
        }
        .stats-grid {
          display: grid;
          grid-template-columns: repeat(2, 1fr);
          gap: 1rem;
          margin-bottom: 2rem;
        }
        .stat-card {
          border: 1px solid var(--border-color);
          border-radius: 8px;
          padding: 1.2rem;
          background-color: rgba(255, 255, 255, 0.02);
        }
        .stat-card .label {
          font-size: 0.8rem;
          color: var(--text-muted);
          text-transform: uppercase;
          margin-bottom: 0.4rem;
        }
        .stat-card .value {
          font-size: 1.4rem;
          font-weight: 700;
        }
        .stat-card .value.active { color: var(--accent-color); }
        .stat-card .value.indigo { color: var(--primary-color); }
        .details-section {
          border-top: 1px solid var(--border-color);
          padding-top: 1.5rem;
          margin-top: 1.5rem;
        }
        .details-section h3 {
          margin-top: 0;
          margin-bottom: 0.8rem;
          font-size: 1.1rem;
        }
        code {
          background-color: rgba(0,0,0,0.3);
          padding: 0.2rem 0.4rem;
          border-radius: 4px;
          font-family: monospace;
          color: #e06c75;
          font-size: 0.9rem;
        }
        .method-block {
          background-color: rgba(0,0,0,0.2);
          border: 1px solid var(--border-color);
          border-radius: 6px;
          padding: 1rem;
          font-family: monospace;
          white-space: pre-wrap;
          font-size: 0.85rem;
          color: #abb2bf;
        }
      </style>
    </head>
    <body>
      <div class="container">
        <h1>🚀 HF Multi-Key Proxy Gateway</h1>
        <p>基于 HuggingFace IP 的 Google Gemini & NVIDIA NIM 极简中转网关。运行中且连接正常。</p>
        
        <div class="stats-grid">
          <div class="stat-card">
            <div class="label">Google Keys 池子</div>
            <div class="value active">${GOOGLE_KEYS.length} 个可用</div>
          </div>
          <div class="stat-card">
            <div class="label">Nvidia Keys 池子</div>
            <div class="value active">${NVIDIA_KEYS.length} 个可用</div>
          </div>
          <div class="stat-card">
            <div class="label">接收请求数</div>
            <div class="value indigo">${stats.totalRequests} 次</div>
          </div>
          <div class="stat-card">
            <div class="label">故障自动轮换</div>
            <div class="value" style="color: #f59e0b;">${stats.failovers} 次</div>
          </div>
        </div>

        <div class="details-section">
          <h3>⏱️ 服务状态</h3>
          <div style="font-size: 0.9rem; color: var(--text-muted);">
            运行时间: <code>${Math.floor(uptime / 3600)}h ${Math.floor((uptime % 3600) / 60)}m ${uptime % 60}s</code> <br>
            鉴权验证: <code>${ACCESS_TOKEN ? '已启用 (Bearer TOKEN)' : '未启用 (开放网关)'}</code>
          </div>
        </div>

        <div class="details-section">
          <h3>📡 客户端配置接入</h3>
          <div style="font-size: 0.9rem; line-height: 1.6;">
            在 LobeChat, Cursor, NextChat 等客户端中修改配置：<br>
            • <b>接口地址 (Base URL)</b>: <code>https://${req.headers.host || 'your-space-domain.hf.space'}/v1</code> <br>
            • <b>API Key</b>: <code>${ACCESS_TOKEN ? '已启用 (请填写您在 HF Secrets 中设置的 ACCESS_TOKEN)' : '未启用 (可随意填写)'}</code>
          </div>
        </div>
      </div>
    </body>
    </html>
    `;
    res.end(html);
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

    // Auth validation
    if (ACCESS_TOKEN) {
      const authHeader = req.headers['authorization'] || '';
      const token = authHeader.replace(/^Bearer\s+/i, '').trim();
      if (token !== ACCESS_TOKEN) {
        res.writeHead(401, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: { message: 'Unauthorized: Invalid access token.', type: 'invalid_request_error' } }));
        return;
      }
    }

    // Buffer Request Body
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

      const model = bodyObj.model || '';
      const provider = selectProvider(model);

      if (!provider) {
        res.writeHead(400, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: { message: `Model '${model}' is not supported or no keys are configured.`, type: 'invalid_request_error' } }));
        return;
      }

      // Update counters
      if (provider.name === 'google') stats.googleRequests++;
      else if (provider.name === 'nvidia') stats.nvidiaRequests++;
      else if (provider.name === 'opencode') stats.customRequests++;
      else if (provider.name === 'custom') stats.customRequests++;

      const isStream = bodyObj.stream === true;
      forwardRequest(req, res, provider, bodyData, 1, isStream, model);
    });
    return;
  }

  // 4. Page Not Found fallback
  res.writeHead(404, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify({ error: { message: `Path ${parsedUrl.pathname} not found.` } }));
});

// Server boot
server.listen(PORT, '0.0.0.0', () => {
  console.log(`[Proxy] Gateway server launched on port ${PORT}`);
  console.log(`[Proxy] Configured Keys - Google: ${GOOGLE_KEYS.length} | Nvidia: ${NVIDIA_KEYS.length} | Custom: ${CUSTOM_KEYS.length}`);
});
