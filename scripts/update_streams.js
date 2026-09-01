const fs = require("fs");
const path = require("path");

const ROOT = path.resolve(__dirname, "..");
const STREAMS_FILE = path.join(ROOT, "streams.json");
const STREAMS_ALL_FILE = path.join(ROOT, "streams_all.json");
const SEEDS_FILE = path.join(ROOT, "source_seeds.json");
const HEALTH_FILE = path.join(ROOT, "health_state.json");
const REJECTED_FILE = path.join(ROOT, "rejected_streams.json");

const YOUTUBE_API_KEY = process.env.YOUTUBE_API_KEY || "";
const MAX_FAIL_COUNT = Number(process.env.MAX_FAIL_COUNT || 2);
const HLS_TIMEOUT_MS = Number(process.env.HLS_TIMEOUT_MS || 5000);
const YOUTUBE_EMBED_PROBE_TIMEOUT_MS = Number(process.env.YOUTUBE_EMBED_PROBE_TIMEOUT_MS || 8000);
const YOUTUBE_EMBED_PROBE_CONCURRENCY = Number(process.env.YOUTUBE_EMBED_PROBE_CONCURRENCY || 8);
const YOUTUBE_DISCOVERY_PER_KEYWORD = Number(process.env.YOUTUBE_DISCOVERY_PER_KEYWORD || 25);
const ENABLE_YOUTUBE_DISCOVERY = process.env.ENABLE_YOUTUBE_DISCOVERY !== "0";
const ENABLE_YOUTUBE_EMBED_PROBE = process.env.ENABLE_YOUTUBE_EMBED_PROBE !== "0";

function readJSON(file, fallback) {
  try {
    if (!fs.existsSync(file)) return fallback;
    return JSON.parse(fs.readFileSync(file, "utf8"));
  } catch (error) {
    console.warn(`读取 JSON 失败 ${path.basename(file)}: ${error.message}`);
    return fallback;
  }
}

function writeJSON(file, value) {
  fs.writeFileSync(file, `${JSON.stringify(value, null, 2)}\n`);
}

function trim(value) {
  return typeof value === "string" ? value.trim() : "";
}

function sourceKey(item) {
  if (trim(item.youtubeId)) return `youtube:${trim(item.youtubeId)}`;
  if (trim(item.playlistId)) return `playlist:${trim(item.playlistId)}`;
  if (trim(item.m3u8Url)) return `hls:${trim(item.m3u8Url)}`;
  if (trim(item.windyPlayerURL)) return `windy:${trim(item.windyPlayerURL)}`;
  return `id:${trim(item.id) || trim(item.name) || `${item.lat},${item.lng}`}`;
}

function normalizeItem(item) {
  const youtubeId = trim(item.youtubeId);
  const playlistId = trim(item.playlistId);
  const m3u8Url = trim(item.m3u8Url);
  const windyPlayerURL = trim(item.windyPlayerURL);
  const id = trim(item.id) || youtubeId || playlistId || m3u8Url || windyPlayerURL || `${item.lat}-${item.lng}-${trim(item.name) || "Live Cam"}`;
  const name = trim(item.name) || trim(item.title) || "Live Cam";

  return {
    id,
    name,
    place: trim(item.place) || name,
    category: trim(item.category) || "Live",
    lat: Number(item.lat) || 0,
    lng: Number(item.lng) || 0,
    youtubeId,
    playlistId,
    m3u8Url,
    windyPlayerURL,
    coverImageURL: trim(item.coverImageURL),
    detailURL: trim(item.detailURL),
    views: trim(item.views),
    isHot: typeof item.isHot === "boolean" ? item.isHot : true,
    pinNumber: Number(item.pinNumber) || 0
  };
}

function uniqueItems(items) {
  const map = new Map();
  for (const raw of items) {
    const item = normalizeItem(raw);
    const key = sourceKey(item);
    if (!map.has(key)) {
      map.set(key, item);
      continue;
    }

    const old = map.get(key);
    map.set(key, {
      ...old,
      ...item,
      coverImageURL: old.coverImageURL || item.coverImageURL,
      detailURL: old.detailURL || item.detailURL,
      views: old.views || item.views,
      isHot: old.isHot || item.isHot
    });
  }
  return Array.from(map.values());
}

function chunk(array, size) {
  const result = [];
  for (let i = 0; i < array.length; i += size) result.push(array.slice(i, i + size));
  return result;
}

async function fetchJSON(url) {
  const response = await fetch(url, {
    headers: { "User-Agent": "CartiVue-stream-bot/1.0" }
  });
  if (!response.ok) throw new Error(`HTTP ${response.status}`);
  return response.json();
}

async function fetchTextWithTimeout(url, timeoutMs) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetch(url, {
      signal: controller.signal,
      headers: {
        "User-Agent": "Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.0 Mobile/15E148 Safari/604.1",
        "Accept": "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
        "Accept-Language": "en-US,en;q=0.9,zh-CN;q=0.8",
        "Referer": "https://www.youtube.com/"
      }
    });
    const text = await response.text();
    return { status: response.status, ok: response.ok, text };
  } finally {
    clearTimeout(timeout);
  }
}

function classifyYouTubeEmbedHTML(html) {
  const text = trim(html);
  if (!text) return "";
  const low = text.toLowerCase();

  if (low.includes("playback on other websites has been disabled")) return "YouTube 不允许嵌入播放";
  if (low.includes("video unavailable") || low.includes("this video is unavailable")) return "YouTube 视频不可播放";
  if (low.includes("private video")) return "YouTube 私密视频";
  if (low.includes("members-only") || low.includes("members only")) return "YouTube 会员专属，可能需要登录";
  if (low.includes("not available in your country") || low.includes("not available in your region")) return "YouTube 地区限制";
  if (low.includes("confirm your age") || low.includes("age-restricted")) return "YouTube 年龄限制，需要登录";
  if (low.includes("sign in to confirm") || low.includes("sign in to continue") || low.includes("sign in to youtube")) return "YouTube 嵌入页要求登录";
  if (low.includes("not a bot") || low.includes("unusual traffic")) return "YouTube 机器人验证，需要登录";
  if (text.includes("登录以确认") || text.includes("登入以確認") || text.includes("ログインして確認") || text.includes("로그인하여 확인")) return "YouTube 嵌入页要求登录";

  return "";
}

async function checkYouTubeEmbedItem(item) {
  const startedAt = Date.now();
  const videoId = trim(item.youtubeId);
  if (!videoId) return { ok: true, skipped: true, reason: "不是 YouTube 视频源" };

  const params = new URLSearchParams({
    playsinline: "1",
    autoplay: "0",
    mute: "1",
    rel: "0",
    controls: "0",
    disablekb: "1",
    fs: "0",
    iv_load_policy: "3",
    modestbranding: "1"
  });

  try {
    const result = await fetchTextWithTimeout(`https://www.youtube.com/embed/${videoId}?${params}`, YOUTUBE_EMBED_PROBE_TIMEOUT_MS);
    const elapsedMs = Date.now() - startedAt;

    if (result.status === 429 || result.status >= 500) {
      return { ok: true, skipped: true, elapsedMs, reason: `YouTube embed 探测临时不可用，暂时保留：HTTP ${result.status}` };
    }
    if (!result.ok) {
      return { ok: false, elapsedMs, reason: `YouTube embed HTTP ${result.status}` };
    }

    const reason = classifyYouTubeEmbedHTML(result.text);
    if (reason) return { ok: false, elapsedMs, reason };
    return { ok: true, elapsedMs, reason: "YouTube embed 页面探测通过" };
  } catch (error) {
    const elapsedMs = Date.now() - startedAt;
    const reason = error.name === "AbortError"
      ? `YouTube embed 探测超时 ${YOUTUBE_EMBED_PROBE_TIMEOUT_MS}ms`
      : `YouTube embed 探测失败：${error.message}`;
    return { ok: true, skipped: true, elapsedMs, reason };
  }
}

async function checkYouTubeEmbeds(items) {
  const videoItems = Array.from(new Map(
    items
      .filter((item) => trim(item.youtubeId))
      .map((item) => [trim(item.youtubeId), item])
  ).values());
  const results = new Map();
  if (!ENABLE_YOUTUBE_EMBED_PROBE || !videoItems.length) return results;

  let index = 0;
  async function worker() {
    while (index < videoItems.length) {
      const item = videoItems[index++];
      const result = await checkYouTubeEmbedItem(item);
      results.set(sourceKey(item), result);
    }
  }

  await Promise.all(Array.from({ length: Math.min(YOUTUBE_EMBED_PROBE_CONCURRENCY, videoItems.length) }, worker));

  const failed = Array.from(results.values()).filter((result) => !result.ok);
  const loginFailed = failed.filter((result) => /登录|机器人验证|age|sign in|bot/i.test(result.reason || ""));
  if (loginFailed.length > Math.max(20, Math.floor(videoItems.length * 0.5))) {
    console.warn(`YouTube embed 探测疑似被平台整体拦截：登录类失败 ${loginFailed.length}/${videoItems.length}，本轮忽略 embed 探测结果`);
    return new Map();
  }

  console.log(`YouTube embed 探测完成：检测 ${videoItems.length}，失败 ${failed.length}`);
  return results;
}

async function discoverYouTubeByKeywords(seeds) {
  if (!YOUTUBE_API_KEY || !ENABLE_YOUTUBE_DISCOVERY) return [];

  const keywordSearches = Array.isArray(seeds.youtubeKeywords)
    ? seeds.youtubeKeywords.map((q) => ({ q }))
    : [];
  const geoSearches = Array.isArray(seeds.youtubeSearches) ? seeds.youtubeSearches : [];
  const searches = [...keywordSearches, ...geoSearches];
  const discovered = [];

  for (const search of searches) {
    const q = typeof search === "string" ? search : trim(search.q);
    if (!q) continue;
    const hasSearchCoordinate = Number.isFinite(Number(search.lat)) && Number.isFinite(Number(search.lng));
    const params = new URLSearchParams({
      key: YOUTUBE_API_KEY,
      part: "snippet",
      type: "video",
      eventType: "live",
      maxResults: String(YOUTUBE_DISCOVERY_PER_KEYWORD),
      q
    });

    try {
      const data = await fetchJSON(`https://www.googleapis.com/youtube/v3/search?${params}`);
      for (const entry of data.items || []) {
        const videoId = entry.id && entry.id.videoId;
        if (!videoId) continue;
        const snippet = entry.snippet || {};
        if (!hasSearchCoordinate) {
          console.warn(`YouTube 关键词缺少坐标，跳过新增：${q} / ${trim(snippet.title) || videoId}`);
          continue;
        }
        discovered.push({
          id: videoId,
          name: trim(snippet.title) || "Live Cam",
          place: trim(search.place) || trim(snippet.channelTitle) || "YouTube Live",
          category: trim(search.category) || "YouTube",
          lat: Number(search.lat) || 0,
          lng: Number(search.lng) || 0,
          youtubeId: videoId,
          playlistId: "",
          m3u8Url: "",
          windyPlayerURL: "",
          coverImageURL: snippet.thumbnails && snippet.thumbnails.medium ? snippet.thumbnails.medium.url : "",
          detailURL: `https://www.youtube.com/watch?v=${videoId}`,
          views: "",
          isHot: false,
          pinNumber: 0
        });
      }
      console.log(`YouTube 关键词抓取成功：${q} → ${data.items ? data.items.length : 0} 条`);
    } catch (error) {
      console.warn(`YouTube 关键词抓取失败：${q}，${error.message}`);
    }
  }

  return discovered;
}

function itemsFromSeeds(seeds) {
  const items = [];

  for (const youtubeId of seeds.youtubeVideoIds || []) {
    const id = trim(youtubeId);
    if (!id) continue;
    items.push({
      id,
      name: "YouTube Live",
      place: "YouTube",
      category: "YouTube",
      lat: 0,
      lng: 0,
      youtubeId: id,
      playlistId: "",
      m3u8Url: "",
      windyPlayerURL: "",
      coverImageURL: `https://i.ytimg.com/vi/${id}/mqdefault.jpg`,
      detailURL: `https://www.youtube.com/watch?v=${id}`,
      views: "",
      isHot: false,
      pinNumber: 0
    });
  }

  for (const playlistId of seeds.youtubePlaylistIds || []) {
    const id = trim(playlistId);
    if (!id) continue;
    items.push({
      id,
      name: "YouTube Playlist",
      place: "YouTube",
      category: "YouTube",
      lat: 0,
      lng: 0,
      youtubeId: "",
      playlistId: id,
      m3u8Url: "",
      windyPlayerURL: "",
      coverImageURL: "",
      detailURL: `https://www.youtube.com/playlist?list=${id}`,
      views: "",
      isHot: false,
      pinNumber: 0
    });
  }

  for (const hlsUrl of seeds.hlsUrls || []) {
    const url = trim(hlsUrl);
    if (!url) continue;
    items.push({
      id: url,
      name: "Live Stream",
      place: "HLS",
      category: "HLS",
      lat: 0,
      lng: 0,
      youtubeId: "",
      playlistId: "",
      m3u8Url: url,
      windyPlayerURL: "",
      coverImageURL: "",
      detailURL: "",
      views: "",
      isHot: false,
      pinNumber: 0
    });
  }

  return items;
}

async function checkYouTube(items) {
  const videoItems = items.filter((item) => trim(item.youtubeId));
  const results = new Map();

  if (!videoItems.length) return results;
  if (!YOUTUBE_API_KEY) {
    for (const item of videoItems) {
      results.set(sourceKey(item), {
        ok: true,
        skipped: true,
        reason: "未配置 YOUTUBE_API_KEY，保留现有 YouTube 源"
      });
    }
    return results;
  }

  const byId = new Map();
  for (const item of videoItems) byId.set(item.youtubeId, item);

  for (const ids of chunk(Array.from(byId.keys()), 50)) {
    const params = new URLSearchParams({
      key: YOUTUBE_API_KEY,
      part: "status,snippet,liveStreamingDetails,contentDetails,statistics",
      id: ids.join(",")
    });

    let data;
    try {
      data = await fetchJSON(`https://www.googleapis.com/youtube/v3/videos?${params}`);
    } catch (error) {
      for (const id of ids) {
        results.set(sourceKey(byId.get(id)), {
          ok: true,
          skipped: true,
          reason: `YouTube API 请求失败，暂时保留：${error.message}`
        });
      }
      continue;
    }

    const returned = new Map((data.items || []).map((entry) => [entry.id, entry]));
    for (const id of ids) {
      const item = byId.get(id);
      const entry = returned.get(id);

      if (!entry) {
        results.set(sourceKey(item), { ok: false, reason: "YouTube 视频不存在或不可访问" });
        continue;
      }

      const status = entry.status || {};
      const contentRating = (entry.contentDetails && entry.contentDetails.contentRating) || {};
      const live = entry.liveStreamingDetails || {};

      if (status.privacyStatus && status.privacyStatus !== "public") {
        results.set(sourceKey(item), { ok: false, reason: `YouTube 非公开：${status.privacyStatus}` });
      } else if (status.uploadStatus && status.uploadStatus !== "processed") {
        results.set(sourceKey(item), { ok: false, reason: `YouTube 未处理完成：${status.uploadStatus}` });
      } else if (status.embeddable === false) {
        results.set(sourceKey(item), { ok: false, reason: "YouTube 不允许嵌入播放" });
      } else if (contentRating.ytRating === "ytAgeRestricted") {
        results.set(sourceKey(item), { ok: false, reason: "YouTube 年龄限制，可能需要登录" });
      } else if (live.actualEndTime) {
        results.set(sourceKey(item), { ok: false, reason: "YouTube 直播已结束" });
      } else {
        const concurrent = live.concurrentViewers ? Number(live.concurrentViewers) : 0;
        const viewCount = entry.statistics && entry.statistics.viewCount ? Number(entry.statistics.viewCount) : 0;
        results.set(sourceKey(item), {
          ok: true,
          reason: "YouTube 元数据检测通过",
          title: trim(entry.snippet && entry.snippet.title),
          channelTitle: trim(entry.snippet && entry.snippet.channelTitle),
          coverImageURL: entry.snippet && entry.snippet.thumbnails && entry.snippet.thumbnails.medium
            ? entry.snippet.thumbnails.medium.url
            : "",
          views: concurrent > 0 ? `${concurrent} watching` : (viewCount > 0 ? `${viewCount} views` : ""),
          isHot: concurrent >= 50 || viewCount >= 10000
        });
      }
    }
  }

  return results;
}

async function checkHLSItem(item) {
  const startedAt = Date.now();
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), HLS_TIMEOUT_MS);

  try {
    const response = await fetch(item.m3u8Url, {
      method: "GET",
      signal: controller.signal,
      headers: {
        "User-Agent": "Mozilla/5.0 CartiVue-stream-bot/1.0",
        "Accept": "application/vnd.apple.mpegurl,application/x-mpegURL,text/plain,*/*"
      }
    });

    const elapsedMs = Date.now() - startedAt;
    if (!response.ok) {
      return { ok: false, elapsedMs, reason: `HLS HTTP ${response.status}` };
    }

    const text = await response.text();
    if (!text.includes("#EXTM3U")) {
      return { ok: false, elapsedMs, reason: "HLS 内容不是 m3u8" };
    }

    return { ok: true, elapsedMs, reason: "HLS 检测通过" };
  } catch (error) {
    const elapsedMs = Date.now() - startedAt;
    return {
      ok: false,
      elapsedMs,
      reason: error.name === "AbortError" ? `HLS 超时 ${HLS_TIMEOUT_MS}ms` : `HLS 请求失败：${error.message}`
    };
  } finally {
    clearTimeout(timeout);
  }
}

async function checkHLS(items) {
  const hlsItems = items.filter((item) => trim(item.m3u8Url));
  const results = new Map();
  const concurrency = 12;
  let index = 0;

  async function worker() {
    while (index < hlsItems.length) {
      const item = hlsItems[index++];
      const result = await checkHLSItem(item);
      results.set(sourceKey(item), result);
    }
  }

  await Promise.all(Array.from({ length: Math.min(concurrency, hlsItems.length) }, worker));
  return results;
}

function isBlacklisted(item, blacklist) {
  const values = [
    sourceKey(item),
    trim(item.id),
    trim(item.youtubeId),
    trim(item.playlistId),
    trim(item.m3u8Url),
    trim(item.detailURL)
  ].filter(Boolean);
  return values.some((value) => blacklist.has(value));
}

function updateHealth(item, checkResult, previousHealth) {
  const now = new Date().toISOString();
  const old = previousHealth[sourceKey(item)] || {};
  const elapsedMs = Number(checkResult.elapsedMs || 0);

  if (checkResult.ok) {
    return {
      ok: true,
      failCount: 0,
      successCount: Number(old.successCount || 0) + (checkResult.skipped ? 0 : 1),
      lastReason: checkResult.reason || "",
      lastCheckMs: elapsedMs,
      lastCheckedAt: now
    };
  }

  return {
    ok: false,
    failCount: Number(old.failCount || 0) + 1,
    successCount: Number(old.successCount || 0),
    lastReason: checkResult.reason || "检测失败",
    lastCheckMs: elapsedMs,
    lastCheckedAt: now
  };
}

async function main() {
  const existing = readJSON(STREAMS_FILE, []);
  const previousAll = readJSON(STREAMS_ALL_FILE, []);
  const seeds = readJSON(SEEDS_FILE, {});
  const previousHealth = readJSON(HEALTH_FILE, {});
  const blacklist = new Set((seeds.blacklist || []).map(trim).filter(Boolean));

  const discovered = await discoverYouTubeByKeywords(seeds);
  const seedItems = itemsFromSeeds(seeds);
  const allItems = uniqueItems([...existing, ...previousAll, ...seedItems, ...discovered])
    .filter((item) => item.lat >= -90 && item.lat <= 90 && item.lng >= -180 && item.lng <= 180)
    .filter((item) => trim(item.youtubeId) || trim(item.playlistId) || trim(item.m3u8Url) || trim(item.windyPlayerURL));

  console.log(`源合并完成：现有 ${existing.length}，历史全量 ${previousAll.length}，种子 ${seedItems.length}，新抓取 ${discovered.length}，去重后 ${allItems.length}`);

  const [youtubeResults, hlsResults, youtubeEmbedResults] = await Promise.all([
    checkYouTube(allItems),
    checkHLS(allItems),
    checkYouTubeEmbeds(allItems)
  ]);

  const health = {};
  const accepted = [];
  const rejected = [];

  for (const item of allItems) {
    let checkResult = youtubeResults.get(sourceKey(item))
      || hlsResults.get(sourceKey(item))
      || { ok: true, skipped: true, reason: "无需检测，保留" };
    const embedResult = youtubeEmbedResults.get(sourceKey(item));
    if (checkResult.ok && embedResult && !embedResult.ok) {
      checkResult = embedResult;
    }

    if (isBlacklisted(item, blacklist)) {
      checkResult = { ok: false, reason: "命中黑名单" };
    }

    const nextHealth = updateHealth(item, checkResult, previousHealth);
    health[sourceKey(item)] = nextHealth;

    const shouldHide = !checkResult.ok && nextHealth.failCount >= MAX_FAIL_COUNT;
    if (shouldHide) {
      rejected.push({
        ...item,
        rejectedReason: nextHealth.lastReason,
        failCount: nextHealth.failCount,
        lastCheckedAt: nextHealth.lastCheckedAt
      });
    } else {
      accepted.push(enrichAcceptedItem(item, checkResult));
    }
  }

  writeJSON(STREAMS_ALL_FILE, allItems);
  writeJSON(STREAMS_FILE, accepted);
  writeJSON(HEALTH_FILE, health);
  writeJSON(REJECTED_FILE, rejected);

  console.log(`生成完成：正式源 ${accepted.length}，隐藏坏源 ${rejected.length}`);
}

function enrichAcceptedItem(item, checkResult) {
  if (!checkResult || !checkResult.ok) return item;
  const title = trim(checkResult.title);
  const place = trim(checkResult.channelTitle);
  const coverImageURL = trim(checkResult.coverImageURL);
  const views = trim(checkResult.views);
  return {
    ...item,
    name: title || item.name,
    place: item.place && item.place !== "YouTube Live" ? item.place : (place || item.place),
    coverImageURL: coverImageURL || item.coverImageURL,
    views: views || item.views,
    isHot: item.isHot || checkResult.isHot === true
  };
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
