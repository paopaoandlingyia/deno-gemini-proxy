/// <reference lib="deno.unstable" />
import { serve } from "https://deno.land/std@0.220.1/http/server.ts";

// 配置
const TARGET_URL = Deno.env.get("TARGET_URL") || "https://generativelanguage.googleapis.com"; // 默认反代目标
const MAX_LOGS = 100; // 最大保存日志数量

// 请求日志存储
interface RequestLog {
  id: string;
  timestamp: number;
  method: string;
  url: string;
  path: string;
  headers: Record<string, string>;
  body: string;
  clientIP: string;
}

// 全局状态
const state = {
  isDebugMode: false, // 默认关闭调试模式
  logs: [] as RequestLog[], // 日志存储
  startTime: 0, // 调试模式开始时间
};

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

// 保存请求日志到内存
function saveRequestLog(request: Request, requestBody: string) {
  if (!state.isDebugMode) return null; // 不在调试模式，不保存日志
  
  const timestamp = Date.now();
  const requestId = `${timestamp}-${Math.random().toString(36).substring(2, 15)}`;
  const url = new URL(request.url);
  
  const logEntry: RequestLog = {
    id: requestId,
    timestamp,
    method: request.method,
    url: request.url,
    path: url.pathname,
    headers: Object.fromEntries(request.headers.entries()),
    body: requestBody,
    clientIP: request.headers.get("x-forwarded-for") || "unknown"
  };
  
  // 添加到日志数组前面
  state.logs.unshift(logEntry);
  
  // 保持日志数不超过最大值
  if (state.logs.length > MAX_LOGS) {
    state.logs = state.logs.slice(0, MAX_LOGS);
  }
  
  console.log(`保存请求日志: ${requestId}`);
  return requestId;
}

// 清除所有请求日志
function clearAllRequestLogs(): boolean {
  try {
    state.logs = [];
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
      "Access-Control-Allow-Methods": "GET, POST, DELETE, OPTIONS, PUT, PATCH",
      "Access-Control-Allow-Headers": "Content-Type, Authorization, x-goog-api-key",
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
  <title>请求调试器</title>
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
      margin-bottom: 20px;
    }
    .status-bar {
      background-color: #f8f8f8;
      border-radius: 4px;
      padding: 15px;
      margin-bottom: 20px;
      display: flex;
      justify-content: space-between;
      align-items: center;
    }
    .status-indicator {
      display: flex;
      align-items: center;
    }
    .status-dot {
      width: 12px;
      height: 12px;
      border-radius: 50%;
      background-color: #999;
      margin-right: 8px;
    }
    .status-dot.active {
      background-color: #4CAF50;
    }
    .status-info {
      font-size: 0.9em;
      color: #666;
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
      transition: background-color 0.3s;
    }
    button:hover {
      background-color: #45a049;
    }
    button:disabled {
      background-color: #cccccc;
      cursor: not-allowed;
    }
    button.delete {
      background-color: #f44336;
    }
    button.delete:hover {
      background-color: #d32f2f;
    }
    button.toggle-off {
      background-color: #2196F3;
    }
    button.toggle-off:hover {
      background-color: #0b7dda;
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
  <h1>请求调试器</h1>
  
  <div class="status-bar">
    <div class="status-indicator">
      <div id="statusDot" class="status-dot"></div>
      <span id="statusText">调试模式已关闭</span>
    </div>
    <div class="status-info" id="statusInfo">
      反代目标: ${TARGET_URL}
    </div>
  </div>
  
  <div class="controls">
    <div>
      <button id="toggleBtn">开启调试</button>
      <button id="refreshBtn">刷新</button>
      <button id="clearBtn" class="delete">清除所有日志</button>
    </div>
  </div>
  
  <div id="logList" class="log-list">
    <div class="empty-state">调试模式已关闭，开启后将在此显示请求日志</div>
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
    
    // 格式化时间差
    function formatDuration(startTime) {
      const duration = Math.floor((Date.now() - startTime) / 1000);
      const hours = Math.floor(duration / 3600);
      const minutes = Math.floor((duration % 3600) / 60);
      const seconds = duration % 60;
      
      let result = '';
      if (hours > 0) {
        result += hours + '小时';
      }
      if (minutes > 0 || hours > 0) {
        result += minutes + '分';
      }
      result += seconds + '秒';
      
      return result;
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
    
    // 获取调试状态
    async function getDebugStatus() {
      try {
        const response = await fetch('/api/debug/status');
        return await response.json();
      } catch (error) {
        console.error('获取调试状态失败:', error);
        return { isDebugMode: false };
      }
    }
    
    // 切换调试模式
    async function toggleDebugMode() {
      const toggleBtn = document.getElementById('toggleBtn');
      toggleBtn.disabled = true;
      
      try {
        const response = await fetch('/api/debug/toggle', {
          method: 'POST'
        });
        
        const result = await response.json();
        updateDebugStatus(result);
        loadLogs();
        
      } catch (error) {
        console.error('切换调试模式失败:', error);
        alert('操作失败，请重试');
      } finally {
        toggleBtn.disabled = false;
      }
    }
    
    // 更新调试状态UI
    function updateDebugStatus(status) {
      const statusDot = document.getElementById('statusDot');
      const statusText = document.getElementById('statusText');
      const toggleBtn = document.getElementById('toggleBtn');
      const statusInfo = document.getElementById('statusInfo');
      
      if (status.isDebugMode) {
        statusDot.classList.add('active');
        statusText.textContent = '调试模式已开启';
        toggleBtn.textContent = '关闭调试';
        toggleBtn.classList.add('toggle-off');
        
        // 更新持续时间
        if (status.startTime) {
          const duration = formatDuration(status.startTime);
          statusInfo.innerHTML = \`反代目标: ${TARGET_URL}<br>已记录 \${status.logCount} 个请求 · 已开启 \${duration}\`;
          
          // 定时更新持续时间
          if (!window.durationTimer) {
            window.durationTimer = setInterval(() => {
              const newDuration = formatDuration(status.startTime);
              statusInfo.innerHTML = \`反代目标: ${TARGET_URL}<br>已记录 \${status.logCount} 个请求 · 已开启 \${newDuration}\`;
            }, 1000);
          }
        }
      } else {
        statusDot.classList.remove('active');
        statusText.textContent = '调试模式已关闭';
        toggleBtn.textContent = '开启调试';
        toggleBtn.classList.remove('toggle-off');
        statusInfo.innerHTML = \`反代目标: ${TARGET_URL}\`;
        
        // 清除定时器
        if (window.durationTimer) {
          clearInterval(window.durationTimer);
          window.durationTimer = null;
        }
      }
    }
    
    // 加载日志
    async function loadLogs() {
      const logList = document.getElementById('logList');
      
      try {
        const statusResponse = await fetch('/api/debug/status');
        const status = await statusResponse.json();
        
        if (!status.isDebugMode) {
          logList.innerHTML = '<div class="empty-state">调试模式已关闭，开启后将在此显示请求日志</div>';
          return;
        }
        
        logList.innerHTML = '<div class="loading">加载中...</div>';
        
        const response = await fetch('/api/logs');
        const logs = await response.json();
        
        if (logs.length === 0) {
          logList.innerHTML = '<div class="empty-state">暂无请求日志</div>';
          return;
        }
        
        let html = '';
        logs.forEach(log => {
          const methodClass = log.method.toLowerCase();
          html += \`
            <div class="log-item">
              <div class="log-header">
                <span class="method \${methodClass}">\${log.method}</span>
                <span class="timestamp">\${formatTimestamp(log.timestamp)}</span>
              </div>
              <div class="log-url">\${log.path}</div>
              <div class="log-headers" onclick="toggleHeaders('headers-\${log.id}')">
                请求头 (点击展开)
                <div id="headers-\${log.id}" class="log-headers-content">
                  <pre>\${JSON.stringify(log.headers, null, 2)}</pre>
                </div>
              </div>
              <div class="log-body-label">请求体:</div>
              <pre class="log-body">\${formatBody(log.body)}</pre>
            </div>
          \`;
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
          
          // 更新状态信息
          const statusResponse = await fetch('/api/debug/status');
          const status = await statusResponse.json();
          updateDebugStatus(status);
        } else {
          alert('清除日志失败');
        }
      } catch (error) {
        alert('清除日志失败');
        console.error('清除日志失败:', error);
      }
    }
    
    // 页面加载时初始化
    async function init() {
      try {
        const status = await getDebugStatus();
        updateDebugStatus(status);
        loadLogs();
      } catch (error) {
        console.error('初始化失败:', error);
      }
    }
    
    // 绑定事件处理器
    document.getElementById('toggleBtn').addEventListener('click', toggleDebugMode);
    document.getElementById('refreshBtn').addEventListener('click', loadLogs);
    document.getElementById('clearBtn').addEventListener('click', clearLogs);
    
    // 页面加载完成后初始化
    window.onload = init;
  </script>
</body>
</html>
  `;
}

// 处理调试API
async function handleDebugApi(request: Request, path: string): Promise<Response> {
  // 获取调试状态
  if (path === "/api/debug/status" && request.method === "GET") {
    return new Response(JSON.stringify({
      isDebugMode: state.isDebugMode,
      startTime: state.startTime,
      logCount: state.logs.length
    }), {
      headers: { "Content-Type": "application/json" }
    });
  }
  
  // 切换调试模式
  if (path === "/api/debug/toggle" && request.method === "POST") {
    state.isDebugMode = !state.isDebugMode;
    
    if (state.isDebugMode) {
      state.startTime = Date.now();
    } else {
      state.startTime = 0;
    }
    
    return new Response(JSON.stringify({
      isDebugMode: state.isDebugMode,
      startTime: state.startTime,
      logCount: state.logs.length
    }), {
      headers: { "Content-Type": "application/json" }
    });
  }
  
  return new Response(JSON.stringify({ error: "未找到API路由" }), {
    status: 404,
    headers: { "Content-Type": "application/json" }
  });
}

// 处理日志API
async function handleLogsApi(request: Request): Promise<Response> {
  // 获取所有日志
  if (request.method === "GET") {
    return new Response(JSON.stringify(state.logs), {
      headers: { "Content-Type": "application/json" }
    });
  } 
  // 清除所有日志
  else if (request.method === "DELETE") {
    const success = clearAllRequestLogs();
    return new Response(JSON.stringify({ success }), {
      status: success ? 200 : 500,
      headers: { "Content-Type": "application/json" }
    });
  }
  
  return new Response(JSON.stringify({ error: "不支持的方法" }), {
    status: 405,
    headers: { "Content-Type": "application/json" }
  });
}

// 处理代理转发
async function handleProxy(request: Request): Promise<Response> {
  try {
    const url = new URL(request.url);
    const targetUrl = new URL(url.pathname + url.search, TARGET_URL);
    
    console.log(`转发请求到: ${targetUrl.toString()}`);
    
    // 创建代理请求
    const headers = new Headers(request.headers);
    headers.delete('host'); // 删除host头，以防干扰目标服务器
    
    const response = await fetch(targetUrl.toString(), {
      method: request.method,
      headers: headers,
      body: request.body,
      redirect: 'follow'
    });
    
    // 构建响应
    const proxyResponse = new Response(response.body, {
      status: response.status,
      statusText: response.statusText,
      headers: new Headers(response.headers)
    });
    
    // 添加CORS头
    proxyResponse.headers.set('Access-Control-Allow-Origin', '*');
    
    return proxyResponse;
  } catch (error) {
    console.error('代理请求失败:', error);
    return new Response(JSON.stringify({
      error: '代理请求失败',
      message: error.message
    }), {
      status: 500,
      headers: { 
        'Content-Type': 'application/json',
        'Access-Control-Allow-Origin': '*'
      }
    });
  }
}

// 请求处理函数
async function handleRequest(request: Request): Promise<Response> {
  const url = new URL(request.url);
  const path = url.pathname;
  
  // API和主页请求处理保持不变
  if (path.startsWith("/api/") || path === "/" || path === "") {
    // 原有逻辑...
  }
  
  // 复制请求信息用于日志记录
  const method = request.method;
  const headers = Object.fromEntries(request.headers.entries());
  const clientIP = request.headers.get("x-forwarded-for") || "unknown";
  
  // 先直接转发请求，不尝试读取请求体
  const proxyResponse = await handleProxy(request);
  
  // 如果处于调试模式，异步记录请求（不影响响应返回）
  if (state.isDebugMode && method !== "GET" && method !== "HEAD") {
    // 创建一个延迟执行的任务，异步读取请求体
    (async () => {
      try {
        // 尝试克隆请求并读取请求体
        const clonedRequest = request.clone();
        const bodyText = await clonedRequest.text().catch(() => "");
        
        // 创建日志条目
        const timestamp = Date.now();
        const requestId = `${timestamp}-${Math.random().toString(36).substring(2, 15)}`;
        
        // 即使无法读取请求体，也记录请求信息
        const logEntry: RequestLog = {
          id: requestId,
          timestamp,
          method,
          url: request.url,
          path,
          headers,
          body: bodyText || "[无法读取请求体或请求体为空]",
          clientIP
        };
        
        state.logs.unshift(logEntry);
        
        // 保持日志数不超过最大值
        if (state.logs.length > MAX_LOGS) {
          state.logs = state.logs.slice(0, MAX_LOGS);
        }
        
        console.log(`异步保存请求日志: ${requestId}`);
        if (bodyText) {
          logFullContent("请求体(异步获取)", bodyText);
        }
      } catch (error) {
        console.error("异步记录请求失败:", error);
      }
    })();
  }
  
  // 立即返回代理响应
  return proxyResponse;
}

// 服务器启动
console.log(`启动反代服务器，目标: ${TARGET_URL}`);
Deno.serve({
  onListen: ({ port }) => {
    console.log(`服务启动成功，监听端口: ${port}`);
    console.log(`请访问 http://localhost:${port}/ 打开调试界面`);
  },
}, async (request: Request) => {
  try {
    return await handleRequest(request);
  } catch (error) {
    console.error(`请求处理出错:`, error);
    return new Response("Internal Server Error", { status: 500 });
  }
});
