export async function onRequest(context) {
  const { env } = context;

  // ----------------配置区域----------------
  const SOURCE_URL = "https://pixiv-api.wrnm.dpdns.org/pe_pixiv.json";
  const USER_AGENT = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/115.0.0.0 Safari/537.36";
  const DB_KEY = "pixiv_archive_db"; 
  const UPDATE_INTERVAL = 60 * 60 * 1000; // 1小时更新一次库存
  // ----------------------------------------

  try {
    if (!env.KV_CACHE) {
      return new Response("Error: KV_CACHE binding not found.", { status: 500 });
    }

    // 1. 读取数据库
    let db = await env.KV_CACHE.get(DB_KEY, { type: "json" });
    if (!db) {
      db = { lastUpdated: 0, urls: [] };
    }

    const now = Date.now();
    let isDataUpdated = false;

    // 2. 检查是否需要“进货”（距离上次更新超过1小时）
    // 注意：这个操作只负责“加图”，不影响本次给用户显示的图
    if (db.urls.length === 0 || (now - db.lastUpdated > UPDATE_INTERVAL)) {
      // 使用 waitUntil 在后台默默更新，不要卡住用户的请求
      // 我们先创建一个 Promise 逻辑来处理更新
      const updatePromise = async () => {
        try {
          console.log("Auto-updating image database...");
          const sourceResp = await fetch(SOURCE_URL, { headers: { "User-Agent": USER_AGENT } });
          if (sourceResp.ok) {
            const data = await sourceResp.json();
            if (data.data && data.data.length > 0) {
              const newUrls = data.data.map(item => item.urls.regular);
              
              // 重新读取一次 KV 确保数据是最新的（防止并发写入冲突，虽然几率小）
              // 但为了简单，这里直接基于内存合并
              const uniqueSet = new Set([...db.urls, ...newUrls]);
              const updatedUrls = Array.from(uniqueSet);
              
              const newDb = {
                lastUpdated: Date.now(),
                urls: updatedUrls
              };
              
              // 写入 KV
              await env.KV_CACHE.put(DB_KEY, JSON.stringify(newDb));
              console.log(`Database updated. Total images: ${updatedUrls.length}`);
            }
          }
        } catch (e) {
          console.error("Background update failed:", e);
        }
      };

      // 核心优化：让更新操作在后台跑，不阻塞当前请求
      context.waitUntil(updatePromise());
    }

    // 3. 从现有数据库中随机取一张
    if (!db.urls || db.urls.length === 0) {
      // 极端情况：数据库是空的，且后台更新还没完成。
      // 临时去源站抓一次直接返回，保证不报错 (降级处理)
       const tempResp = await fetch(SOURCE_URL, { headers: { "User-Agent": USER_AGENT } });
       const tempData = await tempResp.json();
       const tempItem = tempData.data[0];
       var targetUrl = tempItem.urls.regular;
    } else {
      // 正常情况：从几百张图里随机选一张
      targetUrl = db.urls[Math.floor(Math.random() * db.urls.length)];
    }

    // 4. 代理图片
    const imageResponse = await fetch(targetUrl, {
      headers: {
        "Referer": "https://www.pixiv.net/",
        "User-Agent": USER_AGENT
      }
    });

    // 5. 设置响应头
    const newHeaders = new Headers(imageResponse.headers);
    newHeaders.set("Access-Control-Allow-Origin", "*");
    
    // -------------------------------------------------------
    // 修改重点: 禁止浏览器/CDN缓存结果
    // 这样用户每次刷新，代码都会重新运行，从库里重新随机一张图
    // -------------------------------------------------------
    newHeaders.set("Cache-Control", "no-store, no-cache, must-revalidate, max-age=0");
    newHeaders.set("Pragma", "no-cache");
    newHeaders.set("Expires", "0");

    return new Response(imageResponse.body, {
      status: imageResponse.status,
      headers: newHeaders
    });

  } catch (err) {
    return new Response(`Server Error: ${err.message}`, { status: 500 });
  }
}
