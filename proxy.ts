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
        const data = JSON.parse(event.data);
        
        switch(data.type) {
          case 'log':
            logs.push(data);
            if (shouldShowLog(data)) {
              addLogToDisplay(data);
            }
            break;
          case 'status':
            updateDebugStatus(data.debugMode);
            logs = data.logs || [];
            renderLogs();
            requestCount = data.requestCount || 0;
            requestCounter.textContent = \`请求数: \${requestCount}\`;
            break;
          case 'debugUpdate':
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
      ws.send(JSON.stringify({
        type: 'setDebug',
        enabled: debugToggle.checked
      }));
    });
    
    clearLogsBtn.addEventListener('click', () => {
      ws.send(JSON.stringify({ type: 'clearLogs' }));
    });
    
    logFilter.addEventListener('input', renderLogs);
    
    // 初始连接
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
  for (const client of webSocketClients) {
    if (client.readyState === WebSocket.OPEN) {
      client.send(message);
    }
  }
}

// 辅助函数：记录请求或响应数据
async function logData(label: string, data: Request | Response) {
  if (!isDebugMode) return;
  
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

async function handleWebSocket(request: Request): Promise<Response> {
  const { socket, response } = Deno.upgradeWebSocket(request);
  
  socket.onopen = () => {
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
    webSocketClients.delete(socket);
  };
  
  socket.onmessage = (event) => {
    try {
      const message = JSON.parse(event.data);
      
      switch (message.type) {
        case 'setDebug':
          isDebugMode = message.enabled;
          // 通知所有客户端调试状态变更
          for (const client of webSocketClients) {
            if (client.readyState === WebSocket.OPEN) {
              client.send(JSON.stringify({
                type: 'debugUpdate',
                debugMode: isDebugMode
              }));
            }
          }
          break;
        case 'clearLogs':
          logEntries.length = 0;
          // 通知所有客户端清空日志
          for (const client of webSocketClients) {
            if (client.readyState === WebSocket.OPEN) {
              client.send(JSON.stringify({ type: 'clearLogs' }));
            }
          }
          break;
        case 'getStatus':
          socket.send(JSON.stringify({
            type: 'status',
            debugMode: isDebugMode,
            logs: logEntries,
            requestCount: logEntries.filter(entry => entry.category === 'request').length
          }));
          break;
      }
    } catch (e) {
      console.error("Error processing WebSocket message:", e);
    }
  };
  
  return response;
}

async function handleRequest(request: Request): Promise<Response> {
  const url = new URL(request.url);
  
  // 处理Web界面请求
  if (url.pathname === "/debug") {
    return new Response(HTML_CONTENT, {
      headers: { "Content-Type": "text/html" }
    });
  }
  
  // 处理WebSocket连接
  if (url.pathname === "/ws") {
    return handleWebSocket(request);
  }
  
  // 处理API反向代理
  const targetUrl = new URL(target + url.pathname + url.search);

  // 记录收到的请求
  if (isDebugMode) {
    await logData("收到的客户端请求", request);
  }

  // 构建新的请求
  const newRequest = new Request(targetUrl.toString(), {
    method: request.method,
    headers: request.headers,
    body: request.body,
    redirect: "manual", // 避免自动重定向
  });
    
  // 设置访问权限
  const corsHeaders = new Headers({
    "Access-Control-Allow-Origin": "*", // 允许所有来源, 生产环境应限制
    "Access-Control-Allow-Methods": "GET, POST, PUT, DELETE, OPTIONS", // 允许的方法
    "Access-Control-Allow-Headers": "Content-Type, Authorization", // 允许的头部
  });

  if (request.method === "OPTIONS") {
    return new Response(null, {
      status: 204,
      headers: corsHeaders,
    });
  }

  // 发送请求到目标服务器
  try {
    // 记录发送到Google的请求
    if (isDebugMode) {
      await logData("发送到Google的请求", newRequest);
    }
    
    const response = await fetch(newRequest);
    
    // 记录来自Google的响应
    if (isDebugMode) {
      await logData("来自Google的响应", response);
    }

    // 复制响应，并添加 CORS 头部
    const newResponse = new Response(response.body, {
      status: response.status,
      statusText: response.statusText,
      headers: new Headers(response.headers),
    });
      
    // 为每个回复都加上访问权限
    corsHeaders.forEach((value, key) => {
      newResponse.headers.append(key, value);
    });

    return newResponse;

  } catch (error) {
    console.error("Error during fetch:", error);
    if (isDebugMode) {
      broadcastLog('error', `<strong>错误：</strong><pre>${error.message || '未知错误'}</pre>`);
    }
    return new Response("Internal Server Error", { status: 500 });
  }
}

// 启动服务器
console.log(`调试面板可在 http://localhost:8080/debug 访问`);
console.log(`调试模式: ${isDebugMode ? '已启用' : '已禁用'}`);
serve(handleRequest, { port: 8080 }); 
