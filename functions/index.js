export async function onRequest(context) {
  // 数据源
  const SOURCE_URL = "https://pixiv-api.wrnm.dpdns.org/pe_pixiv.json";
  const USER_AGENT = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/115.0.0.0 Safari/537.36";
  
  // -------------------------------------------------------
  // 修改点 A: 引入 Cloudflare 缓存 API
  // -------------------------------------------------------
  const cache = caches.default;
  const request = context.request;

  // 1. 尝试从缓存中读取
  // 这里的 request 包含 URL，如果 URL 相同，就会命中缓存
  const cachedResponse = await cache.match(request);
  if (cachedResponse) {
    console.log("Hit cache");
    return cachedResponse;
  }

  try {
    // -------------------------------------------------------
    // 修改点 B: 移除时间戳，允许 JSON 源也被 Cloudflare 短暂缓存
    // -------------------------------------------------------
    // 如果你希望源列表也缓存一点时间（减少对源站 JSON 的请求），去掉 ?t=...
    // 如果你坚持要最新的列表，可以保留 ?t=...，但这不影响最终图片的 1 小时缓存
    const jsonUrl = SOURCE_URL; 

    const jsonResponse = await fetch(jsonUrl, {
      headers: { "User-Agent": USER_AGENT },
      cf: {
        // 修改点 C: 允许 Cloudflare 缓存这个 JSON 请求 1 小时 (3600秒)
        // 这样不用每次都去源站拉 JSON 列表
        cacheTtl: 3600,
        cacheEverything: true
      }
    });

    if (!jsonResponse.ok) return new Response("Error fetching source", { status: 502 });
    
    const data = await jsonResponse.json();
    if (!data.data || data.data.length === 0) return new Response("No data", { status: 404 });

    // 随机逻辑
    const item = data.data[Math.floor(Math.random() * data.data.length)];
    const imageUrl = item.urls.regular;

    // 代理图片
    const imageResponse = await fetch(imageUrl, {
      headers: {
        "Referer": "https://www.pixiv.net/",
        "User-Agent": USER_AGENT
      }
    });

    // -------------------------------------------------------
    // 修改点 D: 设置允许缓存的响应头
    // -------------------------------------------------------
    const newHeaders = new Headers(imageResponse.headers);
    newHeaders.set("Access-Control-Allow-Origin", "*");
    
    // 核心修改：设置为缓存 1 小时 (3600秒)
    // s-maxage 控制 CDN 缓存，max-age 控制浏览器缓存
    newHeaders.set("Cache-Control", "public, max-age=3600, s-maxage=3600");
    
    // 移除之前的禁止缓存头
    newHeaders.delete("Pragma");
    newHeaders.delete("Expires");

    // 重构 Response 对象
    const response = new Response(imageResponse.body, {
      status: imageResponse.status,
      headers: newHeaders
    });

    // -------------------------------------------------------
    // 修改点 E: 将结果写入 Cloudflare 缓存
    // context.waitUntil 确保请求结束后缓存操作继续完成
    // -------------------------------------------------------
    context.waitUntil(cache.put(request, response.clone()));

    return response;

  } catch (err) {
    return new Response(err.message, { status: 500 });
  }
}
