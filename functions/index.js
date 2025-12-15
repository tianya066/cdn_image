// [优化1] 全局内存缓存
// 只要这个 Worker 实例没被销毁，下一次请求直接从这里拿数据，不消耗 KV 额度
let memoryCache = {
  lastUpdated: 0,
  urls: []
};

export async function onRequest(context) {
  const { env } = context;

  // ----------------配置区域----------------
  const SOURCE_URL = "https://pixiv-api.wrnm.dpdns.org/pe_pixiv.json";
  const USER_AGENT = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/115.0.0.0 Safari/537.36";
  const DB_KEY = "pixiv_archive_db"; 
  const UPDATE_INTERVAL = 60 * 60 * 1000; // 1小时更新一次
  const EDGE_CACHE_TTL = 31536000; // 边缘缓存 1 年
  const BROWSER_CACHE_TTL = 3600; // 浏览器缓存 1 小时
  const MAX_DB_SIZE = 1000; // [优化2] 数据库最大保留 3000 张图 (防止内存溢出)
  
  // [优化3] 兜底图片 (当所有数据源都挂了时显示这张，建议换成你自己的稳定图)
  const FALLBACK_IMAGE = "https://aisearch.cdn.bcebos.com/fileManager/u__qckLoPd5Gk6Se9-HLmPTtZYAkS1VFhLt9vquAsTw/1765812350955YfFCSD.jpg"; 
  // ----------------------------------------

  try {
    if (!env.KV_CACHE) return new Response("Error: KV_CACHE binding not found.", { status: 500 });

    const now = Date.now();
    let db = { lastUpdated: 0, urls: [] };
    let dbNeededSave = false;

    // --- 步骤 1: 获取数据 (三级缓存策略: 内存 -> KV -> 源站) ---
    
    // A. 尝试读取内存缓存
    if (memoryCache.urls.length > 0) {
      db = memoryCache;
      // console.log("Memory Cache Hit"); // 调试用
    } 
    // B. 内存没有，尝试读取 KV
    else {
      const kvData = await env.KV_CACHE.get(DB_KEY, { type: "json" });
      if (kvData) {
        db = kvData;
        // 同步到内存，下次就不用读 KV 了
        memoryCache = kvData;
        // console.log("KV Cache Hit");
      }
    }

    // --- 步骤 2: 检查是否需要进货 (后台异步运行) ---
    // 逻辑：如果数据太旧，或者数据库是空的
    if (db.urls.length === 0 || (now - db.lastUpdated > UPDATE_INTERVAL)) {
      const updatePromise = async () => {
        try {
          const sourceResp = await fetch(SOURCE_URL, { headers: { "User-Agent": USER_AGENT } });
          if (sourceResp.ok) {
            const data = await sourceResp.json();
            if (data.data && data.data.length > 0) {
              const newUrls = data.data.map(item => item.urls.regular);
              
              // 合并去重
              const uniqueSet = new Set([...db.urls, ...newUrls]);
              let allUrls = Array.from(uniqueSet);

              // [优化2] 裁剪数组，防止无限膨胀
              // 如果超过最大限制，只保留最新的 MAX_DB_SIZE 个
              // 假设新加入的是比较好的，我们截取后半部分
              if (allUrls.length > MAX_DB_SIZE) {
                allUrls = allUrls.slice(-MAX_DB_SIZE);
              }

              const newDb = { lastUpdated: Date.now(), urls: allUrls };

              // 同时更新 KV 和 内存
              await env.KV_CACHE.put(DB_KEY, JSON.stringify(newDb));
              memoryCache = newDb; 
              console.log(`Updated DB. Size: ${allUrls.length}`);
            }
          }
        } catch (e) {
          console.error("Background update failed:", e);
        }
      };
      context.waitUntil(updatePromise());
    }

    // --- 步骤 3: 随机取图 ---
    let targetUrl;
    
    // 如果数据库有图，从库里拿
    if (db.urls.length > 0) {
      targetUrl = db.urls[Math.floor(Math.random() * db.urls.length)];
    } 
    // 极端情况：数据库空了，且KV也空了 (比如第一次部署且源站挂了)
    else {
      targetUrl = FALLBACK_IMAGE; 
    }

    // --- 步骤 4: 边缘缓存代理 (Cache API) ---
    const cache = caches.default;
    const cacheKey = new Request(targetUrl);
    
    let cachedResponse = await cache.match(cacheKey);
    let finalResponse;

    if (cachedResponse) {
      finalResponse = cachedResponse;
    } else {
      // 下载图片
      try {
        const imageResponse = await fetch(targetUrl, {
          headers: { "Referer": "https://www.pixiv.net/", "User-Agent": USER_AGENT }
        });
        
        if(!imageResponse.ok) throw new Error("Image fetch failed");

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
      } catch (e) {
        // 如果抓取目标图片失败（比如P站删图了），返回兜底图
        return Response.redirect(FALLBACK_IMAGE, 302);
      }
    }

    // --- 步骤 5: 返回给用户 (带浏览器缓存) ---
    const userHeaders = new Headers(finalResponse.headers);
    userHeaders.set("Access-Control-Allow-Origin", "*");
    userHeaders.set("Cache-Control", `public, max-age=${BROWSER_CACHE_TTL}`);
    userHeaders.delete("Pragma");
    userHeaders.delete("Expires");

    return new Response(finalResponse.body, {
      status: finalResponse.status,
      headers: userHeaders
    });

  } catch (err) {
    return new Response(`Server Error: ${err.message}`, { status: 500 });
  }
}
