export async function onRequest(context) {
  const { env, request } = context;

  // ----------------配置区域----------------
  const SOURCE_URL = "https://pixiv-api.wrnm.dpdns.org/pe_pixiv.json";
  const USER_AGENT = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/115.0.0.0 Safari/537.36";
  const DB_KEY = "pixiv_archive_db"; 
  const UPDATE_INTERVAL = 60 * 60 * 1000; // KV数据库更新间隔
  
  // 图片在 Cloudflare 边缘缓存的时间 (比如 7 天)
  // 因为 Pixiv 的图片 URL 对应的图片内容基本不会变，可以存很久
  const EDGE_CACHE_TTL = 60 * 60 * 24 * 7; 
  // ----------------------------------------

  try {
    if (!env.KV_CACHE) return new Response("Error: KV_CACHE binding not found.", { status: 500 });

    // --- 1. 获取图片列表 (KV 数据库逻辑) ---
    let db = await env.KV_CACHE.get(DB_KEY, { type: "json" });
    if (!db) db = { lastUpdated: 0, urls: [] };

    const now = Date.now();
    
    // 异步检查是否需要更新数据库 (进货逻辑)
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
    const cache = caches.default;
    // 我们用图片的真实 URL 作为缓存的“键”
    const cacheKey = new Request(targetUrl);
    
    // A. 查缓存
    let cachedResponse = await cache.match(cacheKey);
    let finalResponse;

    if (cachedResponse) {
      // --- 命中缓存 (Hit) ---
      console.log(`Cache HIT: ${targetUrl}`);
      // 这里的 cachedResponse 包含了之前存储的 Response 对象 (包括图片二进制数据)
      finalResponse = cachedResponse;
    } else {
      // --- 未命中 (Miss) ---
      console.log(`Cache MISS: ${targetUrl} - Fetching...`);
      
      const imageResponse = await fetch(targetUrl, {
        headers: {
          "Referer": "https://www.pixiv.net/",
          "User-Agent": USER_AGENT
        }
      });

      // 我们需要构造一个可以被 CF 缓存的 Response
      // Cloudflare 只有在看到 Cache-Control 头部允许缓存时，才会执行 put
      const headersForCache = new Headers(imageResponse.headers);
      headersForCache.set("Cache-Control", `public, max-age=${EDGE_CACHE_TTL}`);
      headersForCache.delete("Pragma"); 
      headersForCache.delete("Expires");

      const responseToCache = new Response(imageResponse.body, {
        status: imageResponse.status,
        headers: headersForCache
      });

      // **关键步骤**：在返回给用户之前，先把这份数据“复印”一份存进 CF 缓存
      // 使用 .clone() 因为 Response流 只能读取一次
      context.waitUntil(cache.put(cacheKey, responseToCache.clone()));
      
      finalResponse = responseToCache;
    }

    // --- 4. 构造最终返回给用户的 Response ---
    // 这一步非常重要：我们需要“修改”响应头。
    // 因为存给 CF 的头是 "缓存 7 天"，但发给浏览器的头必须是 "不要缓存"。
    // 否则用户刷新浏览器，浏览器会直接读本地缓存，不再触发我们的随机逻辑。
    
    const userHeaders = new Headers(finalResponse.headers);
    userHeaders.set("Access-Control-Allow-Origin", "*");
    
    // 告诉浏览器：不要缓存这个 API 的结果，每次都要来服务器问我
    // (虽然服务器是直接从缓存里拿图片给你的，但你必须来问)
    userHeaders.set("Cache-Control", "no-store, no-cache, must-revalidate, max-age=0");
    userHeaders.set("Pragma", "no-cache");
    userHeaders.set("Expires", "0");

    return new Response(finalResponse.body, {
      status: finalResponse.status,
      headers: userHeaders
    });

  } catch (err) {
    return new Response(`Error: ${err.message}`, { status: 500 });
  }
}
