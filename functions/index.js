export async function onRequest(context) {
  const { env, request } = context;

  // ----------------配置区域----------------
  const SOURCE_URL = "https://pixiv-api.wrnm.dpdns.org/pe_pixiv.json";
  const USER_AGENT = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/115.0.0.0 Safari/537.36";
  const DB_KEY = "pixiv_archive_db"; 
  const UPDATE_INTERVAL = 60 * 60 * 1000; // KV数据库更新间隔 (1小时进货一次)
  const EDGE_CACHE_TTL = 60 * 60 * 24 * 7; // Cloudflare边缘缓存图片内容时长 (7天)
  const BROWSER_CACHE_TTL = 3600; // [修改点] 浏览器缓存时长 (1小时)
  // ----------------------------------------

  try {
    if (!env.KV_CACHE) return new Response("Error: KV_CACHE binding not found.", { status: 500 });

    // --- 1. 获取图片列表 (KV 数据库逻辑) ---
    // 逻辑：优先读KV，如果过期则后台更新KV
    let db = await env.KV_CACHE.get(DB_KEY, { type: "json" });
    if (!db) db = { lastUpdated: 0, urls: [] };

    const now = Date.now();
    if (db.urls.length === 0 || (now - db.lastUpdated > UPDATE_INTERVAL)) {
      const updatePromise = async () => {
        try {
          const sourceResp = await fetch(SOURCE_URL, { headers: { "User-Agent": USER_AGENT } });
          if (sourceResp.ok) {
            const data = await sourceResp.json();
            if (data.data && data.data.length > 0) {
              const newUrls = data.data.map(item => item.urls.regular);
              const uniqueSet = new Set([...db.urls, ...newUrls]);
              const newDb = { lastUpdated: Date.now(), urls: Array.from(uniqueSet) };
              await env.KV_CACHE.put(DB_KEY, JSON.stringify(newDb));
            }
          }
        } catch (e) { console.error("DB Update failed", e); }
      };
      context.waitUntil(updatePromise());
    }

    // --- 2. 随机选择一张图片 ---
    let targetUrl;
    if (!db.urls || db.urls.length === 0) {
      // 降级：如果数据库全空，临时去源站抓
      const tmp = await fetch(SOURCE_URL, { headers: { "User-Agent": USER_AGENT } }).then(r=>r.json());
      targetUrl = tmp.data[0].urls.regular;
    } else {
      targetUrl = db.urls[Math.floor(Math.random() * db.urls.length)];
    }

    // --- 3. 缓存核心逻辑 (Cache API) ---
    // 这一步是为了让 Cloudflare 记住这张图，不要每次都去 Pixiv 下载
    const cache = caches.default;
    const cacheKey = new Request(targetUrl); // 用图片原始链接做 Key
    
    let cachedResponse = await cache.match(cacheKey);
    let finalResponse;

    if (cachedResponse) {
      // 命中 CF 缓存 (快)
      finalResponse = cachedResponse;
    } else {
      // 未命中，去下载并存入 CF 缓存 (慢，但只发生一次)
      const imageResponse = await fetch(targetUrl, {
        headers: { "Referer": "https://www.pixiv.net/", "User-Agent": USER_AGENT }
      });

      // 构造存入 CF 的响应头 (允许 CF 存 7 天)
      const headersForCache = new Headers(imageResponse.headers);
      headersForCache.set("Cache-Control", `public, max-age=${EDGE_CACHE_TTL}`);
      headersForCache.delete("Pragma"); 
      headersForCache.delete("Expires");

      const responseToCache = new Response(imageResponse.body, {
        status: imageResponse.status,
        headers: headersForCache
      });

      context.waitUntil(cache.put(cacheKey, responseToCache.clone()));
      finalResponse = responseToCache;
    }

    // --- 4. 构造最终返回给用户的 Response ---
    // [这里是修改的核心]
    const userHeaders = new Headers(finalResponse.headers);
    userHeaders.set("Access-Control-Allow-Origin", "*");
    
    // 设置浏览器缓存 1 小时 (3600秒)
    // public: 允许中间人缓存
    // max-age: 浏览器缓存时间
    userHeaders.set("Cache-Control", `public, max-age=${BROWSER_CACHE_TTL}`);
    
    // 移除之前的禁止缓存头
    userHeaders.delete("Pragma");
    userHeaders.delete("Expires");

    return new Response(finalResponse.body, {
      status: finalResponse.status,
      headers: userHeaders
    });

  } catch (err) {
    return new Response(`Error: ${err.message}`, { status: 500 });
  }
}
