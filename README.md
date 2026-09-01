# live-map-api

CartiVue 全球直播源配置。App 读取 `main/streams.json`，GitHub Actions 会每 6 小时自动检测并更新一次。

## 文件说明

- `streams.json`：App 正式使用的源列表，只保留健康源和未达到隐藏阈值的源。
- `streams_all.json`：自动抓取和历史保留的全量源。
- `source_seeds.json`：少量人工种子，包括 YouTube 搜索词、固定视频、播放列表、HLS 地址和黑名单。
- `health_state.json`：每个源的检测状态、失败次数、检测耗时。
- `rejected_streams.json`：连续失败后被隐藏的源和原因。
- `scripts/update_streams.js`：自动抓取、检测、生成源列表。

## 需要配置的 GitHub Secret

在仓库页面进入：

`Settings -> Secrets and variables -> Actions -> New repository secret`

新增：

```text
YOUTUBE_API_KEY
```

没有配置 `YOUTUBE_API_KEY` 时，脚本不会删除现有 YouTube 源，只会检测 HLS 源。

## 自动更新

仓库已经配置 `.github/workflows/update.yml`：

- 每 6 小时自动运行一次。
- 也可以在 GitHub 仓库的 `Actions -> Update Streams -> Run workflow` 手动运行。

默认规则：

- HLS 单个源超时：5000ms。
- 源连续失败 2 次后从 `streams.json` 隐藏。
- 后续检测恢复成功后会重新进入 `streams.json`。

## 手动添加或屏蔽源

编辑 `source_seeds.json`：

```json
{
  "youtubeKeywords": ["live cam city"],
  "youtubeVideoIds": ["VIDEO_ID"],
  "youtubePlaylistIds": ["PLAYLIST_ID"],
  "hlsUrls": ["https://example.com/live.m3u8"],
  "blacklist": ["VIDEO_ID", "hls:https://example.com/live.m3u8"]
}
```

改完后提交到 GitHub，定时任务会自动生成新的 `streams.json`。
