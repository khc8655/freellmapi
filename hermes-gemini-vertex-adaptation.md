# Hermes Agent 对 Google Gemini 模型的适配方案

> 涵盖 Google AI Studio (Gemini 原生 API) 与 Google Cloud Vertex AI (OpenAI 兼容端点) 两条路径
> 分析版本基于 Hermes Agent 源码（2026-07）

---

## 目录

- [1. 架构总览](#1-架构总览)
- [2. 双路径对比](#2-双路径对比)
- [3. Google AI Studio 原生 API 适配](#3-google-ai-studio-原生-api-适配)
  - [3.1 路径检测与激活](#31-路径检测与激活)
  - [3.2 思考等级（Thinking Level）处理](#32-思考等级thinking-level处理)
  - [3.3 流式输出处理](#33-流式输出处理)
  - [3.4 工具调用处理](#34-工具调用处理)
  - [3.5 消息角色与内容翻译](#35-消息角色与内容翻译)
  - [3.6 其他关键处理](#36-其他关键处理)
- [4. Vertex AI OpenAI 兼容端点适配](#4-vertex-ai-openai-兼容端点适配)
  - [4.1 架构定位](#41-架构定位)
  - [4.2 端点构建](#42-端点构建)
  - [4.3 ProviderProfile 注册](#43-providerprofile-注册)
  - [4.4 思考等级处理](#44-思考等级处理)
  - [4.5 流式输出与工具调用](#45-流式输出与工具调用)
  - [4.6 模型 ID 处理](#46-模型-id-处理)
  - [4.7 运行时 Token 刷新流程](#47-运行时-token-刷新流程)
  - [4.8 计费路由](#48-计费路由)
- [5. 完整对比矩阵](#5-完整对比矩阵)
- [6. 关键源码索引](#6-关键源码索引)

---

## 1. 架构总览

Hermes Agent 对 Google Gemini 模型采用 **双路径适配架构**，取决于 base_url 的形态：

```
用户选择 Gemini 模型
         │
         ├─ base_url 含 generativelanguage.googleapis.com 且不以 /openai 结尾
         │   → 激活「原生 Gemini REST API」路径
         │   → agent/gemini_native_adapter.py
         │   → 全量 OpenAI ↔ Gemini 协议翻译
         │
         ├─ base_url 含 generativelanguage.googleapis.com 且以 /openai 结尾
         │   → 激活「AI Studio OpenAI 兼容」路径
         │   → 标准 chat_completions 传输层 + extra_body.google.thinking_config
         │
         └─ base_url 含 aiplatform.googleapis.com (Vertex AI)
             → 激活「Vertex OpenAI 兼容」路径
             → 标准 chat_completions 传输层 + extra_body.google.thinking_config
             → agent/vertex_adapter.py 提供端点构建与 token 管理
```

---

## 2. 双路径对比

| 维度 | AI Studio 原生 API | AI Studio OpenAI-compat | Vertex AI OpenAI-compat |
|------|-------------------|------------------------|------------------------|
| **传输层** | GeminiNativeClient (自研 httpx) | 标准 OpenAI SDK | 标准 OpenAI SDK |
| **协议** | Gemini generateContent | OpenAI chat/completions | OpenAI chat/completions |
| **消息翻译** | 全量双向翻译 | 无 (已是 OpenAI 格式) | 无 (已是 OpenAI 格式) |
| **思考配置注入** | generationConfig.thinkingConfig (camelCase) | extra_body.google.thinking_config (snake_case) | extra_body.google.thinking_config (snake_case) |
| **流式** | 自研 SSE 解析 + 增量去重 | OpenAI SDK 原生流式 | OpenAI SDK 原生流式 |
| **工具调用** | 双向翻译 + schema 裁剪 | 标准 OpenAI 格式 | 标准 OpenAI 格式 |
| **thoughtSignature** | 手动提取/回放到 part | 通过 extra_content 保留/回放 | 通过 extra_content 保留/回放 |
| **模型发现** | 可探测 /models | 可探测 /models | 不可探测，用 curated 列表 |
| **认证** | 静态 API key (GOOGLE_API_KEY) | 静态 API key | OAuth2 短期 token |

---

## 3. Google AI Studio 原生 API 适配

### 3.1 路径检测与激活

**文件**: `agent/gemini_native_adapter.py`

```python
def is_native_gemini_base_url(base_url: str) -> bool:
    """True 当 URL 含 generativelanguage.googleapis.com 且不以 /openai 结尾"""
    normalized = str(base_url or "").strip().rstrip("/").lower()
    if "generativelanguage.googleapis.com" not in normalized:
        return False
    return not normalized.endswith("/openai")
```

当检测到原生端点时，Hermes 使用自研的 `GeminiNativeClient` 替代标准 OpenAI 客户端，直接调用：

- 非流式：`POST /v1beta/models/{model}:generateContent`
- 流式：`POST /v1beta/models/{model}:streamGenerateContent?alt=sse`

**设计动机**（源码注释行 9-14）：

> Google's OpenAI-compatible endpoint has been brittle for Hermes's multi-turn agent/tool loop (auth churn, tool-call replay quirks, thought-signature requirements). The native Gemini API is the canonical path and avoids the OpenAI-compat layer entirely.

---

### 3.2 思考等级（Thinking Level）处理

#### 3.2.1 统一入口函数

**文件**: `agent/transports/chat_completions.py`，`_build_gemini_thinking_config()`（行 21-74）

Hermes 内部使用统一的 7 级 effort 体系：`none, minimal, low, medium, high, xhigh`。

```python
def _build_gemini_thinking_config(model: str, reasoning_config: dict | None) -> dict | None:
    # 非 Gemini 模型（Gemma 等）→ 返回 None（避免 HTTP 400）
    if not normalized_model.startswith("gemini"):
        return None

    # reasoning enabled: False → includeThoughts: False
    if reasoning_config.get("enabled") is False:
        return {"includeThoughts": False}
    if effort == "none":
        return {"includeThoughts": False}

    # includeThoughts: True 为基线
    thinking_config = {"includeThoughts": True}

    # Gemini 2.5: 只设 includeThoughts，不设 thinkingLevel
    if normalized_model.startswith("gemini-2.5-"):
        return thinking_config

    # Gemini 3 / 3.1: 支持 thinkingLevel
    if normalized_model.startswith(("gemini-3", "gemini-3.1")):
        if "flash" in normalized_model:
            # Flash: low / medium / high
            ...
        elif "pro" in normalized_model:
            # Pro: low / high (仅二级)
            ...
    return thinking_config
```

#### 3.2.2 effort → thinkingLevel 映射表

| Hermes effort | Gemini Flash thinkingLevel | Gemini Pro thinkingLevel | Gemini 2.5 |
|--------------|--------------------------|------------------------|-------------|
| `none` | includeThoughts: False | includeThoughts: False | includeThoughts: False |
| `minimal` | low | low | includeThoughts: True |
| `low` | low | low | includeThoughts: True |
| `medium` | medium | low | includeThoughts: True |
| `high` | high | high | includeThoughts: True |
| `xhigh` | high | high | includeThoughts: True |

#### 3.2.3 Gemini 3.5 Flash 覆盖

`gemini-3.5-flash` 匹配 `_build_gemini_thinking_config()` 中的 `gemini-3` 前缀判断，走 Flash 分支，支持 low/medium/high 三级。模型 ID 在 `hermes_cli/models.py` 第 60 行的 curated 列表中注册。

#### 3.2.4 格式转换

- **原生 API 路径**：`_normalize_thinking_config()` 将 snake_case 转 Gemini camelCase
  - `thinking_budget` → `thinkingBudget`
  - `include_thoughts` → `includeThoughts`
  - `thinking_level` → `thinkingLevel`
  - 最终注入 `generationConfig.thinkingConfig`

- **OpenAI-compat 路径 (含 /openai 端点)**：`_snake_case_gemini_thinking_config()` 转 snake_case
  - 注入 `extra_body.google.thinking_config`

#### 3.2.5 关键设计决策

1. **enabled: False** 时不直接关闭思考，而是设 `includeThoughts: False`（Gemini 内部仍可能思考但不返回思考内容）
2. **Gemini 2.5** 不猜测 thinkingBudget（避免模型验证错误），只设 includeThoughts
3. **非 Gemini 模型** 完全跳过 thinkingConfig（Gemma 等模型会因未知字段返回 400）

---

### 3.3 流式输出处理

#### 3.3.1 流式 API 调用

`GeminiNativeClient._stream_completion()` 调用：

```
POST {base_url}/models/{model}:streamGenerateContent?alt=sse
Accept: text/event-stream
```

#### 3.3.2 SSE 事件解析

`_iter_sse_events()` 逐行解析 SSE 流：

```python
def _iter_sse_events(response):
    buffer = ""
    for chunk in response.iter_text():
        buffer += chunk
        while "\n" in buffer:
            line, buffer = buffer.split("\n", 1)
            line = line.rstrip("\r")
            if not line.startswith("data: "):
                continue
            data = line[6:]
            if data == "[DONE]":
                return
            payload = json.loads(data)
            yield payload
```

#### 3.3.3 流式事件翻译

`translate_stream_event()` 将每个 Gemini SSE event 翻译为 OpenAI 格式的 chunk：

| Gemini Part 类型 | 输出 chunk 字段 |
|-----------------|----------------|
| `thought: true` + text | `reasoning` / `reasoning_content`（思考内容流式输出） |
| text（非 thought） | `content`（正文流式输出） |
| `functionCall` | `tool_calls`（工具调用增量） |
| `finishReason` | 带 finish_reason 的终止 chunk + usage |

#### 3.3.4 工具调用流式增量处理（去重切片）

Gemini 原生 API 在每个 SSE 事件中返回 **完整的 functionCall 参数**，Hermes 做了增量切片处理（行 704-711）：

```python
emitted_arguments = args_str
last_arguments = str(slot.get("last_arguments") or "")
if last_arguments:
    if args_str == last_arguments:
        emitted_arguments = ""                    # 重复，不发
    elif args_str.startswith(last_arguments):
        emitted_arguments = args_str[len(last_arguments):]  # 增量部分
slot["last_arguments"] = args_str
```

#### 3.3.5 Token 用量

Gemini 在流式终止事件中携带 `usageMetadata`，Hermes 在 finish chunk 上附加 `usage` 对象：

```python
usage = SimpleNamespace(
    prompt_tokens=int(usage_meta.get("promptTokenCount") or 0),
    completion_tokens=int(usage_meta.get("candidatesTokenCount") or 0),
    total_tokens=int(usage_meta.get("totalTokenCount") or 0),
    prompt_tokens_details=SimpleNamespace(
        cached_tokens=int(usage_meta.get("cachedContentTokenCount") or 0),
    ),
)
```

---

### 3.4 工具调用处理

#### 3.4.1 出站：OpenAI → Gemini

**tools 翻译** (`_translate_tools_to_gemini()`)：

```python
# OpenAI tools[] → Gemini functionDeclarations
[{"functionDeclarations": [{"name": ..., "description": ..., "parameters": ...}]}]
```

通过 `sanitize_gemini_tool_parameters()` 过滤掉 Gemini 不支持的 JSON Schema 字段：

- 保留字段白名单：`type, format, title, description, nullable, enum, maxItems, minItems, properties, required, ...`
- 移除字段：`$schema, additionalProperties` 等
- 非 string 类型的 enum 被移除（Gemini 要求 enum 全为 string）

**tool_choice 翻译** (`_translate_tool_choice_to_gemini()`)：

| OpenAI tool_choice | Gemini toolConfig |
|-------------------|------------------|
| `"auto"` | `functionCallingConfig.mode: AUTO` |
| `"required"` | `functionCallingConfig.mode: ANY` |
| `"none"` | `functionCallingConfig.mode: NONE` |
| `{function: {name: X}}` | `mode: ANY` + `allowedFunctionNames: [X]` |

#### 3.4.2 入站：Gemini → OpenAI

`translate_gemini_response()` 和 `translate_stream_event()` 将 Gemini 的 `functionCall` parts 翻译回 OpenAI 格式的 `tool_calls`，每个调用带 UUID 生成的 call ID。

#### 3.4.3 Thought Signature 回放

Gemini 3 系列思考模型在工具调用上附加 `thoughtSignature`，是防止上下文丢失的关键机制。

**处理流程**：

1. **提取**：从 Gemini 响应 part 中提取 `thoughtSignature`，存入 `extra_content.google.thought_signature`
2. **保留判断**：`_model_consumes_thought_signature()` 检查目标模型是否为 Gemini 家族
   ```python
   def _model_consumes_thought_signature(model) -> bool:
       m = str(model or "").lower()
       return "gemini" in m or "gemma" in m
   ```
3. **剥离**：切换到非 Gemini 模型时，自动剥离 extra_content
   - 否则 Fireworks/Mistral 等严格提供商返回 400: `Extra inputs are not permitted, field: 'messages[N].tool_calls[M].extra_content'`
4. **回放**：在 `_translate_tool_call_to_gemini()` 中将 thoughtSignature 重新附加到 functionCall part

```python
# 提取 (响应 → 消息存储)
sig = part.get("thoughtSignature")
extra_content = {"google": {"thought_signature": sig}}

# 回放 (消息存储 → 下次请求)
thought_signature = _tool_call_extra_signature(tool_call)
if thought_signature:
    part["thoughtSignature"] = thought_signature
```

---

### 3.5 消息角色与内容翻译

#### 3.5.1 角色映射

`_build_gemini_contents()` 中处理 OpenAI → Gemini 的角色转换：

| OpenAI role | Gemini role | 备注 |
|-------------|------------|------|
| `system` | 提取为 `systemInstruction` | 不进入 contents |
| `user` | `user` | 直接映射 |
| `assistant` | `model` | 角色名不同 |
| `tool` / `function` | `user` + `functionResponse` | 工具结果转为 user 角色的 functionResponse part |

#### 3.5.2 角色交替合并

Gemini 原生 API 要求严格的 user/model 交替。Hermes 做了相邻同角色合并（行 348-355）：

```python
merged_contents = []
for content in contents:
    if merged_contents and merged_contents[-1]["role"] == content["role"]:
        merged_contents[-1]["parts"].extend(content["parts"])
    else:
        merged_contents.append(content)
```

解决以下场景：
- **并行工具调用**：N 个 tool 结果变成 N 个 user functionResponse contents → 合并为 1 个
- **连续 user 消息**：合并 parts
- **合并的 assistant 消息**：合并 parts

#### 3.5.3 多模态内容翻译

`_extract_multimodal_parts()` 将 OpenAI 的 `image_url` base64 data URL 转为 Gemini 的 `inlineData`：

```python
# OpenAI: {"type": "image_url", "image_url": {"url": "data:image/png;base64,..."}}
# Gemini: {"inlineData": {"mimeType": "image/png", "data": "<base64>"}}
```

---

### 3.6 其他关键处理

#### 3.6.1 maxOutputTokens 默认值

```python
GEMINI_DEFAULT_MAX_OUTPUT_TOKENS = 65535
```

Gemini 原生 API 在省略 maxOutputTokens 时使用低内部默认值导致输出被截断（finishReason=MAX_TOKENS），Hermes 设默认值 65535（所有当前 Gemini 2.5/3.x 模型的最大输出上限）。OpenAI-compat 端点不存在此问题。

#### 3.6.2 上下文长度

`model_metadata.py` 中 Gemini 模型的上下文默认为 1,048,576（1M tokens）。

#### 3.6.3 免费层探测

`probe_gemini_tier()` 通过检查 `x-ratelimit-limit-requests-per-day` header 判断免费层（<=1000 RPD），并在免费层 quota 耗尽时输出引导文案告知用户需启用计费。

#### 3.6.4 思考超时引导

`thinking_timeout_guidance.py` 针对推理模型的传输层断连（思考阶段超时），提供专门的诊断信息：

```
1. Set providers.<provider>.models.<model>.stale_timeout_seconds: 900
2. Lower reasoning_budget or set reasoning_effort: medium
3. Use a smaller / faster reasoning model
```

#### 3.6.5 Native API extra_body 过滤

原生 Gemini 端点不接受 OpenAI 格式的 extra_body 字段（tags, reasoning, provider 等）。`_build_kwargs_from_profile()` 中（行 614-633）做了过滤，只保留 `thinking_config` / `thinkingConfig`：

```python
if _native_gemini:
    extra_body = {
        k: v for k, v in extra_body.items()
        if k in ("thinking_config", "thinkingConfig")
    }
```

---

## 4. Vertex AI OpenAI 兼容端点适配

### 4.1 架构定位

**文件**: `plugins/model-providers/vertex/__init__.py`

Vertex AI 在 Hermes 中使用 Google Cloud 的 OpenAI 兼容端点，**无需独立协议适配器**。核心设计决策是：Vertex 已暴露 OpenAI 兼容接口，Hermes 只需走标准 chat_completions 传输层，唯一需要特殊处理的是思考配置注入和 OAuth2 token 管理。

| 处理层面 | 逻辑 |
|---------|------|
| 传输层 | 标准 OpenAI SDK 客户端 |
| 消息格式 | 标准 OpenAI messages[] |
| 工具格式 | 标准 OpenAI tools[] |
| 流式格式 | 标准 OpenAI SSE |
| 思考配置 | extra_body.google.thinking_config (snake_case) |
| 端点构建 | agent/vertex_adapter.py (project_id + region) |
| Token 管理 | OAuth2 短期 token，5 分钟刷新窗口 |

### 4.2 端点构建

**文件**: `agent/vertex_adapter.py`，`build_vertex_base_url()`（行 190-199）

```python
def build_vertex_base_url(project_id: str, region: str = "global") -> str:
    host = "aiplatform.googleapis.com" if region == "global" \
           else f"{region}-aiplatform.googleapis.com"
    return f"https://{host}/v1beta1/projects/{project_id}/locations/{region}/endpoints/openapi"
```

**端点 URL 结构**：

```
https://{host}/v1beta1/projects/{project_id}/locations/{region}/endpoints/openapi
```

- **region = "global"**（默认推荐）：`aiplatform.googleapis.com` — Gemini 3.x preview 模型仅在此端点可用
- **region = 其他** (如 us-central1)：`{region}-aiplatform.googleapis.com`

此 URL 被设为标准 OpenAI 客户端的 `base_url`，OpenAI SDK 自动在此基础上拼接 `/chat/completions`。

**Region 优先级**：显式参数 > `VERTEX_REGION` 环境变量 > `config.yaml` 的 `vertex.region` > 默认 `"global"`

### 4.3 ProviderProfile 注册

**文件**: `plugins/model-providers/vertex/__init__.py`

```python
vertex = VertexProfile(
    name="vertex",
    aliases=("google-vertex", "vertex-ai", "gcp-vertex"),
    api_mode="chat_completions",
    env_vars=(),                          # OAuth2 — 无静态 API key 环境变量
    base_url="https://aiplatform.googleapis.com",  # 运行时被替换
    auth_type="vertex",                   # 标记为 OAuth token provider
    default_aux_model="google/gemini-3-flash-preview",
)
```

关键属性：

| 属性 | 值 | 说明 |
|-----|---|------|
| `name` | `"vertex"` | Provider 标识符 |
| `aliases` | `("google-vertex", "vertex-ai", "gcp-vertex")` | 别名，`hermes model` 选择器识别 |
| `api_mode` | `"chat_completions"` | 走标准 OpenAI 传输层 |
| `auth_type` | `"vertex"` | 避免被凭据池当静态 key 处理 |
| `env_vars` | `()` | 无静态 API key 环境变量 |
| `fetch_models()` | 返回 `None` | Vertex OpenAI-compat 端点无 `/models` 列出路由 |

**curated 模型列表**（`hermes_cli/setup.py`）：

```python
"vertex": [
    "google/gemini-3.1-pro-preview",
    "google/gemini-3-pro-preview",
    "google/gemini-3-flash-preview",
    "google/gemini-3.1-flash-lite-preview",
],
```

### 4.4 思考等级处理

#### 4.4.1 注入路径

`VertexProfile.build_extra_body()` 中：

```python
def build_extra_body(self, *, session_id=None, **context):
    from agent.transports.chat_completions import (
        _build_gemini_thinking_config,
        _snake_case_gemini_thinking_config,
    )

    model = context.get("model") or ""
    reasoning_config = context.get("reasoning_config")

    raw_thinking_config = _build_gemini_thinking_config(model, reasoning_config)
    if not raw_thinking_config:
        return {}

    thinking_config = _snake_case_gemini_thinking_config(raw_thinking_config)
    if not thinking_config:
        return {}

    return {"extra_body": {"google": {"thinking_config": thinking_config}}}
```

#### 4.4.2 与 AI Studio 的关系

思考等级处理 **完全复用** AI Studio 的 `_build_gemini_thinking_config()` 函数，effort → thinkingLevel 的映射逻辑与 [3.2.2](#322-effort--thinkinglevel-映射表) 完全一致。

#### 4.4.3 与 AI Studio 原生路径的格式差异

| 处理点 | AI Studio 原生 | Vertex |
|-------|---------------|--------|
| 字段格式 | camelCase (`includeThoughts`, `thinkingLevel`) | snake_case (`include_thoughts`, `thinking_level`) |
| 注入位置 | `generationConfig.thinkingConfig` | `extra_body.google.thinking_config` |
| 过滤逻辑 | 原生适配器过滤 extra_body 只保留 thinking_config | 无需过滤（Vertex profile 不产生其他 extra_body） |

### 4.5 流式输出与工具调用

Vertex AI 走标准 OpenAI chat_completions 传输层，流式输出和工具调用处理 **与任何其他 OpenAI 兼容 provider 完全一致**：

**流式输出**：
- OpenAI 客户端原生的 `stream=True` 机制
- 标准 SSE `data: {chunk}` 格式
- 标准 delta/content/tool_calls 增量结构
- 无需 SSE 解析适配（不像 AI Studio 原生路径需要 `_iter_sse_events()` + `translate_stream_event()`）
- 思考内容通过 `reasoning_content` / `reasoning` 标准字段返回

**工具调用**：

| 处理点 | 逻辑 |
|-------|------|
| tools schema | 标准 OpenAI JSON Schema 格式，不经过 Gemini schema 裁剪 |
| tool_choice | 标准 OpenAI 格式 (auto / required / none / 函数指定) |
| 请求 tool_calls | 标准 OpenAI message.tool_calls 数组 |
| 响应 tool_calls | 标准 OpenAI choice.message.tool_calls |
| thoughtSignature | 通过 `_model_consumes_thought_signature()` 判断保留 extra_content |

`_model_consumes_thought_signature()` 对 Vertex 上 `google/gemini-3.x-xxx` 模型 ID 返回 True（因包含 "gemini"），所以 extra_content 被保留并正确回放。

### 4.6 模型 ID 处理

Vertex 的 OpenAI-compat 端点保留点号（`.`）在模型 ID 中（如 `google/gemini-3.5-flash`），而某些 provider 会要求连字符形式。

Hermes 在 `run_agent.py` 中显式将 `"vertex"` 纳入了保留点号的 allowlist：

```python
if (getattr(self, "provider", "") or "").lower() in {
    "alibaba", "minimax", "minimax-cn",
    "opencode-go", "opencode-zen",
    "zai", "bedrock",
    "xiaomi", "vertex",
}:
    return True
# 或检测 base_url 含 "aiplatform.googleapis.com"
```

### 4.7 运行时 Token 刷新流程

虽然不涉及认证机制本身，token 刷新对理解 Vertex 适配很重要：

```
启动
  │
  ├─ runtime_provider.py 调用 get_vertex_config()
  │   → 获取 (token, base_url) 对
  │   → token 作为 api_key 传给标准 OpenAI 客户端
  │
  ├─ 运行中 (长会话场景)
  │   │
  │   ├─ Vertex token 过期 (~1 小时)
  │   │   → API 返回 401
  │   │
  │   ├─ conversation_loop.py 检测到 provider=="vertex" + status_code==401
  │   │   → 检查 vertex_auth_retry_attempted 标记 (每轮只刷一次)
  │   │   → 调用 _try_refresh_vertex_client_credentials()
  │   │
  │   ├─ _try_refresh_vertex_client_credentials()
  │   │   → 重新调用 get_vertex_config()
  │   │   → 更新 self.api_key + self.base_url
  │   │   → _replace_primary_openai_client() 重建 OpenAI 客户端
  │   │   → 重试请求
  │   │
  │   └─ 成功 → 提示 "🔐 Vertex AI token refreshed after 401. Retrying..."
  │
  └─ get_vertex_config() 内部
      → 凭据缓存 (按 credentials path key)
      → 5 分钟刷新窗口 (expiry - now < 300s 时刷新)
      → ADC 失败时自动回退到 service account 文件
```

### 4.8 计费路由

**文件**: `agent/usage_pricing.py`（行 670-674）

```python
# Vertex AI hosts the same Gemini models as Google AI Studio; price them
# off the gemini official-docs snapshot. Strip the "google/" vendor prefix
if provider_name == "vertex" or base_url_host_matches(base_url or "", "aiplatform.googleapis.com"):
    return BillingRoute(
        provider="gemini",
        model=model.split("/")[-1],
        base_url=base_url or "",
        billing_mode="official_docs_snapshot",
    )
```

Vertex 托管同一批 Gemini 模型，价格按 Google 官方文档快照计算，仅去除 `google/` 前缀。

---

## 5. 完整对比矩阵

| 维度 | AI Studio 原生 API | AI Studio OpenAI-compat | Vertex AI OpenAI-compat |
|------|-------------------|------------------------|------------------------|
| **传输层** | GeminiNativeClient (自研 httpx) | 标准 OpenAI SDK | 标准 OpenAI SDK |
| **api_mode** | chat_completions (但实际走原生) | chat_completions | chat_completions |
| **消息翻译** | OpenAI→Gemini 全量双向翻译 | 无 | 无 |
| **角色交替合并** | 需要 (Gemini 严格 user/model 交替) | 不需要 | 不需要 |
| **system 消息** | 提取为 systemInstruction | 作为 messages[0] | 作为 messages[0] |
| **多模态** | base64→inlineData 翻译 | 标准 image_url 格式 | 标准 image_url 格式 |
| **思考配置格式** | camelCase | snake_case | snake_case |
| **思考配置位置** | generationConfig.thinkingConfig | extra_body.google.thinking_config | extra_body.google.thinking_config |
| **思考等级复用** | `_build_gemini_thinking_config()` | `_build_gemini_thinking_config()` + `_snake_case_gemini_thinking_config()` | `_build_gemini_thinking_config()` + `_snake_case_gemini_thinking_config()` |
| **流式** | 自研 SSE 解析 + 增量去重 | OpenAI SDK 原生流式 | OpenAI SDK 原生流式 |
| **流式思考内容** | part.thought → reasoning/reasoning_content | reasoning_content / reasoning 字段 | reasoning_content / reasoning 字段 |
| **工具调用格式** | functionDeclarations (Gemini Schema 子集) | 标准 OpenAI tools | 标准 OpenAI tools |
| **tool_choice** | toolConfig.functionCallingConfig.mode | 标准 OpenAI tool_choice | 标准 OpenAI tool_choice |
| **schema 裁剪** | sanitize_gemini_schema() | 无 | 无 |
| **thoughtSignature** | 手动提取/回放到 part | 通过 extra_content 保留/回放 | 通过 extra_content 保留/回放 |
| **maxOutputTokens 默认** | 65535 (避免低内部默认截断) | 由 OpenAI SDK / profile 控制 | 由 OpenAI SDK / profile 控制 |
| **模型发现** | 可探测 /models | 可探测 /models | 不可探测，curated 列表 |
| **免费层探测** | probe_gemini_tier() | probe_gemini_tier() | 无 |
| **认证** | 静态 API key | 静态 API key | OAuth2 短期 token (5 分钟刷新) |
| **Token 刷新** | 无需 (静态 key) | 无需 (静态 key) | 401 触发 _try_refresh_vertex_client_credentials() |
| **计费路由** | gemini (official_docs_snapshot) | gemini (official_docs_snapshot) | gemini (official_docs_snapshot, 去除 google/ 前缀) |
| **模型 ID 点号** | 保留 | 保留 | 保留 (显式 allowlist) |
| **extra_body 过滤** | 原生路径只保留 thinking_config | 无 | 无 |

---

## 6. 关键源码索引

| 文件 | 职责 |
|------|------|
| `agent/gemini_native_adapter.py` | Gemini 原生 REST API 适配器：消息翻译、流式解析、工具调用翻译、GeminiNativeClient |
| `agent/transports/chat_completions.py` | OpenAI 兼容传输层：thinking_config 构建入口、消息清理、tool_call extra_content 管理 |
| `agent/gemini_schema.py` | Gemini JSON Schema 子集裁剪 (sanitize_gemini_schema / sanitize_gemini_tool_parameters) |
| `agent/thinking_timeout_guidance.py` | 推理模型思考超时的传输层断连诊断与用户引导 |
| `agent/model_metadata.py` | Gemini 上下文长度默认值 (1M tokens)、provider 前缀剥离、URL→provider 反推 |
| `agent/vertex_adapter.py` | Vertex AI 端点构建、凭据解析、token 刷新管理 |
| `plugins/model-providers/vertex/__init__.py` | Vertex ProviderProfile 注册、thinking_config 注入 extra_body.google |
| `hermes_cli/runtime_provider.py` | 运行时 provider 解析：Vertex token + base_url 注入 OpenAI 客户端 |
| `hermes_cli/model_setup_flows.py` | Vertex 模型选择向导（project ID / region / curated 列表） |
| `hermes_cli/setup.py` | 模型 curated 列表（gemini / vertex 两个 provider 的模型清单） |
| `agent/usage_pricing.py` | 计费路由：Vertex → gemini 快照 |
| `agent/turn_retry_state.py` | `vertex_auth_retry_attempted` 标记（每轮只刷新一次 Vertex token） |
| `run_agent.py` | `_try_refresh_vertex_client_credentials()`、模型 ID 点号保留 allowlist |

---

*文档生成时间：2026-07-13 | 基于 Hermes Agent 源码分析*
