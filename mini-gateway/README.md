# HF Multi-Key Proxy Gateway

一个极简、零依赖、无数据库的 OpenAI 兼容中转网关，专为 HuggingFace Space 部署设计。

主要用于借用 HuggingFace 的海外 IP 来中转并轮询使用 Google Gemini API（解决 Cloudflare IP 被封锁的问题）以及 NVIDIA NIM API，并支持自动故障转移（Failover）。

---

## 功能特性

- ⚡ **零依赖构建**：不需要 `npm install` 下载任何依赖包，Docker 构建在 3 秒内即可完成，彻底避免了 HuggingFace 构建服务器上常见的 `ETIMEDOUT` 网络超时错误。
- 🔄 **多密钥自动轮换 (Key Rotation)**：支持为 Google、Nvidia 传入多个 API Keys，每次请求自动使用，或者在遇到限制时自动轮换。
- 🛡️ **自动故障转移 (Failover)**：当请求返回 `429 (频率限制)` 或 `401 (额度已满/无效 Key)` 时，自动尝试下一个 Key，直到成功或尝试完所有 Key。
- 🌊 **原生流式支持 (SSE Streaming)**：完全透传 SSE 流式响应，无需任何复杂解析，完美支持打字机流式输出。
- 🔐 **访问控制**：支持设置 `ACCESS_TOKEN`，只有携带正确 Token 的客户端请求才会被接受，保护你的中转网关不被盗刷。
- 📊 **可视化状态面板**：访问网页根目录 `/` 会显示一个精美的 HSL 风格暗黑模式状态页，实时展示 Key 池数量、历史调用统计、系统运行时间等。

---

## 目录结构

你只需要在 HuggingFace Space 中上传以下两个文件：
```
HuggingFace Space 仓库/
├── Dockerfile      # 极简镜像构建
└── server.js       # 核心中转服务器逻辑
```

---

## 部署与配置步骤

### 第一步：新建 HuggingFace Space

1. 打开 [HuggingFace Spaces](https://huggingface.co/spaces) 并点击 **Create new Space**。
2. 填写 Space Name。
3. **Select the Space SDK**: 选择 **Docker** (不要选 Gradio 或 Static)。
4. **Choose a Docker template**: 选择 **Blank**。
5. 空间可见性设为 **Public** 或 **Private**（建议设为 **Private** 以防别人查看你的中转配置）。
6. 点击 **Create Space**。

### 第二步：配置环境变量 (Secrets)

在 Space 创建好后，进入 Space 的 **Settings** 页面，找到 **Variables and Secrets** 区域，添加以下 **Secrets** (注意选择 **Secret**，而不是 Variable)：

| 密钥名称 (Key) | 示例值 | 说明 |
| :--- | :--- | :--- |
| `GOOGLE_KEYS` | `AIzaSyA...,AIzaSyB...` | **必填 (若需 Gemini)**: 你的多个 Google API Key，用英文逗号 `,` 隔开。 |
| `NVIDIA_KEYS` | `nvapi-...,nvapi-...` | **选填**: 你的多个 NVIDIA NIM API Key，用英文逗号 `,` 隔开。 |
| `ACCESS_TOKEN` | `my-secret-token` | **推荐**: 保护网关的密码。客户端调用时必须将其作为 API Key 传入。如果留空则为公开网关。 |
| `CUSTOM_ENDPOINT` | `https://api.deepseek.com/v1/chat/completions` | **选填**: 其他标准 OpenAPI 兼容中转端。 |
| `CUSTOM_KEYS` | `sk-...,sk-...` | **选填**: 自定义中转端的多个 Key，用英文逗号 `,` 隔开。 |
| `CUSTOM_MODELS` | `deepseek-chat,deepseek-reasoner` | **选填**: 路由到自定义中转端的模型列表，用英文逗号 `,` 隔开。 |
| `EXPOSED_MODELS` | `gemini-1.5-flash,gemini-3.5-flash-lite,nvidia/glm-5.2` | **选填**: 你想指定并暴露给客户端的模型 ID 列表（逗号分隔）。设置后 `/v1/models` 只会返回这些模型，且屏蔽不在列表里的模型请求。如果留空，则使用默认的可用模型列表。 |

### 第三步：上传代码文件

1. 在 Space 的 **Files and versions** 页面，点击 **Add file** -> **Create a new file**。
2. 创建一个名为 `Dockerfile` 的文件，写入以下内容：
   ```dockerfile
   FROM node:20-alpine
   WORKDIR /app
   COPY server.js .
   EXPOSE 7860
   ENV PORT=7860
   CMD ["node", "server.js"]
   ```
3. 提交修改。
4. 再次点击 **Add file** -> **Create a new file**。
5. 创建一个名为 `server.js` 的文件，将本项目 `mini-gateway/server.js` 的全部内容粘贴进去。
6. 提交修改。

一旦文件提交，HuggingFace 就会自动触发构建。由于没有任何包安装，**3-5秒内即可构建并启动完毕！**

---

## 客户端接入方式

网关运行成功后，你可以在 LobeChat、Cursor、NextChat 等客户端中直接使用它：

1. **接口地址 (Base URL)**: `https://你的Space名称.hf.space/v1` (如果你的 Space 是 Private 的，HF 会提供一个带权限的 Direct URL，请使用 HF 页面顶部的 `Embed this Space` 弹窗里的 `Direct URL`，或是在 Settings 页面查看)。
2. **API Key**: 填写你在 HF Secrets 里配置的 `ACCESS_TOKEN` (如果没有配 Token，可以随意填写)。
3. **支持的模型**:
   - Google Gemini: `gemini-1.5-flash`, `gemini-1.5-pro`, `gemini-2.5-flash`, `gemini-3.5-flash-lite` 等所有 `gemini-` 开头的模型。
   - NVIDIA NIM: `nvidia/glm-5.2` 等。

---

## 部署到 Google Cloud Run (推荐，无冷启动及429烦恼)

如果你想获得**更干净的出站 IP (避免 429 共享 IP 污染)**、**极速冷启动 (仅需 1.5s)**，建议将本网关部署到 Google Cloud Run。

### 部署步骤：

1. 确保本地已安装并登录了 `gcloud` 命令行工具 (`brew install --cask google-cloud-sdk` ➔ `gcloud init`)。
2. 直接在项目根目录下运行一键部署脚本：
   ```bash
   ./deploy_gcp.sh
   ```
3. 部署成功后，控制台会输出公网 HTTPS 服务链接。
4. 登录 [Google Cloud Console ➔ Cloud Run](https://console.cloud.google.com/run)，选择对应的 `llm-gateway` 服务，进入 **Edit & Deploy New Revision** 的 **Variables & Secrets** 页面，点击添加网关的配置环境变量（如 `GOOGLE_KEYS`、`NVIDIA_KEYS` 和 `ACCESS_TOKEN`），点击部署即可。
