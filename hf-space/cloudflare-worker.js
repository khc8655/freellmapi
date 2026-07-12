/**
 * Cloudflare Worker — FreeLLMAPI 国内反代
 *
 * 功能：
 *   - 将所有请求透明转发到 HuggingFace Space
 *   - 正确处理 SSE 流式响应 (stream: true)
 *   - 处理 CORS，允许从任意客户端调用
 *   - 支持大请求体 (multipart/form-data, audio, image)
 *
 * 部署方式：
 *   1. 在 Cloudflare Dashboard → Workers & Pages → Create Worker
 *   2. 将此文件内容粘贴到编辑器
 *   3. 在 Worker Settings → Variables 中设置:
 *      - HF_SPACE_URL = https://你的用户名-freellmapi.hf.space
 *   4. 绑定你的自定义域名（国内可访问的域名）
 */

// ============================================================
// 配置区（也可通过 Worker 环境变量覆盖）
// ============================================================
const DEFAULT_HF_SPACE_URL = "https://YOUR_HF_USERNAME-freellmapi.hf.space";

// ============================================================
// CORS 预检响应
// ============================================================
function corsHeaders(origin) {
  return {
    "Access-Control-Allow-Origin": origin || "*",
    "Access-Control-Allow-Methods": "GET, POST, PUT, DELETE, OPTIONS, PATCH",
    "Access-Control-Allow-Headers":
      "Content-Type, Authorization, X-Requested-With, anthropic-version, x-api-key",
    "Access-Control-Max-Age": "86400",
    "Access-Control-Allow-Credentials": "true",
  };
}

// ============================================================
// Worker 主入口
// ============================================================
export default {
  async fetch(request, env) {
    const origin = request.headers.get("Origin") || "*";

    // 处理 CORS 预检
    if (request.method === "OPTIONS") {
      return new Response(null, {
        status: 204,
        headers: corsHeaders(origin),
      });
    }

    // 目标 HF Space URL（优先读 Worker 环境变量）
    const targetBase = (env.HF_SPACE_URL || DEFAULT_HF_SPACE_URL).replace(/\/$/, "");

    // 构建目标 URL（保留路径 + 查询参数）
    const url = new URL(request.url);
    const targetUrl = `${targetBase}${url.pathname}${url.search}`;

    // --------------------------------------------------------
    // 构建转发请求头（去掉 Host，避免 HF 拒绝）
    // --------------------------------------------------------
    const forwardHeaders = new Headers(request.headers);
    forwardHeaders.delete("host");
    forwardHeaders.delete("cf-connecting-ip");
    forwardHeaders.delete("cf-ray");
    forwardHeaders.delete("cf-visitor");
    forwardHeaders.delete("x-forwarded-proto");
    
    // Auto-inject Referer header matching the target base URL to bypass DOM Cloud free domain anti-abuse deceptive checks
    forwardHeaders.set("Referer", targetBase + "/");

    // --------------------------------------------------------
    // 发起转发请求
    // 注意：body 必须用 request.body (ReadableStream) 以支持流式上传
    // --------------------------------------------------------
    let upstreamResponse;
    try {
      upstreamResponse = await fetch(targetUrl, {
        method: request.method,
        headers: forwardHeaders,
        body: ["GET", "HEAD"].includes(request.method) ? null : request.body,
        // duplex 让 Worker 支持流式请求体（Cloudflare Workers 必须显式声明）
        duplex: "half",
      });
    } catch (err) {
      return new Response(
        JSON.stringify({ error: "upstream_unreachable", detail: err.message }),
        {
          status: 502,
          headers: {
            "Content-Type": "application/json",
            ...corsHeaders(origin),
          },
        }
      );
    }

    // --------------------------------------------------------
    // 构建响应头（注入 CORS，保留上游所有其他头）
    // --------------------------------------------------------
    const responseHeaders = new Headers(upstreamResponse.headers);

    // 强制覆盖 CORS（确保国内客户端可访问）
    const cors = corsHeaders(origin);
    for (const [k, v] of Object.entries(cors)) {
      responseHeaders.set(k, v);
    }

    // SSE 流式响应：确保不被 Cloudflare 缓冲
    const contentType = responseHeaders.get("content-type") || "";
    if (contentType.includes("text/event-stream")) {
      responseHeaders.set("Cache-Control", "no-cache, no-transform");
      responseHeaders.set("X-Accel-Buffering", "no");
    }

    // --------------------------------------------------------
    // 返回透明代理响应（body 直接流式透传）
    // --------------------------------------------------------
    return new Response(upstreamResponse.body, {
      status: upstreamResponse.status,
      statusText: upstreamResponse.statusText,
      headers: responseHeaders,
    });
  },
};
