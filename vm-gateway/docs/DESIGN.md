# VM-Gateway LLM 中转平台设计文档

## 1. 项目概述

### 1.1 背景
将原部署在 Google Cloud Run 上的免费 LLM 中转平台改造为可部署在本地 VM 的版本，简化架构、提升稳定性，并重新设计前端管理界面。

### 1.2 设计原则
- **简单稳定**：后端采用零依赖 Node.js，保持高效可靠
- **效率优先**：最小化请求处理开销，减少不必要的转换逻辑
- **标准兼容**：除 Gemini 需格式转换外，其他供应商走标准 OpenAI 协议
- **易于部署**：支持 Docker 和直接运行两种方式

---

## 2. 系统架构

### 2.1 整体架构

```
┌─────────────────────────────────────────────────────────────────┐
│                        VM Gateway Server                         │
│  ┌──────────────┐    ┌──────────────────────────────────────┐   │
│  │   Frontend   │    │           API Gateway (backend)       │   │
│  │  (HTML/CSS)  │◄──►│  - Auth Middleware                   │   │
│  │   Dashboard  │    │  - Rate Limiter                      │   │
│  └──────────────┘    │  - Request Router                    │   │
│                      │  - Key Rotator                       │   │
│                      └──────────────────────────────────────┘   │
│                                    │                             │
└────────────────────────────────────┼─────────────────────────────┘
                                     │
           ┌─────────────────────────┼─────────────────────────┐
           │                         │                         │
           ▼                         ▼                         ▼
    ┌─────────────┐          ┌─────────────┐          ┌─────────────┐
    │   Google    │          │  Standard   │          │   Custom    │
    │   Gemini    │          │  OpenAI     │          │  Providers  │
    │  (Native)   │          │  (Nvidia)   │          │  (Config)   │
    └─────────────┘          └─────────────┘          └─────────────┘
```

### 2.2 后端模块划分

```
vm-gateway/src/
├── server.js              # 主入口，HTTP 服务器
├── config/
│   └── index.js           # 配置管理（环境变量读取）
├── middleware/
│   ├── auth.js            # 鉴权中间件
│   └── rateLimit.js       # 速率限制（可选）
├── routes/
│   ├── dashboard.js       # 前端页面路由
│   ├── models.js          # /v1/models 路由
│   └── chat.js            # /v1/chat/completions 路由
├── proxy/
│   ├── router.js          # 请求路由逻辑
│   ├── keyRotator.js      # Key 轮换策略
│   ├── retryHandler.js    # 重试逻辑
│   └── transformer.js     # Gemini 格式转换
├── providers/
│   ├── google.js          # Google Gemini 原生处理
│   ├── nvidia.js          # Nvidia NIM (标准 OpenAI)
│   ├── opencode.js        # OpenCode Zen (标准 OpenAI)
│   └── custom.js          # 自定义供应商
└── public/
    ├── index.html         # 管理面板页面
    ├── style.css          # 样式
    └── app.js             # 前端交互逻辑
```

---

## 3. API 设计

### 3.1 核心 API 端点

| 方法 | 路径 | 说明 | 鉴权 |
|------|------|------|------|
| GET | `/` | 管理面板页面 | 否 |
| GET | `/v1/models` | 获取可用模型列表 | 可选 |
| POST | `/v1/chat/completions` | 聊天补全（OpenAI 兼容） | Bearer Token |
| GET | `/api/stats` | 获取统计信息（前端用） | 否 |
| GET | `/api/health` | 健康检查 | 否 |

### 3.2 模型路由规则

```javascript
// 优先级从高到低
function selectProvider(model) {
  // 1. Gemini: 以 gemini- 开头的模型
  if (model.startsWith('gemini-') && GOOGLE_KEYS.length > 0) {
    return 'google';
  }
  
  // 2. OpenCode: 以 -free 结尾的模型
  if (model.endsWith('-free') && OPENCODE_KEYS.length > 0) {
    return 'opencode';
  }
  
  // 3. Custom: 在 CUSTOM_MODELS 列表中
  if (CUSTOM_MODELS.includes(model) && CUSTOM_ENDPOINT) {
    return 'custom';
  }
  
  // 4. Nvidia: 兜底路由
  if (NVIDIA_KEYS.length > 0) {
    return 'nvidia';
  }
  
  return null; // 未找到匹配供应商
}
```

### 3.3 Gemini 转换逻辑（保留）

由于 Google Gemini 使用非标准 API 格式，需保留以下转换：

1. **请求转换**：
   - OpenAI `messages[]` → Gemini `contents[]`
   - `temperature`, `max_tokens` → `generationConfig`
   - `reasoning_effort` → `thinkingConfig`
   - `tools` → `functionDeclarations`
   - `image_url` → `inlineData` (需预下载图片)

2. **响应转换**：
   - Gemini `candidates[].content.parts[]` → OpenAI `choices[].message`
   - `thought` 部分 → `reasoning_content`
   - `functionCall` → `tool_calls`

3. **流式转换**：
   - SSE data 行解析
   - 实时格式转换 + model ID 重写

---

## 4. 前端设计

### 4.1 设计风格参考

参考 GLaDOS 控制台风格，特点：
- **深色主题**：背景 `#0a0e17`，卡片 `#111827`
- **绿色/青色为主色调**：`#10b981`, `#06b6d4`
- **等宽字体显示数据**：系统状态
- **科技感边框**：发光的边框效果
- **网格卡片布局**：展示各项统计数据

### 4.2 页面布局

```
┌────────────────────────────────────────────────────────────┐
│  [🚀 VM-Gateway]                    [运行中 ●]  2d 5h 30m  │
├────────────────────────────────────────────────────────────┤
│                                                            │
│  ┌─────────┐ ┌─────────┐ ┌─────────┐ ┌─────────┐        │
│  │ 总请求数 │ │ Google  │ │ Nvidia  │ │ 自定义   │        │
│  │  1,234  │ │   567   │   │   456   │   │   211   │        │
│  └─────────┘ └─────────┘ └─────────┘ └─────────┘        │
│                                                            │
│  ┌─────────────────────────────┐ ┌──────────────────────┐ │
│  │     Key 池状态              │ │    可用模型列表       │ │
│  │  Google: ●●●○○ (3/5)       │ │  gemini-2.5-flash   │ │
│  │  Nvidia: ●●○○○ (2/5)       │ │  deepseek-v4-flash  │ │
│  │  OpenCode: ●●●●● (5/5)     │ │  glm-5.2            │ │
│  └─────────────────────────────┘ └──────────────────────┘ │
│                                                            │
│  ┌──────────────────────────────────────────────────────┐ │
│  │              系统资源监控                              │ │
│  │  CPU: ████████░░ 78%    MEM: ██████░░░░ 2.1/4 GB     │ │
│  └──────────────────────────────────────────────────────┘ │
│                                                            │
├────────────────────────────────────────────────────────────┤
│  Base URL: http://vm-ip:7860/v1  |  Token: ********       │
└────────────────────────────────────────────────────────────┘
```

### 4.3 前端技术栈

- 纯 HTML + CSS + JavaScript（无框架依赖）
- 使用 CSS Grid/Flexbox 布局
- Fetch API 异步获取统计数据
- 自动刷新（每 5 秒更新一次）

---

## 5. 配置设计

### 5.1 环境变量

| 变量名 | 必需 | 说明 | 示例 |
|--------|------|------|------|
| `PORT` | 否 | 服务端口 | `7860` |
| `ACCESS_TOKEN` | 否 | API 鉴权 Token | `your_secret` |
| `GOOGLE_KEYS` | 否 | Google API Keys | `key1,key2,key3` |
| `NVIDIA_KEYS` | 否 | Nvidia NIM Keys | `key1,key2` |
| `OPENCODE_KEYS` | 否 | OpenCode Keys | `key1,key2` |
| `CUSTOM_KEYS` | 否 | 自定义供应商 Keys | `key1,key2` |
| `CUSTOM_ENDPOINT` | 否 | 自定义 API 端点 | `https://api.example.com/v1` |
| `CUSTOM_MODELS` | 否 | 自定义支持的模型 | `model1,model2` |
| `EXPOSED_MODELS` | 否 | 对外暴露的模型列表 | `gemini-2.5-flash,...` |

### 5.2 配置文件示例 (.env)

```env
# Server
PORT=7860

# Auth (留空则禁用鉴权)
ACCESS_TOKEN=your_secret_token_here

# Provider Keys
GOOGLE_KEYS=key1,key2,key3
NVIDIA_KEYS=key1,key2
OPENCODE_KEYS=key1,key2
CUSTOM_KEYS=
CUSTOM_ENDPOINT=
CUSTOM_MODELS=

# Exposed Models
EXPOSED_MODELS=gemini-2.5-flash,gemini-2.5-pro,deepseek-v4-flash-free,z-ai/glm-5.2
```

---

## 6. 稳定性机制

### 6.1 Key 轮换策略

- **轮询模式**：每次请求使用下一个 Key
- **失败轮换**：遇到 401/403/408/429/5xx 错误时自动轮换
- **额度耗尽检测**：识别 rate limit 和 quota 耗尽错误

### 6.2 可重试错误码

```
401 - Key 无效 → 轮换
403 - Key 被封 → 轮换
408 - 请求超时 → 轮换
429 - 速率限制 → 轮换
5xx - 服务器错误 → 轮换
网络错误 - 轮换
```

### 6.3 不可重试（立即返回）

```
400 - 请求格式错误
404 - 模型不存在
其他 4xx 客户端错误
```

### 6.4 重试限制

最大重试次数 = 可用 Key 数量（避免无限重试）

---

## 7. 部署方案

### 7.1 直接运行

```bash
cd vm-gateway
npm init -y
# 或使用 nvm 管理 Node.js
node src/server.js
```

### 7.2 Docker 部署

```dockerfile
FROM node:20-alpine
WORKDIR /app
COPY src/ ./src/
COPY package.json ./
RUN npm install --production
EXPOSE 7860
CMD ["node", "src/server.js"]
```

```bash
docker build -t vm-gateway .
docker run -d --name gateway \
  -p 7860:7860 \
  -e ACCESS_TOKEN=your_token \
  -e GOOGLE_KEYS=key1,key2 \
  vm-gateway
```

### 7.3 进程守护（推荐 systemd）

```ini
# /etc/systemd/system/vm-gateway.service
[Unit]
Description=VM Gateway LLM Proxy
After=network.target

[Service]
Type=simple
User=www-data
WorkingDirectory=/opt/vm-gateway
ExecStart=/usr/bin/node src/server.js
Restart=always
RestartSec=5
Environment=PORT=7860

[Install]
WantedBy=multi-user.target
```

---

## 8. 开发计划

### 阶段一：架构搭建
1. 创建项目目录结构
2. 模块化拆分 server.js
3. 实现配置管理

### 阶段二：核心代理
1. 实现请求路由
2. 保留 Gemini 转换逻辑
3. 实现标准 OpenAI 直转

### 阶段三：稳定性
1. Key 轮换机制
2. 重试逻辑
3. 错误分类处理

### 阶段四：前端页面
1. HTML 结构
2. CSS 样式（深色科技风）
3. JS 交互 + 数据刷新

### 阶段五：部署优化
1. Docker 支持
2. systemd 配置
3. 日志管理

---

## 9. 注意事项

1. **原始代码保护**：所有改动在 `vm-gateway/` 目录下进行，不修改原项目
2. **API 兼容**：确保与现有客户端（Cursor/LobeChat/NextChat）兼容
3. **零依赖**：保持后端零外部依赖，便于部署
4. **日志**：简化日志输出，仅保留关键信息
5. **安全**：通过 ACCESS_TOKEN 保护 API，建议部署时使用
