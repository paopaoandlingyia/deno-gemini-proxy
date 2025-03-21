import { serve } from "https://deno.land/std@0.210.0/http/server.ts";

const target = "https://generativelanguage.googleapis.com";
// 全局变量，存储调试状态和日志
let isDebugMode = Deno.env.get("DEBUG") === "true";
const logEntries: any[] = [];
const webSocketClients = new Set<WebSocket>();

// HTML 界面
const HTML_CONTENT = `<!DOCTYPE html>
<html lang="zh">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>Gemini API 代理调试器</title>
  <style>
    body {
      font-family: 'Segoe UI', Tahoma, Geneva, Verdana, sans-serif;
      margin: 0;
      padding: 20px;
      background-color: #f5f5f5;
    }
    .container {
      max-width: 1200px;
      margin: 0 auto;
      background: white;
      border-radius: 8px;
      box-shadow: 0 2px 10px rgba(0,0,0,0.1);
      padding: 20px;
    }
    h1 {
      color: #333;
      border-bottom: 1px solid #eee;
      padding-bottom: 10px;
      margin-top: 0;
    }
    .controls {
      display: flex;
      gap: 10px;
      margin-bottom: 20px;
      align-items: center;
      flex-wrap: wrap;
    }
    button {
      padding: 8px 16px;
      border: none;
      border-radius: 4px;
      background-color: #4285f4;
      color: white;
      cursor: pointer;
      font-weight: 500;
      transition: background-color 0.3s;
    }
    button:hover {
      background-color: #3367d6;
    }
    button.clear {
      background-color: #db4437;
    }
    button.clear:hover {
      background-color: #c53929;
    }
    button.test {
      background-color: #fbbc04;
    }
    button.test:hover {
      background-color: #f9ab00;
    }
    .switch {
      position: relative;
      display: inline-block;
      width: 60px;
      height: 34px;
    }
    .switch input {
      opacity: 0;
      width: 0;
      height: 0;
    }
    .slider {
      position: absolute;
      cursor: pointer;
      top: 0;
      left: 0;
      right: 0;
      bottom: 0;
      background-color: #ccc;
      transition: .4s;
      border-radius: 34px;
    }
    .slider:before {
      position: absolute;
      content: "";
      height: 26px;
      width: 26px;
      left: 4px;
      bottom: 4px;
      background-color: white;
      transition: .4s;
      border-radius: 50%;
    }
    input:checked + .slider {
      background-color: #34a853;
    }
    input:checked + .slider:before {
      transform: translateX(26px);
    }
    .status {
      font-weight: 500;
      margin-left: 10px;
    }
    #logs {
      border: 1px solid #eee;
      padding: 15px;
      border-radius: 4px;
      height: 500px;
      overflow-y: auto;
      background-color: #f9f9f9;
      font-family: monospace;
      white-space: pre-wrap;
      font-size: 14px;
    }
    .log-entry {
      margin-bottom: 15px;
      padding-bottom: 15px;
      border-bottom: 1px dashed #ddd;
    }
    .log-entry.request {
      color: #4285f4;
    }
    .log-entry.response {
      color: #34a853;
    }
    .log-entry.error {
      color: #db4437;
    }
    .timestamp {
      color: #888;
      font-size: 12px;
    }
    pre {
      margin: 5px 0;
      background-color: #f0f0f0;
      padding: 8px;
      border-radius: 4px;
      overflow-x: auto;
    }
    .filter {
      padding: 8px;
      border: 1px solid #ddd;
      border-radius: 4px;
      margin-left: auto;
      width: 200px;
    }
    .status-bar {
      display: flex;
      align-items: center;
      margin-top: 10px;
      font-size: 14px;
      color: #666;
    }
    .connection-status {
      margin-right: 15px;
    }
    .connection-indicator {
      display: inline-block;
      width: 10px;
      height: 10px;
      border-radius: 50%;
      background-color: grey;
      margin-right: 5px;
    }
    .connected {
      background-color: #34a853;
    }
  </style>
</head>
<body>
  <div class="container">
    <h1>Gemini API 代理调试器</h1>
    
    <div class="controls">
      <label class="switch">
        <input type="checkbox" id="debugToggle">
        <span class="slider"></span>
      </label>
      <span class="status">调试模式：<span id="debugStatus">关闭</span></span>
      
      <button class="clear" id="clearLogs">清除日志</button>
      <button class="test" id="testRequest">发送测试请求</button>
      <input type="text" class="filter" id="logFilter" placeholder="过滤关键词...">
    </div>
    
    <div id="logs"></div>
    
    <div class="status-bar">
      <div class="connection-status">
        <span class="connection-indicator" id="connectionIndicator"></span>
        <span id="connectionStatus">未连接</span>
      </div>
      <div id="requestCounter">请求数: 0</div>
    </div>
  </div>

  <script>
    const logsContainer = document.getElementById('logs');
    const debugToggle = document.getElementById('debugToggle');
    const debugStatus = document.getElementById('debugStatus');
    const clearLogsBtn = document.getElementById('clearLogs');
    const testRequestBtn = document.getElementById('testRequest');
    const logFilter = document.getElementById('logFilter');
    const connectionStatus = document.getElementById('connectionStatus');
    const connectionIndicator = document.getElementById('connectionIndicator');
    const requestCounter = document.getElementById('requestCounter');
    
    let logs = [];
    let requestCount = 0;
    let ws;
    
    // 建立WebSocket连接
    function connectWebSocket() {
      const protocol = window.location.protocol === 'https:' ? 'wss:' : 'ws:';
      ws = new WebSocket(\`\${protocol}//\${window.location.host}/ws\`);
      
      ws.onopen = () => {
        connectionStatus.textContent = '已连接';
        connectionIndicator.classList.add('connected');
        // 连接后请求当前状态
        ws.send(JSON.stringify({ type: 'getStatus' }));
        console.log("WebSocket已连接，发送状态请求");
      };
      
      ws.onclose = () => {
        connectionStatus.textContent = '连接断开，尝试重连...';
        connectionIndicator.classList.remove('connected');
        setTimeout(connectWebSocket, 3000);
      };
      
      ws.onerror = (error) => {
        console.error('WebSocket错误:', error);
      };
      
      ws.onmessage = (event) => {
        console.log("收到服务器消息", event.data);
        const data = JSON.parse(event.data);
        
        switch(data.type) {
          case 'log':
            logs.push(data);
            if (shouldShowLog(data)) {
              addLogToDisplay(data);
            }
            break;
          case 'status':
            console.log("收到状态更新", data);
            updateDebugStatus(data.debugMode);
            logs = data.logs || [];
            renderLogs();
            requestCount = data.requestCount || 0;
            requestCounter.textContent = \`请求数: \${requestCount}\`;
            break;
          case 'debugUpdate':
            console.log("收到调试模式更新", data);
            updateDebugStatus(data.debugMode);
            break;
          case 'clearLogs':
            logs = [];
            logsContainer.innerHTML = '';
            break;
        }
      };
    }
    
    function updateDebugStatus(isEnabled) {
      console.log("更新调试状态UI", isEnabled);
      debugToggle.checked = isEnabled;
      debugStatus.textContent = isEnabled ? '开启' : '关闭';
    }
    
    function addLogToDisplay(logData) {
      const logEntry = document.createElement('div');
      logEntry.className = \`log-entry \${logData.category || ''}\`;
      
      const timestamp = document.createElement('div');
      timestamp.className = 'timestamp';
      timestamp.textContent = new Date(logData.timestamp).toLocaleTimeString();
      
      const content = document.createElement('div');
      content.innerHTML = logData.content;
      
      logEntry.appendChild(timestamp);
      logEntry.appendChild(content);
      
      logsContainer.appendChild(logEntry);
      logsContainer.scrollTop = logsContainer.scrollHeight;
      
      if (logData.category === 'request') {
        requestCount++;
        requestCounter.textContent = \`请求数: \${requestCount}\`;
      }
    }
    
    function shouldShowLog(logData) {
      const filterText = logFilter.value.toLowerCase();
      if (!filterText) return true;
      
      return logData.content.toLowerCase().includes(filterText);
    }
    
    function renderLogs() {
      logsContainer.innerHTML = '';
      logs.filter(shouldShowLog).forEach(addLogToDisplay);
    }
    
    // 事件监听
    debugToggle.addEventListener('change', () => {
      console.log("调试开关切换为", debugToggle.checked);
      ws.send(JSON.stringify({
        type: 'setDebug',
        enabled: debugToggle.checked
      }));
    });
    
    clearLogsBtn.addEventListener('click', () => {
      ws.send(JSON.stringify({ type: 'clearLogs' }));
    });
    
    // 添加测试请求按钮事件
    testRequestBtn.addEventListener('click', () => {
      console.log("发送测试请求");
      ws.send(JSON.stringify({ type: 'testRequest' }));
    });
    
    logFilter.addEventListener('input', renderLogs);
    
    // 初始连接
    console.log("页面加载完成，开始WebSocket连接");
    connectWebSocket();
  </script>
</body>
</html>`;

// 辅助函数：发送日志到所有WebSocket客户端
function broadcastLog(category: string, content: string) {
  const logEntry = {
    type: 'log',
    category,
    content,
    timestamp: new Date().toISOString()
  };
  
  logEntries.push(logEntry);
  
  // 广播到所有连接的客户端
  const message = JSON.stringify(logEntry);
  console.log(`正在广播消息到 ${webSocketClients.size} 个客户端`);
  for (const client of webSocketClients) {
    if (client.readyState === WebSocket.OPEN) {
      client.send(message);
    }
  }
}

// 辅助函数：发送状态更新到所有客户端
function broadcastStatus() {
  const statusMessage = JSON.stringify({
    type: 'status',
    debugMode: isDebugMode,
    logs: logEntries,
    requestCount: logEntries.filter(entry => entry.category === 'request').length
  });
  
  console.log(`广播状态更新: 调试模式=${isDebugMode}`);
  
  for (const client of webSocketClients) {
    if (client.readyState === WebSocket.OPEN) {
      client.send(statusMessage);
    }
  }
}

// 辅助函数：记录请求或响应数据
async function logData(label: string, data: Request | Response) {
  if (!isDebugMode) return;
  
  // 新增流状态检测
  console.log(`[诊断] ${label} body可读状态:`, {
    bodyUsed: data.bodyUsed,
    locked: data.body?.locked ?? false
  });
  
  let logContent = `<strong>${label}</strong><br>`;
  logContent += `${data instanceof Request ? data.method : 'RESPONSE'} ${data instanceof Request ? data.url : '(无URL)'}<br>`;
  
  // 添加头部信息
  logContent += `<strong>Headers:</strong><pre>${JSON.stringify(Object.fromEntries([...data.headers]), null, 2)}</pre>`;
  
  // 添加正文信息
  if (data.body) {
    try {
      const clone = data.clone();
      const text = await clone.text();
      try {
        // 尝试解析为JSON以美化输出
        const json = JSON.parse(text);
        logContent += `<strong>Body:</strong><pre>${JSON.stringify(json, null, 2)}</pre>`;
      } catch {
        // 如果不是JSON，直接输出文本
        logContent += `<strong>Body:</strong><pre>${text}</pre>`;
      }
    } catch (e) {
      logContent += `<strong>Body:</strong> 无法读取 (可能已被消耗)`;
    }
  } else {
    logContent += `<strong>Body:</strong> 空`;
  }
  
  // 发送日志到客户端
  broadcastLog(data instanceof Request ? 'request' : 'response', logContent);
  
  // 同时在服务器控制台输出
  console.log(`---------- ${label} ----------`);
  console.log(`${data instanceof Request ? data.method : 'RESPONSE'} ${data instanceof Request ? data.url : '(无URL)'}`);
  console.log("Headers:", JSON.stringify(Object.fromEntries([...data.headers]), null, 2));
  // 剩余的控制台日志逻辑保持不变...
}

// 记录特殊请求，无视调试模式状态
async function logSpecialRequest(label: string, data: Request | Response) {
  console.log("强制记录开始", label);
  const start = Date.now();
  
  // 强制读取body内容
  const bodyCopy = await data.clone().text().catch(e => `[读取错误] ${e.message}`);
  console.log(`请求体长度: ${bodyCopy.length} 字符`);
  
  // 原始记录逻辑
  const originalDebugMode = isDebugMode;
  isDebugMode = true;
  try {
    await logData(`[强制记录] ${label}`, data);
  } finally {
    isDebugMode = originalDebugMode;
    console.log(`记录完成，耗时 ${Date.now() - start}ms`);
  }
}

async function handleWebSocket(request: Request): Promise<Response> {
  const { socket, response } = Deno.upgradeWebSocket(request);
  
  console.log("WebSocket连接已建立");
  
  socket.onopen = () => {
    console.log("WebSocket已打开，添加到客户端列表");
    webSocketClients.add(socket);
    
    // 发送当前状态到新连接的客户端
    socket.send(JSON.stringify({
      type: 'status',
      debugMode: isDebugMode,
      logs: logEntries,
      requestCount: logEntries.filter(entry => entry.category === 'request').length
    }));
  };
  
  socket.onclose = () => {
    console.log("WebSocket已关闭，从客户端列表移除");
    webSocketClients.delete(socket);
  };
  
  socket.onmessage = (event) => {
    try {
      console.log("收到WebSocket消息:", event.data);
      const message = JSON.parse(event.data);
      
      switch (message.type) {
        case 'setDebug':
          console.log(`调试模式状态变更: ${isDebugMode} -> ${message.enabled}`);
          isDebugMode = message.enabled;
          
          // 添加一条状态变更日志
          broadcastLog('system', `<strong>调试模式已${isDebugMode ? '开启' : '关闭'}</strong>`);
          
          // 通知所有客户端调试状态变更
          broadcastStatus();
          break;
        case 'clearLogs':
          console.log("清除所有日志");
          logEntries.length = 0;
          // 通知所有客户端清空日志
          for (const client of webSocketClients) {
            if (client.readyState === WebSocket.OPEN) {
              client.send(JSON.stringify({ type: 'clearLogs' }));
            }
          }
          break;
        case 'getStatus':
          console.log("发送当前状态");
          socket.send(JSON.stringify({
            type: 'status',
            debugMode: isDebugMode,
            logs: logEntries,
            requestCount: logEntries.filter(entry => entry.category === 'request').length
          }));
          break;
        case 'testRequest':
          // 添加测试请求功能
          console.log("收到测试请求命令");
          broadcastLog('info', '<strong>手动测试请求</strong><br>这是一个模拟的API请求');
          break;
        default:
          console.log(`未知消息类型: ${message.type}`);
      }
    } catch (e) {
      console.error("Error processing WebSocket message:", e);
    }
  };
  
  return response;
}

async function handleRequest(request: Request): Promise<Response> {
  const url = new URL(request.url);
  
  console.log(`收到请求: ${request.method} ${url.pathname}`);
  
  // 立即克隆并缓冲请求体
  const requestClone = request.clone(); 
  let requestBodyText = ""; 
  try { 
    requestBodyText = await requestClone.text(); 
    console.log("成功读取请求体，长度:", requestBodyText.length); 
  } catch (e) { 
    console.error("读取请求体失败:", e); 
  } 
  
  // 规范化路径处理
  const normalizedPath = url.pathname.replace(/\/{2,}/g, '/');
  
  // 检查请求头和特征 - 仅用于日志记录，不用于过滤
  const userAgent = request.headers.get('user-agent') || '';
  const contentType = request.headers.get('content-type') || '';
  const origin = request.headers.get('origin') || '';
  
  // 记录请求信息但不进行过滤
  console.log(`请求分析: 路径=${normalizedPath}, UA=${userAgent.substring(0, 30)}`);
  console.log(`请求头:`, JSON.stringify(Object.fromEntries([...request.headers])));
  
  // 处理Web界面请求
  if (url.pathname === "/debug") {
    console.log("提供调试界面");
    return new Response(HTML_CONTENT, {
      headers: { "Content-Type": "text/html" }
    });
  }
  
  // 处理WebSocket连接
  if (url.pathname === "/ws") {
    console.log("处理WebSocket连接请求");
    try {
      return handleWebSocket(request);
    } catch (e) {
      console.error("WebSocket连接错误:", e);
      return new Response("WebSocket Error: " + e.message, { status: 500 });
    }
  }
  
  // 使用缓冲后的请求体创建可记录的请求对象
  const loggableRequest = new Request(request.url, { 
    method: request.method, 
    headers: request.headers, 
    body: requestBodyText || null 
  }); 
  
  // 记录可记录的请求对象
  await logSpecialRequest("收到的客户端请求", loggableRequest);

  // 处理API反向代理 - 直接转发所有请求
  console.log(`代理请求到: ${target}${normalizedPath}`);
  const targetUrl = new URL(target + normalizedPath + url.search);

  // 修复4：使用原始body进行转发
  const newRequest = new Request(targetUrl.toString(), {
    method: request.method,
    headers: request.headers,
    body: requestBodyText || null, 
    redirect: "manual"
  });
    
  // 设置CORS头
  const corsHeaders = {
    "Access-Control-Allow-Origin": "*",
    "Access-Control-Allow-Methods": "GET, POST, PUT, DELETE, OPTIONS",
    "Access-Control-Allow-Headers": "*", // 允许所有头部
  };

  if (request.method === "OPTIONS") {
    return new Response(null, {
      status: 204,
      headers: corsHeaders,
    });
  }

  try {
    // 记录发送到Google的请求
    await logSpecialRequest("发送到Google的请求", newRequest);
    
    const response = await fetch(newRequest);
    
    // 记录来自Google的响应
    await logSpecialRequest("来自Google的响应", response);

    // 创建新的响应头
    const newHeaders = new Headers(response.headers);
    
    // 添加CORS头
    for (const key of Object.keys(corsHeaders)) {
      newHeaders.set(key, corsHeaders[key]);
    }

    // 返回响应
    return new Response(response.body, {
      status: response.status,
      statusText: response.statusText,
      headers: newHeaders,
    });

  } catch (error) {
    console.error("请求处理错误:", error);
    broadcastLog('error', `<strong>错误：</strong><pre>${error.message || '未知错误'}</pre>`);
    return new Response("Internal Server Error", { status: 500 });
  }
}

// 启动服务器
console.log(`调试面板可在 http://localhost:8080/debug 访问`);
console.log(`调试模式: ${isDebugMode ? '已启用' : '已禁用'}`);

// 添加初始测试日志和模拟请求
setTimeout(() => {
  console.log("添加初始测试日志");
  broadcastLog('info', '<strong>系统测试</strong><br>如果您能看到此消息，WebSocket连接正常工作');
  
  // 再添加一条模拟的API请求日志
  setTimeout(() => {
    if (webSocketClients.size > 0) {
      console.log("添加模拟请求日志");
      broadcastLog('request', `<strong>模拟请求示例</strong><br>
      <strong>Headers:</strong><pre>{"Content-Type": "application/json"}</pre>
      <strong>Body:</strong><pre>{
  "contents": [
    {
      "parts": [
        {
          "text": "你好，请介绍一下自己"
        }
      ]
    }
  ]
}</pre>`);
    }
  }, 2000);
}, 5000);

serve(handleRequest, { port: 8080 }); 
