# Shadowrocket 规则

`shadowrocket-douyin-bilibili.list` 是抖音与 B 站共用的远程规则集，适合在 iOS Shadowrocket 中把两个 App 的相关域名交给同一个节点或策略。

远程地址：

```text
https://raw.githubusercontent.com/Orchidroot/douyin-web-accelerator/main/rules/shadowrocket-douyin-bilibili.list
```

## 没有现有配置

如果 Shadowrocket 的“配置”页面为空，可直接下载这份完整的最简配置：

```text
https://raw.githubusercontent.com/Orchidroot/douyin-web-accelerator/main/rules/shadowrocket-douyin-bilibili-direct.conf
```

打开“配置”页面，点击右上角 `+`，粘贴该地址并下载；随后点击下载的配置，选择“使用配置”。这份配置不包含任何节点或订阅，抖音、B 站及其他流量都保持 `DIRECT` 直连。

## 添加方式

以下步骤只适用于已经有配置文件的情况：

1. 打开 Shadowrocket 当前使用的配置，进入“规则”。
2. 新增 `RULE-SET` 规则，粘贴上面的远程地址。
3. 在策略一栏选择你的本地节点或包含它的策略组。
4. 将这条规则放在 `GEOIP,CN`、`FINAL` 等兜底规则之前。
5. Shadowrocket 的全局路由选择“配置”，然后重新打开抖音或 B 站。

规则集不包含节点、订阅或账号信息，也不会覆盖已有配置。以后更新域名列表仍使用同一个地址；更换节点时只需修改该规则绑定的策略。

## 范围与限制

- 只做域名分流，不修改 App，不改写播放地址，也不绕过地区、会员或访问限制。
- 不含节点的最简配置中，合并规则和兜底规则都是 `DIRECT`，因此它只提供规则匹配与日志辨识，不会改变网络路径或产生额外加速。
- `snssdk.com`、`pstatp.com`、`byteimg.com` 等属于字节系共享域名，其他字节系 App 的少量流量也可能命中。
- B 站的 Akamai 备用线路只列入了已知的精确主机名，避免把整个 `akamaized.net` 共享 CDN 都交给该节点。
- 节点必须支持相应流量，尤其是视频常用的 UDP/QUIC；若节点到国内 CDN 的线路较差，分流不一定会更快。

## 参考

域名覆盖范围参考并交叉核对了：

- [blackmatrix7/ios_rule_script 的 BiliBili 规则](https://github.com/blackmatrix7/ios_rule_script/tree/master/rule/Shadowrocket/BiliBili)
- [blackmatrix7/ios_rule_script 的 ByteDance 规则](https://github.com/blackmatrix7/ios_rule_script/tree/master/rule/Shadowrocket/ByteDance)

本规则集为适配本项目使用场景而单独整理，项目整体的网页加速思路仍致谢 [realzza/bilibili-accelerator](https://github.com/realzza/bilibili-accelerator)。
