import { serve } from "https://deno.land/std@0.210.0/http/server.ts";

const target = "https://generativelanguage.googleapis.com";

async function handleRequest(request: Request): Promise<Response> {
  const url = new URL(request.url);
  const targetUrl = new URL(target + url.pathname + url.search);

  // 构建新的请求
  const newRequest = new Request(targetUrl.toString(), {
    method: request.method,
    headers: request.headers,
    body: request.body,
    redirect: "manual", // 避免自动重定向
  });
    
    //设置访问权限
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
    const response = await fetch(newRequest);

    // 复制响应，并添加 CORS 头部
      const newResponse = new Response(response.body, {
        status: response.status,
        statusText: response.statusText,
        headers: new Headers(response.headers),
    });
      
      //为每个回复都加上访问权限
      corsHeaders.forEach((value, key) => {
        newResponse.headers.append(key, value);
      });

    return newResponse;

  } catch (error) {
    console.error("Error during fetch:", error);
    return new Response("Internal Server Error", { status: 500 });
  }
}

// 启动服务器
serve(handleRequest, { port: 8080 });
console.log("Proxy server running on http://localhost:8080");

