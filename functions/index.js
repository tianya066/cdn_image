export async function onRequest(context) {
  // 数据源
  const SOURCE_URL = "https://pixiv-api.wrnm.dpdns.org/pe_pixiv.json";
  const USER_AGENT = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/115.0.0.0 Safari/537.36";

  try {
    // -------------------------------------------------------
    // 修改点 1: 给 JSON URL 加上时间戳，防止 Cloudflare 内部缓存这个 fetch 请求
    // -------------------------------------------------------
    const noCacheUrl = `${SOURCE_URL}?t=${Date.now()}`;

    const jsonResponse = await fetch(noCacheUrl, {
      headers: { "User-Agent": USER_AGENT },
      cf: {
        // 尝试告诉 Cloudflare 边缘节点不要缓存此请求
        cacheTtl: 0,
        cacheEverything: false
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
    // 修改点 2: 设置严格的禁止缓存响应头
    // -------------------------------------------------------
    const newHeaders = new Headers(imageResponse.headers);
    
    // 允许跨域
    newHeaders.set("Access-Control-Allow-Origin", "*");
    
    // 核心修改：禁止任何形式的缓存
    newHeaders.set("Cache-Control", "no-store, no-cache, must-revalidate, proxy-revalidate, max-age=0");
    newHeaders.set("Pragma", "no-cache");
    newHeaders.set("Expires", "0");

    return new Response(imageResponse.body, {
      status: imageResponse.status,
      headers: newHeaders
    });

  } catch (err) {
    return new Response(err.message, { status: 500 });
  }
}
