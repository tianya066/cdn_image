export async function onRequest(context) {
  const { env } = context;

  // ----------------配置区域----------------
  const SOURCE_URL = "https://pixiv-api.wrnm.dpdns.org/pe_pixiv.json";
  const USER_AGENT = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/115.0.0.0 Safari/537.36";
  
  // KV 中的键名 (相当于你的文件名)
  const DB_KEY = "pixiv_archive_db"; 
  // 更新间隔 (毫秒) - 这里设为 1 小时
  const UPDATE_INTERVAL = 60 * 60 * 1000; 
  // ----------------------------------------

  try {
    // 1. 如果没有绑定 KV，报错提示
    if (!env.KV_CACHE) {
      return new Response("Error: KV_CACHE binding not found. Please configure KV in Cloudflare dashboard.", { status: 500 });
    }

    // 2. 从 KV 读取当前的“数据库”
    // 结构设计: { lastUpdated: 1680000000, urls: ["url1", "url2", ...] }
    let db = await env.KV_CACHE.get(DB_KEY, { type: "json" });

    // 如果是第一次运行，初始化数据库
    if (!db) {
      db = { lastUpdated: 0, urls: [] };
    }

    const now = Date.now();
    let isDataUpdated = false;

    // 3. 检查是否需要更新 (数据库为空 OR 距离上次更新超过1小时)
    if (db.urls.length === 0 || (now - db.lastUpdated > UPDATE_INTERVAL)) {
      console.log("Triggering update: Fetching new images...");
      
      try {
        const sourceResp = await fetch(SOURCE_URL, {
          headers: { "User-Agent": USER_AGENT }
        });

        if (sourceResp.ok) {
          const data = await sourceResp.json();
          if (data.data && data.data.length > 0) {
            
            // 提取新图片的 URL
            const newUrls = data.data.map(item => item.urls.regular);

            // --- 核心逻辑：去重并追加 ---
            // 使用 Set 自动去除重复图片，防止同一个图片存两遍
            const uniqueSet = new Set([...db.urls, ...newUrls]);
            db.urls = Array.from(uniqueSet);
            
            // 更新时间戳
            db.lastUpdated = now;
            isDataUpdated = true;

            console.log(`Updated! Total images in library: ${db.urls.length}`);
          }
        }
      } catch (e) {
        console.error("Failed to fetch source, using existing cache.", e);
        // 如果抓取失败，什么都不做，继续用旧数据，保证服务不挂
      }
    }

    // 4. 如果数据有更新，将新数据库写回 KV
    // 使用 waitUntil 让写入操作在后台进行，不阻塞用户看到图片的速度
    if (isDataUpdated) {
      context.waitUntil(
        env.KV_CACHE.put(DB_KEY, JSON.stringify(db))
      );
    }

    // 5. 此时 db.urls 里可能有几百上千张图，随机取一张
    if (db.urls.length === 0) {
      return new Response("No images in database yet.", { status: 404 });
    }

    const randomUrl = db.urls[Math.floor(Math.random() * db.urls.length)];

    // 6. 代理图片请求 (标准流程)
    const imageResponse = await fetch(randomUrl, {
      headers: {
        "Referer": "https://www.pixiv.net/",
        "User-Agent": USER_AGENT
      }
    });

    const newHeaders = new Headers(imageResponse.headers);
    newHeaders.set("Access-Control-Allow-Origin", "*");
    // 浏览器缓存 5 分钟
    newHeaders.set("Cache-Control", "public, max-age=300"); 

    return new Response(imageResponse.body, {
      status: imageResponse.status,
      headers: newHeaders
    });

  } catch (err) {
    return new Response(`Server Error: ${err.message}`, { status: 500 });
  }
}
