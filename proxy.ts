/// <reference lib="deno.unstable" />
import { serve } from "https://deno.land/std@0.220.1/http/server.ts";

// 配置
const TARGET_URL = Deno.env.get("TARGET_URL") || "https://generativelanguage.googleapis.com"; // 默认反代目标
const MAX_LOGS = 100; // 最大保存日志数量
const ENABLE_KV_STORAGE = true; // 是否启用KV存储，可以在不同实例间共享日志

// 请求日志存储
interface RequestLog {
  id: string;
  timestamp: number;
  method: string;
  url: string;
  path: string;
  headers: Record<string, string>;
  body: string;
  targetBody?: string; // 添加目标请求体字段
  clientIP: string;
}

// 全局状态
const state = {
  isDebugMode: false, // 默认关闭调试模式
  logs: [] as RequestLog[], // 日志存储
  startTime: 0, // 调试模式开始时间
};

// 初始化KV存储
let kv: Deno.Kv | null = null;
if (ENABLE_KV_STORAGE) {
  try {
    kv = await Deno.openKv();
    console.log("KV存储初始化成功");
  } catch (error) {
    console.error("KV存储初始化失败:", error);
  }
}

// 添加分段日志函数
function logFullContent(prefix: string, content: string) {
  const marker = "!!!!!!!!!!!!!!!!!!!!!!!!!";
  console.log(`${marker} ${prefix} 开始 ${marker}`);
  
  // 每段最大长度
  const chunkSize = 1000;
  const chunks = Math.ceil(content.length / chunkSize);
  
  for(let i = 0; i < chunks; i++) {
    const start = i * chunkSize;
    const end = Math.min((i + 1) * chunkSize, content.length);
    console.log(`DEBUG-LOG [${i+1}/${chunks}]: ${content.slice(start, end)}`);
  }
  
  console.log(`${marker} ${prefix} 结束 (总长度: ${content.length}) ${marker}`);
}

// 保存请求日志到内存或KV存储
async function saveRequestLog(request: Request, requestBody: string, targetBody?: string) {
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
    targetBody: targetBody || requestBody, // 保存目标请求体
    clientIP: request.headers.get("x-forwarded-for") || "unknown"
  };
  
  // 保存到内存
  state.logs.unshift(logEntry);
  
  // 保持日志数不超过最大值
  if (state.logs.length > MAX_LOGS) {
    state.logs = state.logs.slice(0, MAX_LOGS);
  }
  
  // 如果启用了KV存储，也保存到KV
  if (kv) {
    try {
      // 设置10分钟过期时间
      const expirationMs = 10 * 60 * 1000; // 10分钟
      const expireAt = new Date(Date.now() + expirationMs);
      
      // 先获取现有的logIds，防止并发问题
      const existingLogIds = await kv.get<string[]>(["logIds"]);
      let newLogIds = [requestId];
      
      if (existingLogIds?.value) {
        // 确保不重复添加
        if (!existingLogIds.value.includes(requestId)) {
          newLogIds = [requestId, ...existingLogIds.value].slice(0, MAX_LOGS);
        } else {
          newLogIds = existingLogIds.value;
        }
      }
      
      // 保存日志内容
      await kv.set(["logs", requestId], logEntry, { expireAt });
      
      // 更新日志ID列表
      await kv.set(["logIds"], newLogIds, { expireAt });
      
      console.log(`日志已保存到KV存储: ${requestId}，当前总数: ${newLogIds.length}，将在${expireAt.toLocaleString()}过期`);
    } catch (error) {
      console.error("保存日志到KV存储失败:", error);
    }
  }
  
  console.log(`保存请求日志: ${requestId}`);
  return requestId;
}

// 从KV存储获取日志
async function getLogsFromKV(): Promise<RequestLog[]> {
  if (!kv) return [];
  
  try {
    const logIds = await kv.get<string[]>(["logIds"]);
    if (!logIds?.value || logIds.value.length === 0) return [];
    
    const logs: RequestLog[] = [];
    for (const id of logIds.value) {
      const log = await kv.get<RequestLog>(["logs", id]);
      if (log?.value) {
        logs.push(log.value);
      }
    }
    
    return logs;
  } catch (error) {
    console.error("从KV存储获取日志失败:", error);
    return [];
  }
}

// 清除所有请求日志
async function clearAllRequestLogs(): Promise<boolean> {
  try {
    // 清除内存中的日志
    state.logs = [];
    
    // 如果启用了KV存储，也清除KV中的日志
    if (kv) {
      const logIds = await kv.get<string[]>(["logIds"]);
      if (logIds?.value) {
        // 删除所有日志条目
        for (const id of logIds.value) {
          await kv.delete(["logs", id]);
        }
      }
      // 清空日志ID列表
      await kv.delete(["logIds"]);
    }
    
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
        
        // 简化状态显示，只显示记录数和目标URL
        statusInfo.innerHTML = \`反代目标: ${TARGET_URL}<br>已记录 \${status.logCount} 个请求\`;
        
        // 清除定时器如果存在
        if (window.durationTimer) {
          clearInterval(window.durationTimer);
          window.durationTimer = null;
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
              <div class="log-body-label">原始请求体:</div>
              <pre class="log-body">\${formatBody(log.body)}</pre>
              
              <!-- 修改目标请求体部分 - 始终显示 -->
              \${log.targetBody ? \`
                <div class="log-body-label" style="margin-top: 15px; color: #2196F3;">发往目标的请求体 \${log.targetBody === log.body ? '(与原始请求相同)' : ''}:</div>
                <pre class="log-body" style="border-left: 3px solid #2196F3;">\${formatBody(log.targetBody)}</pre>
              \` : ''}
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
    // 如果使用KV存储，获取最新的日志计数
    let logCount = state.logs.length;
    if (kv && state.isDebugMode) {
      try {
        const logIds = await kv.get<string[]>(["logIds"]);
        if (logIds?.value) {
          logCount = logIds.value.length;
        }
      } catch (error) {
        console.error("获取KV日志计数失败:", error);
      }
    }
    
    return new Response(JSON.stringify({
      isDebugMode: state.isDebugMode,
      startTime: state.startTime,
      logCount: logCount
    }), {
      headers: { "Content-Type": "application/json" }
    });
  }
  
  // 切换调试模式
  if (path === "/api/debug/toggle" && request.method === "POST") {
    state.isDebugMode = !state.isDebugMode;
    
    if (state.isDebugMode) {
      state.startTime = Date.now();
      
      // 如果使用KV存储，也保存调试状态
      if (kv) {
        // 调试状态设置较长过期时间，如12小时
        const expirationMs = 12 * 60 * 60 * 1000; 
        const expireAt = new Date(Date.now() + expirationMs);
        
        await kv.set(["debugState"], {
          isDebugMode: true,
          startTime: state.startTime
        }, { expireAt });
      }
    } else {
      state.startTime = 0;
      
      // 如果使用KV存储，更新调试状态
      if (kv) {
        await kv.set(["debugState"], {
          isDebugMode: false,
          startTime: 0
        });
      }
    }
    
    // 获取当前日志计数
    let logCount = state.logs.length;
    if (kv && state.isDebugMode) {
      try {
        const logIds = await kv.get<string[]>(["logIds"]);
        if (logIds?.value) {
          logCount = logIds.value.length;
        }
      } catch (error) {
        console.error("获取KV日志计数失败:", error);
      }
    }
    
    return new Response(JSON.stringify({
      isDebugMode: state.isDebugMode,
      startTime: state.startTime,
      logCount: logCount
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
    if (kv && state.isDebugMode) {
      // 从KV存储获取日志
      const logs = await getLogsFromKV();
      return new Response(JSON.stringify(logs), {
        headers: { "Content-Type": "application/json" }
      });
    } else {
      // 从内存获取日志
      return new Response(JSON.stringify(state.logs), {
        headers: { "Content-Type": "application/json" }
      });
    }
  } 
  // 清除所有日志
  else if (request.method === "DELETE") {
    const success = await clearAllRequestLogs();
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
    
    console.log(`DEBUG: 转发请求到: ${targetUrl.toString()}`);
    
    // 创建代理请求
    const headers = new Headers(request.headers);
    headers.delete('host'); // 删除host头，以防干扰目标服务器
    
    // 如果需要记录请求体内容
    let requestBody = "";
    let requestBodyToSend = null;
    
    if (state.isDebugMode && request.method !== "GET" && request.method !== "HEAD") {
      try {
        console.log("DEBUG: 准备读取和处理请求体");
        
        // 克隆请求以便可以多次读取body
        const requestClone = request.clone();
        requestBody = await requestClone.text();
        
        console.log(`DEBUG: 成功读取请求体，长度: ${requestBody.length}`);
        
        // 记录原始请求内容
        logFullContent("原始请求体", requestBody);
        
        // 为了测试目的，给目标请求体添加一个标记
        try {
          // 如果是JSON请求体，尝试修改它
          const parsedBody = JSON.parse(requestBody);
          
          // 添加一个调试字段
          parsedBody._debug_info = "这是发送到目标服务器的修改版请求体";
          
          // 重新序列化
          requestBodyToSend = JSON.stringify(parsedBody);
        } catch (e) {
          // 如果不是JSON，直接使用原请求体
          console.log("请求体不是JSON格式，不做修改");
          requestBodyToSend = requestBody;
        }
        
        // 记录日志
        await saveRequestLog(request, requestBody, requestBodyToSend);
        
        // 确保单独一行打印出来便于查看
        console.log("\n\n");
        console.log("============= 发送到目标的请求体 =============");
        console.log(requestBodyToSend);
        console.log("================================================");
        console.log("\n\n");
      } catch (error) {
        console.error("DEBUG: 读取请求体失败:", error);
      }
    } else {
      console.log(`DEBUG: 跳过请求体处理 (调试模式: ${state.isDebugMode}, 方法: ${request.method})`);
    }

    console.log("DEBUG: 准备发送请求到目标服务器");
    
    // 发送请求到目标服务器
    const response = await fetch(targetUrl.toString(), {
      method: request.method,
      headers: headers,
      body: requestBodyToSend !== null ? requestBodyToSend : request.body,
      redirect: 'follow'
    });
    
    console.log(`DEBUG: 目标服务器响应状态: ${response.status}`);
    
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
    console.error('DEBUG: 代理请求失败:', error);
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
  const method = request.method;
  
  console.log(`收到请求: ${method} ${path}`);
  
  // 处理OPTIONS请求
  if (method === "OPTIONS") {
    return handleOptionsRequest();
  }
  
  // ===== 调试页面 - 提供可视化界面 =====
  if (path === "/debug" || path === "/debug/") {
    console.log("提供调试界面");
    return new Response(getHtmlIndex(), {
      headers: { "Content-Type": "text/html; charset=utf-8" }
    });
  }
  
  // ===== API请求处理 =====
  if (path.startsWith("/api/")) {
    // 调试API
    if (path.startsWith("/api/debug/")) {
      return handleDebugApi(request, path);
    }
    
    // 日志API
    if (path === "/api/logs") {
      return handleLogsApi(request);
    }
    
    // 未找到API路由
    return new Response(JSON.stringify({ error: "未找到API路由" }), {
      status: 404,
      headers: { "Content-Type": "application/json" }
    });
  }
  
  // ===== 代理请求处理 =====
  return handleProxy(request);
}

// 初始化KV状态
async function initState() {
  if (kv) {
    try {
      // 从KV存储中恢复调试状态
      const debugState = await kv.get<{isDebugMode: boolean, startTime: number}>(["debugState"]);
      if (debugState?.value) {
        state.isDebugMode = debugState.value.isDebugMode;
        state.startTime = debugState.value.startTime;
        console.log(`从KV恢复调试状态: isDebugMode=${state.isDebugMode}, startTime=${state.startTime}`);
      }
    } catch (error) {
      console.error("从KV恢复状态失败:", error);
    }
  }
}

// 初始化状态并启动服务器
await initState();
