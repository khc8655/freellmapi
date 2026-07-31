# freellmapi 项目长期笔记

## 线上部署（重要，易踩坑）
- **真实服务名：`freellmapi`，region：`us-west1`**（非 llm-gateway / us-central1）。
- 正确部署命令（在 `mini-gateway/` 目录执行）：
  `gcloud run deploy freellmapi --source . --region us-west1 --allow-unauthenticated --quiet`
- `deploy_gcp.sh` 里的 SERVICE_NAME=llm-gateway / REGION=us-central1 **已过时，不要照抄**。
- 真实 URL：`https://freellmapi-559850716466.us-west1.run.app`（当前 deploy 输出，与 README 一致）。Cloudflare 代理域名 `g.khc6.eu.cc` 指向该服务，国内用此域名访问。
- 部署用 `--source .` 走 Cloud Build 云端构建，本地无需 docker。
- freellmapi **不依赖环境变量注入 providers**（env 列表为空）；providers 来自 **GCS 持久化 config.json**（bucket `freellmapi-data-store`）。部署新代码即自动继承 GCS 配置，无需重新设 env。

## 密钥与忽略规则
- `config.md` 是用户个人配置说明（含明文真实密钥：GOOGLE_KEYS/NVIDIA_KEYS/OPENCODE_KEYS/ACCESS_TOKEN），**与原代码无关，绝不进 Cloud Run**。
- 已加 `.gcloudignore` + `.dockerignore` 排除 config.md/.env*/data/.workbuddy。
- ACCESS_TOKEN 在 server.js 有 fallback（真实 token），鉴权可用。

## 架构要点
- 纯 Node 单文件 server.js，零依赖、零构建，Cloud Run 冷启动快。
- 默认 min-instances=0，无流量自动缩零，不常驻。
- keyHealth 为纯内存计数（随 /api/logs 返回），重启/缩零后重置，不落盘、不影响启动。

## 已修复的原代码 bug（server.js）
1. CONFIG_FILE_NAME / LOGS_FILE_NAME 未定义（保存配置、清空日志必崩）→ 补常量
2. writeGcsJson 保存配置时漏传文件名参数
3. clearLogs 中 writeGcsJson 漏传第三参数

## 用户偏好（前端改动，重要）
- 用户只想要"改前端布局"，不满把简单前端改动做成"重写整个 dashboard + 加后端优化"（过度工程）。
- 解释要简洁直接，少长篇分析；给 2 选 1 方案让用户拍板，不要自作主张大改。
- 前端改动保持轻量，不碰后端功能（proxy/provider/config 逻辑不动）。
