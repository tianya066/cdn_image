export async function onRequest(context) {
  const SOURCE_URL = "https://pixiv-api.wrnm.dpdns.org/pe_pixiv.json";
  const USER_AGENT = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/115.0.0.0 Safari/537.36";

  try {
    // 1. 获取 JSON
    const jsonResponse = await fetch(SOURCE_URL, {
      headers: { "User-Agent": USER_AGENT }
    });

    if (!jsonResponse.ok) return new Response("Error fetching source", { status: 502 });
    const data = await jsonResponse.json();
    
    if (!data.data || data.data.length === 0) return new Response("No data", { status: 404 });

    // 2. 随机逻辑
    const item = data.data[Math.floor(Math.random() * data.data.length)];
    const imageUrl = item.urls.regular;

    // 3. 代理图片
    const imageResponse = await fetch(imageUrl, {
      headers: {
        "Referer": "https://www.pixiv.net/",
        "User-Agent": USER_AGENT
      }
    });

    // 4. 返回
    const newHeaders = new Headers(imageResponse.headers);
    newHeaders.set("Access-Control-Allow-Origin", "*");

    return new Response(imageResponse.body, {
      status: imageResponse.status,
      headers: newHeaders
    });

  } catch (err) {
    return new Response(err.message, { status: 500 });
  }
}
