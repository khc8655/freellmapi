# FreeLLMAPI 部署手册
## HuggingFace Space + Cloudflare Worker

---

## 架构

```
国内客户端
    │  https://你的域名/v1/chat/completions
    ▼
Cloudflare Worker（自定义域名）
    │  透明转发，支持 SSE 流式
    ▼
HuggingFace Space（Docker, port 7860）
    ├── /app/data/freeapi.db        ← 运行时 SQLite（快速 I/O）
    └── /data/freellmapi_backup/    ← HF 持久存储（重启恢复）
    │
    ▼
各 LLM 提供商（Groq / Gemini / Mistral 等）
```

---

## 第一步：Fork 并准备代码

```bash
git clone https://github.com/你的用户名/freellmapi.git
cd freellmapi
```

`hf-space/` 目录下的文件已准备好，不需要修改：
- `Dockerfile` — HF 专用（port 7860，含 sqlite3）
- `entrypoint.sh` — 含持久化同步逻辑
- `cloudflare-worker.js` — Cloudflare Worker 代码

---

## 第二步：创建 HuggingFace Space

1. 打开 https://huggingface.co/new-space
2. **SDK** 选 **Docker**，**Visibility** 选 **Private**
3. 创建后进入 **Settings → Persistent storage**，开启（Small 20GB ~$5/月）
4. 在 **Settings → Repository secrets** 添加：

| Secret 名 | 生成方式 |
|-----------|---------|
| `ENCRYPTION_KEY` | `node -e "console.log(require('crypto').randomBytes(32).toString('hex'))"` |

---

## 第三步：推送代码到 Space

```bash
# 添加 HF Space 为远程仓库
git remote add hf-space https://huggingface.co/spaces/你的HF用户名/freellmapi

# 创建 HF 专用分支
git checkout -b hf-deploy

# 用 HF 版 Dockerfile 替换根目录的
cp hf-space/Dockerfile Dockerfile

# 提交并推送
git add Dockerfile hf-space/entrypoint.sh
git commit -m "feat: HuggingFace Space deployment"
git push hf-space hf-deploy:main
```

等待构建完成（约 3-5 分钟）。

---

## 第四步：首次初始化

Space 启动后访问 `https://你的用户名-freellmapi.hf.space`：

1. 注册管理员邮箱 + 密码
2. 在 **Keys** 页面添加各 LLM 提供商 API Key

> 添加完 Keys 后等约 10 分钟，首次同步会将配置保存到 `/data`。之后重启自动恢复。

---

## 第五步：配置 Cloudflare Worker

1. Cloudflare Dashboard → **Workers & Pages** → **Create Worker**
2. 粘贴 `hf-space/cloudflare-worker.js` 内容
3. Worker → **Settings → Variables** 添加：

| 变量名 | 值 |
|-------|---|
| `HF_SPACE_URL` | `https://你的HF用户名-freellmapi.hf.space` |

4. Worker → **Settings → Domains & Routes** → 绑定你的自定义域名

---

## 第六步：验证

```bash
# 测试连通性
curl https://api.yourdomain.com/v1/models \
  -H "Authorization: Bearer freellmapi-你的key"

# 测试流式响应
curl https://api.yourdomain.com/v1/chat/completions \
  -H "Authorization: Bearer freellmapi-你的key" \
  -H "Content-Type: application/json" \
  -d '{"model":"auto","stream":true,"messages":[{"role":"user","content":"hello"}]}'
```

---

## 持久化同步机制

```
容器启动
  ├── 有 /data/freellmapi_backup/freeapi.db？
  │     是 → 恢复到 /app/data/freeapi.db → 启动服务器
  │     否 → 创建新数据库 → 启动服务器
  ├── 后台守护：每 2 小时 VACUUM INTO 备份到 /data
  └── 收到 SIGTERM → 立即备份 → 优雅退出
```

**为什么用 `VACUUM INTO` 而非 `cp`？**
SQLite WAL 模式下直接 cp 可能复制到不一致状态。`VACUUM INTO` 由引擎保证输出完整一致的单文件备份，服务器运行时也安全。

---

## 防睡眠（GitHub Actions）

```yaml
# .github/workflows/keep-alive.yml
name: Keep HF Space Alive
on:
  schedule:
    - cron: '0 */12 * * *'
jobs:
  ping:
    runs-on: ubuntu-latest
    steps:
      - run: curl -s https://你的HF用户名-freellmapi.hf.space/v1/models > /dev/null
```
