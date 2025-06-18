/// <reference lib="deno.unstable" />
import { serve } from "https://deno.land/std@0.220.1/http/server.ts";

// 配置
let TARGET_URL = Deno.env.get("TARGET_URL") || "https://generativelanguage.googleapis.com"; // 默认反代目标
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
  responseBody?: string;  // 新增：目标服务器响应内容
  responseStatus?: number; // 新增：响应状态码
  clientIP: string;
}

// 全局状态
const state = {
  isDebugMode: false, // 默认关闭调试模式
  logs: [] as RequestLog[], // 日志存储
};

// 初始化KV存储
let kv: Deno.Kv | null = null;
if (ENABLE_KV_STORAGE) {
  try {
    kv = await Deno.openKv();
  } catch (error) {
    console.error("KV存储初始化失败:", error);
  }
}

// 统一使用一个常量
const KV_EXPIRATION_MS = 12 * 60 * 60 * 1000; // 12小时
const expireAt = new Date(Date.now() + KV_EXPIRATION_MS);

// 添加分段日志函数
function logFullContent(prefix: string, content: string) {
  // 在非调试模式下不执行日志记录
  if (!state.isDebugMode) return;
  
  // 使用更简洁的标记
  console.log(`--- ${prefix} 开始 ---`);
  
  // 每段最大长度
  const chunkSize = 1000;
  const chunks = Math.ceil(content.length / chunkSize);
  
  for(let i = 0; i < chunks; i++) {
    const start = i * chunkSize;
    const end = Math.min((i + 1) * chunkSize, content.length);
    console.log(`${prefix} [${i+1}/${chunks}]: ${content.slice(start, end)}`);
  }
  
  console.log(`--- ${prefix} 结束 (总长度: ${content.length}) ---`);
}

// 添加处理base64内容的函数
function compressContent(content: string): string {
  if (!content) return content;

  try {
    // 检测并替换可能的base64段
    // 匹配至少80个连续的base64字符
    const base64Regex = /[A-Za-z0-9+/=]{80,}/g;
    
    // 替换为压缩提示，并计数
    let compressedContent = content;
    const matches = content.match(base64Regex) || [];
    
    if (matches.length > 0) {
      // 替换每个匹配项
      matches.forEach((match, index) => {
        const placeholder = `[base64内容 #${index+1}, 长度: ${match.length}字符]`;
        compressedContent = compressedContent.replace(match, placeholder);
      });
      
      console.log(`已压缩 ${matches.length} 个base64片段，节省约 ${Math.floor(matches.join('').length / 1024)} KB`);
    }
    
    return compressedContent;
  } catch (error) {
    console.error("压缩内容时出错:", error);
    return content; // 发生错误时返回原始内容
  }
}

// 保存请求日志到内存或KV存储
async function saveRequestLog(
  request: Request, 
  requestBody: string, 
  responseBody?: string,
  responseStatus?: number
) {
  if (!state.isDebugMode) return null; // 不在调试模式，不保存日志
  
  const timestamp = Date.now();
  const requestId = `${timestamp}-${Math.random().toString(36).substring(2, 15)}`;
  const url = new URL(request.url);
  
  // 压缩请求体和响应体
  const compressedRequestBody = compressContent(requestBody);
  const compressedResponseBody = responseBody ? compressContent(responseBody) : undefined;
  
  const logEntry: RequestLog = {
    id: requestId,
    timestamp,
    method: request.method,
    url: request.url,
    path: url.pathname,
    headers: Object.fromEntries(request.headers.entries()),
    body: compressedRequestBody, // 使用压缩后的请求体
    responseBody: compressedResponseBody, // 使用压缩后的响应体
    responseStatus,
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
      // 应用到所有KV存储
      await kv.set(["debugState"], {
        isDebugMode: true,
      }, { expireAt });
      
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
      try {
        // 清空日志ID列表
        await kv.delete(["logIds"]);
        
        // 直接扫描并删除所有logs前缀的键
        const logEntries = kv.list({ prefix: ["logs"] });
        for await (const entry of logEntries) {
          await kv.delete(entry.key);
        }
        
        // 更新调试状态，但保持isDebugMode的值不变
        await kv.set(["debugState"], {
          isDebugMode: state.isDebugMode,
        }, { expireAt });
        
      } catch (error) {
        console.error("KV操作失败:", error);
        return false;
      }
    }
    
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
    /* 复制按钮样式优化 */
    .copy-button {
      position: absolute;
      top: 5px;
      right: 25px; /* 移到滚动条左侧 */
      background-color: #e9f5ff;
      border: 1px solid #c8e1ff;
      border-radius: 4px;
      padding: 3px 8px;
      font-size: 12px;
      cursor: pointer;
      opacity: 0.7;
      transition: all 0.3s;
      display: flex;
      align-items: center;
      color: #0366d6;
    }
    
    .copy-button:hover {
      opacity: 1;
      background-color: #daeeff;
    }
    
    /* 添加复制图标 */
    .copy-button::before {
      content: "📋";
      margin-right: 4px;
      font-size: 14px;
    }
    
    /* 复制成功提示优化 */
    .copy-feedback {
      position: absolute;
      top: 5px;
      right: 90px; /* 调整位置 */
      background-color: #28a745;
      color: white;
      padding: 3px 10px;
      border-radius: 4px;
      font-size: 12px;
      opacity: 0;
      transition: opacity 0.3s;
      box-shadow: 0 2px 4px rgba(0,0,0,0.2);
    }
    
    .copy-feedback.show {
      opacity: 1;
    }
    
    /* 在悬停时才显示按钮 */
    .log-body-container {
      position: relative;
    }
    
    .log-body-container .copy-button {
      opacity: 0.3;
    }
    
    .log-body-container:hover .copy-button {
      opacity: 0.8;
    }

    .status-info-container {
      display: flex;
      flex-direction: column;
      align-items: flex-end;
      gap: 8px;
    }

    .proxy-target-form {
      display: flex;
      align-items: center;
      gap: 8px;
    }

    .proxy-target-form input {
      width: 300px;
      padding: 6px 10px;
      border: 1px solid #ddd;
      border-radius: 4px;
    }

    .proxy-target-form button {
      padding: 6px 12px;
      margin: 0;
    }

    /* 响应式设计调整 */
    @media (max-width: 768px) {
      .status-bar {
        flex-direction: column;
        align-items: flex-start;
      }
      
      .status-info-container {
        width: 100%;
        align-items: flex-start;
        margin-top: 10px;
      }
      
      .proxy-target-form {
        width: 100%;
      }
      
      .proxy-target-form input {
        flex-grow: 1;
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
    <div class="status-info-container">
      <div class="status-info" id="statusInfo">
        反代目标: ${TARGET_URL}
      </div>
      <div class="proxy-target-form">
        <input type="text" id="proxyTargetInput" placeholder="输入新的代理目标URL" value="${TARGET_URL}">
        <button id="saveProxyTargetBtn">保存</button>
      </div>
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
        
        statusInfo.innerHTML = \`反代目标: \${status.targetUrl}<br>已记录 \${status.logCount} 个请求\`;
      } else {
        statusDot.classList.remove('active');
        statusText.textContent = '调试模式已关闭';
        toggleBtn.textContent = '开启调试';
        toggleBtn.classList.remove('toggle-off');
        statusInfo.innerHTML = \`反代目标: \${status.targetUrl}\`;
      }
      
      // 同时更新输入框的值，确保它与当前代理目标一致
      document.getElementById('proxyTargetInput').value = status.targetUrl || TARGET_URL;
    }
    
    // 复制文本到剪贴板
    function copyToClipboard(text, buttonId) {
      navigator.clipboard.writeText(text).then(() => {
        // 显示复制成功提示
        const button = document.getElementById(buttonId);
        const feedback = button.nextElementSibling;
        feedback.classList.add('show');
        
        // 2秒后隐藏提示
        setTimeout(() => {
          feedback.classList.remove('show');
        }, 2000);
      }).catch(err => {
        console.error('复制失败:', err);
        alert('复制失败，请手动复制');
      });
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
        logs.forEach((log, index) => {
          const methodClass = log.method.toLowerCase();
          const requestBodyId = \`request-body-\${index}-\${log.id}\`;
          const responseBodyId = \`response-body-\${index}-\${log.id}\`;
          const requestCopyBtnId = \`copy-request-\${index}-\${log.id}\`;
          const responseCopyBtnId = \`copy-response-\${index}-\${log.id}\`;
          
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
              <div class="log-body-container">
                <pre id="\${requestBodyId}" class="log-body">\${formatBody(log.body)}</pre>
                <button id="\${requestCopyBtnId}" class="copy-button" onclick="copyToClipboard(document.getElementById('\${requestBodyId}').textContent, '\${requestCopyBtnId}')">复制</button>
                <div class="copy-feedback">已复制!</div>
              </div>
              
              <!-- 添加响应内容部分 -->
              \${log.responseBody ? \`
                <div class="log-body-label" style="margin-top: 15px; color: #2196F3; font-weight: bold;">
                  目标服务器响应内容: 
                  <span style="background-color: \${log.responseStatus && log.responseStatus >= 200 && log.responseStatus < 300 ? '#e8f5e9' : '#ffebee'}; padding: 3px 6px; border-radius: 4px; font-size: 0.85em;">
                    状态码: \${log.responseStatus || '未知'}
                  </span>
                </div>
                <div class="log-body-container">
                  <pre id="\${responseBodyId}" class="log-body" style="border-left: 4px solid #2196F3;">\${formatBody(log.responseBody)}</pre>
                  <button id="\${responseCopyBtnId}" class="copy-button" onclick="copyToClipboard(document.getElementById('\${responseBodyId}').textContent, '\${responseCopyBtnId}')">复制</button>
                  <div class="copy-feedback">已复制!</div>
                </div>
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
    document.getElementById('saveProxyTargetBtn').addEventListener('click', saveProxyTarget);
    
    // 页面加载完成后初始化
    window.onload = init;

    // 保存代理目标设置
    async function saveProxyTarget() {
      const targetInput = document.getElementById('proxyTargetInput');
      const newTarget = targetInput.value.trim();
      
      if (!newTarget) {
        alert('请输入有效的代理目标URL');
        return;
      }
      
      // 验证URL格式
      try {
        new URL(newTarget);
      } catch (e) {
        alert('请输入有效的URL格式（例如: https://example.com）');
        return;
      }
      
      try {
        const response = await fetch('/api/proxy/target', {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json'
          },
          body: JSON.stringify({ targetUrl: newTarget })
        });
        
        const result = await response.json();
        
        if (result.success) {
          // 立即更新状态栏和输入框显示
          const targetUrl = result.targetUrl;
          document.getElementById('statusInfo').innerHTML = \`反代目标: \${targetUrl}\`;
          document.getElementById('proxyTargetInput').value = targetUrl;
          
          alert('代理目标已成功更改');
          
          // 如果当前在调试模式，也更新调试信息
          if (document.getElementById('statusDot').classList.contains('active')) {
            const statusResponse = await fetch('/api/debug/status');
            const status = await statusResponse.json();
            updateDebugStatus(status);
          }
        } else {
          alert(\`更改失败: \${result.error}\`);
        }
      } catch (error) {
        alert('操作失败，请重试');
        console.error('保存代理目标失败:', error);
      }
    }
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
      logCount: logCount,
      targetUrl: TARGET_URL
    }), {
      headers: { "Content-Type": "application/json" }
    });
  }
  
  // 切换调试模式
  if (path === "/api/debug/toggle" && request.method === "POST") {
    state.isDebugMode = !state.isDebugMode;
    
    if (state.isDebugMode) {
      // 如果使用KV存储，也保存调试状态
      if (kv) {
        // 应用到所有KV存储
        await kv.set(["debugState"], {
          isDebugMode: true,
        }, { expireAt });
      }
    } else {
      // 如果使用KV存储，更新调试状态
      if (kv) {
        await kv.set(["debugState"], {
          isDebugMode: false
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
      logCount: logCount,
      targetUrl: TARGET_URL
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

// 处理代理目标修改API
async function handleProxyTargetApi(request: Request): Promise<Response> {
  if (request.method === "POST") {
    try {
      const requestData = await request.json();
      const newTargetUrl = requestData.targetUrl;
      
      // 验证URL格式
      try {
        new URL(newTargetUrl);
      } catch (e) {
        return new Response(JSON.stringify({ error: "无效的URL格式" }), {
          status: 400,
          headers: { "Content-Type": "application/json" }
        });
      }
      
      // 更新全局设置
      const oldTargetUrl = TARGET_URL;
      TARGET_URL = newTargetUrl;
      
      // 如果启用了KV存储，也保存到KV
      if (kv) {
        await kv.set(["proxyConfig"], { targetUrl: newTargetUrl });
      }
      
      console.log(`代理目标已从 ${oldTargetUrl} 更改为 ${newTargetUrl}`);
      
      return new Response(JSON.stringify({ 
        success: true, 
        message: "代理目标已更改",
        targetUrl: newTargetUrl
      }), {
        headers: { "Content-Type": "application/json" }
      });
    } catch (error) {
      return new Response(JSON.stringify({ 
        error: "处理请求失败",
        message: error.message 
      }), {
        status: 500,
        headers: { "Content-Type": "application/json" }
      });
    }
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
    
    // 只在调试模式下才执行详细的日志记录和处理
    if (!state.isDebugMode) {
      // 如果非调试模式，直接转发，不进行任何日志记录
      return fetch(targetUrl.toString(), {
        method: request.method,
        headers: request.headers,
        body: request.body,
        redirect: 'follow'
      });
    }

    // --- 以下为调试模式下的逻辑 ---
    console.log(`[调试模式] 转发请求到: ${targetUrl.toString()}`);

    // 克隆请求以备后续操作
    const requestForLog = request.clone();
    
    let requestBodyText = "[请求体未读取或非文本类型]";
    let loggable = true; // 默认所有请求都应被记录

    if (request.method !== "GET" && request.method !== "HEAD" && request.body) {
      try {
        console.log("[调试模式] 尝试读取请求体...");
        const bodyBuffer = await request.clone().arrayBuffer();
        // 尝试用UTF-8解码，如果失败则认为是二进制
        if (bodyBuffer.byteLength > 0) {
            try {
                requestBodyText = new TextDecoder("utf-8", { fatal: true }).decode(bodyBuffer);
                console.log("[调试模式] 请求体读取成功 (文本)。");
                logFullContent("原始请求体", requestBodyText);
            } catch {
                requestBodyText = `[二进制请求体, 大小: ${bodyBuffer.byteLength} 字节]`;
                console.log("[调试模式] 请求体读取为二进制。");
            }
        } else {
            requestBodyText = "[请求体为空]";
            console.log("[调试模式] 请求体为空。");
        }
      } catch (error) {
        requestBodyText = `[!!! 读取请求体失败: ${error.message}]`;
        console.error("[调试模式] 读取请求体时发生严重错误:", error);
      }
    } else {
      requestBodyText = "[无请求体 (GET/HEAD 或 body 为空)]";
    }

    // 发送请求到目标服务器 (使用原始的 request 对象)
    const response = await fetch(targetUrl.toString(), {
      method: request.method,
      headers: request.headers,
      body: request.body,
      redirect: 'follow'
    });
    
    console.log(`[调试模式] 目标服务器响应状态: ${response.status}`);
    
    // 准备记录响应体
    let responseBodyText = "[响应体未读取]";
    const responseClone = response.clone();

    try {
        const bodyBuffer = await responseClone.arrayBuffer();
        if (bodyBuffer.byteLength > 0) {
            try {
                responseBodyText = new TextDecoder("utf-8", { fatal: true }).decode(bodyBuffer);
                logFullContent("目标服务器的响应内容", responseBodyText);
            } catch {
                responseBodyText = `[二进制响应体, 大小: ${bodyBuffer.byteLength} 字节]`;
            }
        } else {
            responseBodyText = "[响应体为空]";
        }
    } catch (error) {
        responseBodyText = `[!!! 读取响应体失败: ${error.message}]`;
        console.error("[调试模式] 读取响应体失败:", error);
    }
    
    // **关键修改：无论如何都保存日志**
    if (loggable) {
      await saveRequestLog(requestForLog, requestBodyText, responseBodyText, response.status);
    }
    
    // 返回克隆的响应，因为原始响应的 body 可能已被读取
    return new Response(response.body, {
      status: response.status,
      statusText: response.statusText,
      headers: new Headers(response.headers)
    });

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
  const method = request.method;
  
  // 只在调试模式下记录请求信息
  if (state.isDebugMode) {
    console.log(`收到请求: ${method} ${path}`);
  }
  
  // 处理OPTIONS请求
  if (method === "OPTIONS") {
    return handleOptionsRequest();
  }
  
  // ===== 调试页面 - 提供可视化界面 =====
  if (path === "/debug" || path === "/debug/") {
    if (state.isDebugMode) {
      console.log("提供调试界面");
    }
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
    
    // 代理目标API
    if (path === "/api/proxy/target") {
      return handleProxyTargetApi(request);
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
      const debugState = await kv.get<{isDebugMode: boolean}>(["debugState"]);
      if (debugState?.value) {
        state.isDebugMode = debugState.value.isDebugMode;
        console.log(`从KV恢复调试状态: isDebugMode=${state.isDebugMode}`);
      }
      
      // 从KV存储中恢复代理目标设置
      const proxyConfig = await kv.get<{targetUrl: string}>(["proxyConfig"]);
      if (proxyConfig?.value?.targetUrl) {
        TARGET_URL = proxyConfig.value.targetUrl;
        console.log(`从KV恢复代理目标: ${TARGET_URL}`);
      }
    } catch (error) {
      console.error("从KV恢复状态失败:", error);
    }
  }
}

// 初始化状态并启动服务器
await initState();

// 服务器启动
if (state.isDebugMode) {
  console.log(`启动反代服务器，目标: ${TARGET_URL}`);
}
Deno.serve({
  onListen: ({ port }) => {
    if (state.isDebugMode) {
      console.log(`服务器监听端口: ${port}`);
    }
  },
}, async (request: Request) => {
  try {
    return await handleRequest(request);
  } catch (error) {
    console.error(`请求处理出错:`, error);
    return new Response("Internal Server Error", { status: 500 });
  }
});
