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

## iOS / Shadowrocket

iPhone 上的抖音和 B 站 App 不能运行 Tampermonkey 脚本，但可以通过 Shadowrocket 将两者的相关域名交给同一个节点。项目提供了一份合并规则：

```text
https://raw.githubusercontent.com/Orchidroot/douyin-web-accelerator/main/rules/shadowrocket-douyin-bilibili.list
```

在 Shadowrocket 当前配置的“规则”中新增远程 `RULE-SET`，粘贴该地址，将策略选为你的本地节点，并把它放在 `GEOIP,CN`、`FINAL` 等兜底规则之前。全局路由应选择“配置”。

这份列表只做域名分流，不包含或替换节点订阅。抖音和 B 站共用同一份规则即可；以后换节点只需改规则所选策略。详细说明见 [rules/README.md](rules/README.md)。

## 工作方式

- 在页面脚本读取播放数据时识别 `play_addr.url_list`、`playAddr.urlList` 等短视频候选地址。
- 识别直播的 `flv_pull_url`、`hls_pull_url_map` 和嵌套 `stream_data`，按清晰度与协议组织线路。
- 监听 `<video>` 的 `waiting`、`stalled`、`playing` 和缓冲区。
- 默认持续卡顿 4.2 秒后，尝试切到页面原本提供的另一个地址。
- 直播默认持续卡顿 9 秒后恢复：优先切换同清晰度、同协议线路，其次点击站点重试控件，最后刷新直播页重连。
- 自动刷新设有保护：至少间隔 45 秒，10 分钟内最多两次；也可在面板中关闭。
- 记录当前会话中各 CDN 主机的成功、卡顿和错误情况，后续优先选择表现较好的候选。
- 不自行生成播放 URL，不替换签名参数，也不绕过地区或访问限制。

## 如何判断是否生效

出现 ⚡ 和“当前线路”只表示脚本已启动并识别播放数据，不代表它已经修改线路。面板会明确区分：

- **仅监测，尚未介入**：播放器正常，脚本没有改变任何播放行为。
- **已实际介入 N 次**：脚本至少执行过一次播放源切换、直播请求改写、播放器重试或页面重连。
- **卡顿事件**：浏览器触发的独立 `waiting` / `stalled` 事件次数。
- **实际换线**：普通视频播放源切换与直播网络请求改写的合计次数。
- **播放器重试 / 页面重连**：直播恢复的两类降级动作。
- **最近介入**：最后一次动作的时间、原因和线路信息。

诊断统计保存在当前标签页的会话存储中，直播页面刷新后不会归零；关闭标签页后自动清除。“当前候选线路”只统计与当前媒体匹配并去重后的地址，不再累计重复接口数据。

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
