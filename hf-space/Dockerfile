# syntax=docker/dockerfile:1.7
# =============================================================================
# FreeLLMAPI — HuggingFace Space Dockerfile (auto‑clone version)
# =============================================================================

# ---- Build arguments -------------------------------------------------------
ARG NODE_IMAGE=node:20-bookworm-slim
ARG FREELLMAPI_REPO=https://github.com/tashfeenahmed/freellmapi.git
ARG FREELLMAPI_BRANCH=main

# ---- Stage 1: Clone source & install dependencies ---------------------------
FROM ${NODE_IMAGE} AS builder
ARG FREELLMAPI_REPO
ARG FREELLMAPI_BRANCH
WORKDIR /app

# Install system tools needed for the build
RUN apt-get update && \
    apt-get install -y --no-install-recommends python3 make g++ git ca-certificates && \
    rm -rf /var/lib/apt/lists/*

# Clone the upstream repository (shallow clone to keep image small)
RUN git clone --depth 1 --branch ${FREELLMAPI_BRANCH} ${FREELLMAPI_REPO} .

# Apply the same lightweight runtime patches we used before (disable logs, quota & catalog sync)
RUN python3 - <<'PY'
import pathlib, re, sys

def patch_file(path, old, new):
    p = pathlib.Path(path)
    content = p.read_text()
    p.write_text(content.replace(old, new, 1))

# request‑log.ts – disable request logging
patch_file('server/src/lib/request-log.ts',
    'export function logRequest(',
    'export function logRequest(...args: any[]) { return; }\nfunction _unused_logRequest(')

# provider‑quota.ts – short‑circuit quota observation
patch_file('server/src/services/provider-quota.ts',
    'export function recordQuotaObservation(input: QuotaObservationInput): ProviderQuotaObservation | null {',
    'export function recordQuotaObservation(input: QuotaObservationInput): ProviderQuotaObservation | null { return null; }\nfunction _unused_recordQuotaObservation(input: QuotaObservationInput) {')

# catalog‑sync.ts – prevent upstream catalog overwriting custom models
patch_file('server/src/services/catalog-sync.ts',
    'export async function syncCatalog(force = false): Promise<SyncResult> {',
    'export async function syncCatalog(force = false): Promise<SyncResult> { return { ok: true, action: "up_to_date" }; }\nasync function _unused_syncCatalog(force = false) {')

# db/index.ts – inject custom models automatically during DB init (safer than entrypoint.sh sqlite3)
db_path = 'server/src/db/index.ts'
db_content = pathlib.Path(db_path).read_text()
injection_code = """
function injectCustomModels(db: any): void {
  try {
    const insertModel = db.prepare("INSERT OR IGNORE INTO models (platform, model_id, display_name, intelligence_rank, speed_rank, size_label, enabled, supports_vision, supports_tools, context_window) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)");
    insertModel.run('google', 'gemini-3.5-flash', 'Gemini 3.5 Flash (Custom)', 85, 80, 'Large', 1, 1, 1, 1048576);
    insertModel.run('google', 'gemini-3.5-flash-lite', 'Gemini 3.5 Flash-Lite (Custom)', 75, 90, 'Medium', 1, 1, 1, 1048576);
    insertModel.run('nvidia', 'nvidia/glm-5.2', 'GLM 5.2 (NVIDIA Custom)', 80, 75, 'Large', 1, 0, 1, 128000);

    db.prepare("INSERT OR IGNORE INTO fallback_config (model_db_id, priority, enabled) SELECT id, (SELECT COALESCE(MAX(priority), 0) FROM fallback_config) + ROW_NUMBER() OVER (ORDER BY id), 1 FROM models WHERE id NOT IN (SELECT model_db_id FROM fallback_config)").run();

    db.prepare("INSERT OR IGNORE INTO profile_models (profile_id, model_db_id, priority, enabled) SELECT p.id, m.id, (SELECT COALESCE(MAX(priority), 0) FROM profile_models WHERE profile_id = p.id) + ROW_NUMBER() OVER (PARTITION BY p.id ORDER BY m.id), 1 FROM profiles p CROSS JOIN models m WHERE m.id NOT IN (SELECT model_db_id FROM profile_models WHERE profile_id = p.id)").run();
    console.log('[Custom-Inject] Models successfully registered in fallback chains.');
  } catch (err) {
    console.error('[Custom-Inject] Failed to inject custom models:', err);
  }
}
"""
db_content = db_content.replace(
    'if (!isEncryptionKeyInitialized()) initEncryptionKey(db);',
    'if (!isEncryptionKeyInitialized()) initEncryptionKey(db); try { injectCustomModels(db); } catch(e){}'
) + injection_code
pathlib.Path(db_path).write_text(db_content)
PY

# Configure npm retries and mirror to avoid ETIMEDOUT on network issues
RUN npm config set registry https://registry.npmmirror.com \
    && npm config set fetch-retries 10 \
    && npm config set fetch-retry-mintimeout 20000 \
    && npm config set fetch-retry-maxtimeout 120000 \
    && npm ci \
    && npm run build \
    && npm prune --omit=dev

# ---- Stage 2: Runtime image ------------------------------------------------
FROM ${NODE_IMAGE} AS runtime
WORKDIR /app

# Install only the runtime binary we need (sqlite3 for DB handling)
RUN apt-get update && \
    apt-get install -y --no-install-recommends sqlite3 && \
    rm -rf /var/lib/apt/lists/*

# Copy built artifacts from the builder stage
COPY --from=builder /app/node_modules ./node_modules
COPY --from=builder /app/server/dist ./server/dist
COPY --from=builder /app/server/package.json ./server/
COPY --from=builder /app/client/dist ./client/dist
COPY --from=builder /app/shared ./shared
COPY --from=builder /app/package.json ./

# Copy the entrypoint script we ship in this repository
COPY entrypoint.sh /entrypoint.sh
RUN chmod +x /entrypoint.sh

# Expose the port expected by the HF Space UI
ENV PORT=7860
ENV HOST=0.0.0.0
EXPOSE 7860

# Ensure a persistent location for the SQLite DB (mounted by HF /data)
RUN mkdir -p /app/data

ENTRYPOINT ["/entrypoint.sh"]
