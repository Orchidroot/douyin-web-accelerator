# 抖音 Web 播放加速器

一个保守型的 Tampermonkey 用户脚本，用于监测抖音网页版视频与直播卡顿，并使用抖音页面已经下发的备用播放线路恢复播放。

## 致谢与来源

本项目的设计思路与交互方向借鉴了 [realzza/bilibili-accelerator](https://github.com/realzza/bilibili-accelerator)（MIT License），包括在网页环境中观察播放器状态、发生卡顿时优先使用站点下发的备用 CDN 地址，以及通过悬浮面板展示运行状态。感谢原作者公开这套思路和实现。

本项目针对抖音的播放数据、短视频和直播场景重新实现，并非上述项目的官方分支，双方也不存在隶属或背书关系。

## 安装

1. 在 Chrome、Edge 或 Firefox 安装 Tampermonkey。
2. 打开[一键安装地址](https://raw.githubusercontent.com/Orchidroot/douyin-web-accelerator/main/douyin-accelerator.user.js)，在 Tampermonkey 安装页确认。
3. 刷新 `https://www.douyin.com/`，右下角出现 ⚡ 即为运行成功。

脚本内置 `@updateURL` 与 `@downloadURL`。首次从上述地址安装后，Tampermonkey 会按照自己的更新检查周期读取新版本，无需再次复制粘贴。

## 工作方式

- 在页面脚本读取播放数据时识别 `play_addr.url_list`、`playAddr.urlList` 等短视频候选地址。
- 识别直播的 `flv_pull_url`、`hls_pull_url_map` 和嵌套 `stream_data`，按清晰度与协议组织线路。
- 监听 `<video>` 的 `waiting`、`stalled`、`playing` 和缓冲区。
- 默认持续卡顿 4.2 秒后，尝试切到页面原本提供的另一个地址。
- 直播默认持续卡顿 9 秒后恢复：优先切换同清晰度、同协议线路，其次点击站点重试控件，最后刷新直播页重连。
- 自动刷新设有保护：至少间隔 45 秒，10 分钟内最多两次；也可在面板中关闭。
- 记录当前会话中各 CDN 主机的成功、卡顿和错误情况，后续优先选择表现较好的候选。
- 不自行生成播放 URL，不替换签名参数，也不绕过地区或访问限制。

## 限制

- 抖音网页结构会更新，候选字段变化后需要跟进适配。
- 使用 Blob/MSE 播放且页面没有暴露对应候选时，只能监测，不能安全换源。
- FLV/MSE 直播通常显示为 `blob:`；这时无法直接替换 `<video>` 地址，脚本会使用播放器重试或受限页面刷新。
- 某些直播间只下发一条指定清晰度线路，此时没有可选择的同级 CDN。
- 切换 `<video>` 地址可能被页面播放器接管；脚本默认限制每条视频最多自动切换两次。
- 它改善的是坏连接和慢 CDN 选择，不能代替网络代理，也不保证所有地区都有效。

## 开发

```bash
npm test
npm run check
```

核心解析和候选选择测试不依赖浏览器，可直接使用 Node.js 运行。
