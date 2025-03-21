/// <reference lib="deno.unstable" />
import { serve } from "https://deno.land/std@0.220.1/http/server.ts";
import { Redis } from "https://esm.sh/@upstash/redis@1.28.4";

// Redis配置
const redis = new Redis({
  url: Deno.env.get("UPSTASH_REDIS_URL") || "", 
  token: Deno.env.get("UPSTASH_REDIS_TOKEN") || "", 
});

// 请求日志的Redis键前缀
const REQUEST_LOG_PREFIX = "request_log:";
// 最大保存的请求数量
const MAX_LOGS = 100;

// 添加分段日志函数
function logFullContent(prefix: string, content: string) {
  console.log(`${prefix} 开始 >>>>>>>>`);
  
  // 每段最大长度
  const chunkSize = 1000;
  const chunks = Math.ceil(content.length / chunkSize);
  
  for(let i = 0; i < chunks; i++) {
    const start = i * chunkSize;
    const end = Math.min((i + 1) * chunkSize, content.length);
    console.log(`[第${i+1}/${chunks}段] ${content.slice(start, end)}`);
  }
  
  console.log(`${prefix} 结束 <<<<<<<< (总长度: ${content.length})`);
}

// 保存请求日志到Redis
async function saveRequestLog(request: Request, requestBody: string) {
  try {
    const timestamp = Date.now();
    const requestId = `${timestamp}-${Math.random().toString(36).substring(2, 15)}`;
    const url = new URL(request.url);
    
    const logEntry = {
      id: requestId,
      timestamp,
      method: request.method,
      url: request.url,
      path: url.pathname,
      headers: Object.fromEntries(request.headers.entries()),
      body: requestBody,
      clientIP: request.headers.get("x-forwarded-for") || "unknown"
    };
    
    // 保存请求日志
    await redis.set(`${REQUEST_LOG_PREFIX}${requestId}`, JSON.stringify(logEntry));
    
    // 将请求ID添加到列表头部
    await redis.lpush("request_log_ids", requestId);
    
    // 保持列表长度不超过最大值
    await redis.ltrim("request_log_ids", 0, MAX_LOGS - 1);
    
    console.log(`保存请求日志: ${requestId}`);
    return requestId;
  } catch (error) {
    console.error("保存请求日志失败:", error);
    return null;
  }
}

// 获取所有请求日志ID
async function getRequestLogIds(): Promise<string[]> {
  try {
    return await redis.lrange("request_log_ids", 0, -1) || [];
  } catch (error) {
    console.error("获取请求日志ID失败:", error);
    return [];
  }
}

// 获取单个请求日志
async function getRequestLog(id: string): Promise<any> {
  try {
    const logData = await redis.get(`${REQUEST_LOG_PREFIX}${id}`);
    return logData ? JSON.parse(logData) : null;
  } catch (error) {
    console.error(`获取请求日志 ${id} 失败:`, error);
    return null;
  }
}

// 获取所有请求日志
async function getAllRequestLogs(): Promise<any[]> {
  const ids = await getRequestLogIds();
  const logs = [];
  
  for (const id of ids) {
    const log = await getRequestLog(id);
    if (log) {
      logs.push(log);
    }
  }
  
  return logs;
}

// 清除所有请求日志
async function clearAllRequestLogs(): Promise<boolean> {
  try {
    const ids = await getRequestLogIds();
    
    // 删除所有日志条目
    for (const id of ids) {
      await redis.del(`${REQUEST_LOG_PREFIX}${id}`);
    }
    
    // 清空ID列表
    await redis.del("request_log_ids");
    console.log("已清除所有请求日志");
    return true;
  } catch (error) {
    console.error("清除请求日志失败:", error);
    return false;
  }
}

// 处理OPTIONS预检请求
function handleOptionsRequest(): Response {
  return new Response(null, {
    status: 204,
    headers: {
      "Access-Control-Allow-Origin": "*",
      "Access-Control-Allow-Methods": "GET, POST, DELETE, OPTIONS",
      "Access-Control-Allow-Headers": "Content-Type, Authorization",
      "Access-Control-Max-Age": "86400",
    }
  });
}

// HTML首页
function getHtmlIndex(): string {
  return `
<!DOCTYPE html>
<html lang="zh-CN">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>请求记录器</title>
  <style>
    body {
      font-family: 'PingFang SC', 'Microsoft YaHei', sans-serif;
      line-height: 1.6;
      color: #333;
      max-width: 1200px;
      margin: 0 auto;
      padding: 20px;
    }
    h1 {
      text-align: center;
      margin-bottom: 30px;
    }
    .controls {
      display: flex;
      justify-content: space-between;
      margin-bottom: 20px;
    }
    button {
      background-color: #4CAF50;
      color: white;
      border: none;
      padding: 10px 15px;
      text-align: center;
      text-decoration: none;
      display: inline-block;
      font-size: 16px;
      margin: 4px 2px;
      cursor: pointer;
      border-radius: 4px;
    }
    button.delete {
      background-color: #f44336;
    }
    .log-list {
      margin-bottom: 20px;
    }
    .log-item {
      border: 1px solid #ddd;
      padding: 15px;
      margin-bottom: 15px;
      border-radius: 4px;
    }
    .log-header {
      display: flex;
      justify-content: space-between;
      border-bottom: 1px solid #eee;
      padding-bottom: 10px;
      margin-bottom: 10px;
    }
    .method {
      font-weight: bold;
      padding: 2px 8px;
      border-radius: 4px;
      color: white;
    }
    .method.get { background-color: #61affe; }
    .method.post { background-color: #49cc90; }
    .method.put { background-color: #fca130; }
    .method.delete { background-color: #f93e3e; }
    .method.options { background-color: #0d5aa7; }
    .method.head { background-color: #9012fe; }
    .method.patch { background-color: #50e3c2; }
    .log-body {
      background-color: #f8f8f8;
      padding: 10px;
      border-radius: 4px;
      white-space: pre-wrap;
      overflow-x: auto;
      max-height: 300px;
      overflow-y: auto;
    }
    .timestamp {
      color: #666;
      font-size: 0.9em;
    }
    .log-url {
      word-break: break-all;
      margin: 5px 0;
    }
    .log-headers {
      margin-top: 10px;
      cursor: pointer;
    }
    .log-headers-content {
      display: none;
      background-color: #f8f8f8;
      padding: 10px;
      border-radius: 4px;
      margin-top: 5px;
    }
    .empty-state {
      text-align: center;
      padding: 50px;
      color: #666;
    }
    .loading {
      text-align: center;
      padding: 20px;
      color: #666;
    }
    /* 响应式设计 */
    @media (max-width: 768px) {
      .log-header {
        flex-direction: column;
      }
      .controls {
        flex-direction: column;
      }
      button {
        margin-bottom: 10px;
      }
    }
  </style>
</head>
<body>
  <h1>请求记录器</h1>
  
  <div class="controls">
    <div>
      <button id="refreshBtn">刷新</button>
      <button id="clearBtn" class="delete">清除所有日志</button>
    </div>
  </div>
  
  <div id="logList" class="log-list">
    <div class="loading">加载中...</div>
  </div>

  <script>
    // 格式化时间戳
    function formatTimestamp(timestamp) {
      const date = new Date(timestamp);
      return date.toLocaleString('zh-CN', {
        year: 'numeric',
        month: '2-digit',
        day: '2-digit',
        hour: '2-digit',
        minute: '2-digit',
        second: '2-digit',
        hour12: false
      });
    }
    
    // 格式化请求体
    function formatBody(body) {
      if (!body) return '无内容';
      
      try {
        // 尝试解析为JSON并格式化
        const parsed = JSON.parse(body);
        return JSON.stringify(parsed, null, 2);
      } catch (e) {
        // 如果不是JSON，直接返回
        return body;
      }
    }
    
    // 加载日志
    async function loadLogs() {
      const logList = document.getElementById('logList');
      logList.innerHTML = '<div class="loading">加载中...</div>';
      
      try {
        const response = await fetch('/api/logs');
        const logs = await response.json();
        
        if (logs.length === 0) {
          logList.innerHTML = '<div class="empty-state">暂无请求日志</div>';
          return;
        }
        
        let html = '';
        logs.forEach(log => {
          const methodClass = log.method.toLowerCase();
          html += `
            <div class="log-item">
              <div class="log-header">
                <span class="method ${methodClass}">${log.method}</span>
                <span class="timestamp">${formatTimestamp(log.timestamp)}</span>
              </div>
              <div class="log-url">${log.path}</div>
              <div class="log-headers" onclick="toggleHeaders('headers-${log.id}')">
                请求头 (点击展开)
                <div id="headers-${log.id}" class="log-headers-content">
                  <pre>${JSON.stringify(log.headers, null, 2)}</pre>
                </div>
              </div>
              <div class="log-body-label">请求体:</div>
              <pre class="log-body">${formatBody(log.body)}</pre>
            </div>
          `;
        });
        
        logList.innerHTML = html;
      } catch (error) {
        logList.innerHTML = '<div class="empty-state">加载失败，请重试</div>';
        console.error('加载日志失败:', error);
      }
    }
    
    // 切换请求头显示
    function toggleHeaders(id) {
      const element = document.getElementById(id);
      if (element.style.display === 'block') {
        element.style.display = 'none';
      } else {
        element.style.display = 'block';
      }
    }
    
    // 清除所有日志
    async function clearLogs() {
      if (!confirm('确定要清除所有日志吗？此操作不可撤销。')) {
        return;
      }
      
      try {
        const response = await fetch('/api/logs', {
          method: 'DELETE'
        });
        
        if (response.ok) {
          alert('日志已清除');
          loadLogs();
        } else {
          alert('清除日志失败');
        }
      } catch (error) {
        alert('清除日志失败');
        console.error('清除日志失败:', error);
      }
    }
    
    // 绑定事件处理器
    document.getElementById('refreshBtn').addEventListener('click', loadLogs);
    document.getElementById('clearBtn').addEventListener('click', clearLogs);
    
    // 页面加载完成后加载日志
    window.onload = loadLogs;
  </script>
</body>
</html>
  `;
}

// 修改请求处理函数
async function handleRequest(request: Request): Promise<Response> {
  const url = new URL(request.url);
  const path = url.pathname;
  
  // 增加更详细的请求日志
  console.log(`收到请求: ${request.method} ${path}`);
  console.log(`请求头:`, Object.fromEntries(request.headers.entries()));
  
  // 处理OPTIONS预检请求
  if (request.method === "OPTIONS") {
    return handleOptionsRequest();
  }
  
  // 处理API请求
  if (path.startsWith("/api/")) {
    // 获取所有日志
    if (path === "/api/logs") {
      if (request.method === "GET") {
        const logs = await getAllRequestLogs();
        return new Response(JSON.stringify(logs), {
          headers: { "Content-Type": "application/json" }
        });
      } else if (request.method === "DELETE") {
        const success = await clearAllRequestLogs();
        return new Response(JSON.stringify({ success }), {
          status: success ? 200 : 500,
          headers: { "Content-Type": "application/json" }
        });
      }
    }
    
    // 获取单个日志
    if (path.startsWith("/api/logs/") && request.method === "GET") {
      const id = path.substring("/api/logs/".length);
      const log = await getRequestLog(id);
      
      if (log) {
        return new Response(JSON.stringify(log), {
          headers: { "Content-Type": "application/json" }
        });
      } else {
        return new Response(JSON.stringify({ error: "日志不存在" }), {
          status: 404,
          headers: { "Content-Type": "application/json" }
        });
      }
    }
    
    // 未找到API路由
    return new Response(JSON.stringify({ error: "未找到API路由" }), {
      status: 404,
      headers: { "Content-Type": "application/json" }
    });
  }
  
  // 主页 - 提供可视化界面
  if (path === "/" || path === "") {
    return new Response(getHtmlIndex(), {
      headers: { "Content-Type": "text/html; charset=utf-8" }
    });
  }
  
  // 记录请求（如果调试模式已开启）
  if (state.isDebugMode) {
    try {
      // 改进请求体读取方式
      let requestBody = "";
      const requestClone = request.clone(); // 克隆请求避免消费原始请求体
      
      // 对于GET和HEAD请求，不读取请求体
      if (request.method !== "GET" && request.method !== "HEAD") {
        const contentType = request.headers.get("content-type") || "";
        
        // 记录内容类型
        console.log(`内容类型: ${contentType}`);
        
        // 特别处理JSON内容
        if (contentType.includes("application/json")) {
          try {
            const jsonBody = await requestClone.json();
            requestBody = JSON.stringify(jsonBody, null, 2);
            console.log("成功读取JSON请求体");
          } catch (e) {
            console.error("JSON解析失败，尝试读取文本", e);
            requestBody = await requestClone.clone().text();
          }
        } else {
          // 其他内容类型直接作为文本读取
          requestBody = await requestClone.text();
        }
        
        // 记录请求体大小
        console.log(`请求体大小: ${requestBody.length} 字符`);
        logFullContent("请求体", requestBody);
      }
      
      // 保存请求日志
      saveRequestLog(request, requestBody);
    } catch (error) {
      console.error("读取请求体失败:", error);
    }
  }
  
  // 转发请求到目标服务器
  return handleProxy(request);
}

// 服务器启动
Deno.serve({
  onListen: ({ port }) => {
    console.log(`请求记录器服务启动成功，监听端口: ${port}`);
  },
}, async (request: Request) => {
  try {
    return await handleRequest(request);
  } catch (error) {
    console.error(`请求处理出错:`, error);
    return new Response("Internal Server Error", { status: 500 });
  }
}); 
