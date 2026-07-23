// ==UserScript==
// @name         抖音 Web 播放加速器
// @namespace    https://github.com/Orchidroot/douyin-web-accelerator
// @version      0.2.3
// @description  监测抖音网页视频和直播卡顿，并使用站点下发的备用线路恢复播放
// @author       Orchidroot
// @match        https://*.douyin.com/*
// @match        https://douyin.com/*
// @run-at       document-start
// @grant        unsafeWindow
// @inject-into  page
// @sandbox      raw
// @noframes
// @homepageURL  https://github.com/Orchidroot/douyin-web-accelerator
// @supportURL   https://github.com/Orchidroot/douyin-web-accelerator/issues
// @updateURL    https://raw.githubusercontent.com/Orchidroot/douyin-web-accelerator/main/douyin-accelerator.user.js
// @downloadURL  https://raw.githubusercontent.com/Orchidroot/douyin-web-accelerator/main/douyin-accelerator.user.js
// @license      MIT
// ==/UserScript==

// Design inspiration: realzza/bilibili-accelerator (MIT).
// This Douyin implementation is independent and is not an official fork.

(function (factory) {
  "use strict";

  const api = factory();
  if (typeof module === "object" && module.exports) {
    module.exports = api;
    return;
  }

  const pageWindow = typeof unsafeWindow !== "undefined" ? unsafeWindow : window;
  api.boot(pageWindow, window);
})(function () {
  "use strict";

  const VERSION = "0.2.3";
  const URL_LIST_KEYS = new Set(["url_list", "urlList"]);
  const PLAY_PATH_PATTERN =
    /(?:^|\.)(?:play(?:_?addr|_?url)?(?:_?265|_?h264)?|bit_?rate|playApi)(?:\.|$)/i;

  function normalizeUrl(value, baseUrl = "https://www.douyin.com/") {
    if (typeof value !== "string" || !/^https?:\/\//i.test(value)) return "";
    try {
      const url = new URL(value, baseUrl);
      url.hash = "";
      return url.href;
    } catch {
      return "";
    }
  }

  function hostFromUrl(value) {
    try {
      return new URL(value).hostname;
    } catch {
      return "";
    }
  }

  function assetFingerprint(value) {
    try {
      const url = new URL(value);
      const pathParts = decodeURIComponent(url.pathname)
        .split("/")
        .filter(Boolean)
        .slice(-4);
      const identityParams = ["video_id", "vid", "item_id", "ratio", "mime_type"]
        .map((key) => [key, url.searchParams.get(key)])
        .filter(([, item]) => item)
        .map(([key, item]) => `${key}=${item}`);
      return [...pathParts, ...identityParams].join("|");
    } catch {
      return "";
    }
  }

  function collectPlayAddressGroups(payload, maxNodes = 30000) {
    const groups = [];
    const visited = new WeakSet();
    let visitedNodes = 0;

    function walk(value, path, depth) {
      if (
        value === null ||
        typeof value !== "object" ||
        depth > 24 ||
        visitedNodes >= maxNodes
      ) {
        return;
      }
      if (visited.has(value)) return;
      visited.add(value);
      visitedNodes += 1;

      if (!Array.isArray(value)) {
        for (const key of Object.keys(value)) {
          const child = value[key];
          const nextPath = [...path, key];
          if (
            URL_LIST_KEYS.has(key) &&
            Array.isArray(child) &&
            PLAY_PATH_PATTERN.test(path.join("."))
          ) {
            const urls = child.map((item) => normalizeUrl(item)).filter(Boolean);
            if (urls.length > 0) {
              groups.push({
                path: nextPath.join("."),
                source: child,
                urls: [...new Set(urls)],
              });
            }
          }
          walk(child, nextPath, depth + 1);
        }
        return;
      }

      for (let index = 0; index < value.length; index += 1) {
        walk(value[index], [...path, String(index)], depth + 1);
      }
    }

    walk(payload, [], 0);
    return groups;
  }

  function liveProtocolFromKey(key) {
    const normalized = String(key).toLowerCase();
    if (normalized.includes("flv") || normalized.includes("rtmp")) return "flv";
    if (normalized.includes("hls") || normalized === "lls") return "hls";
    if (normalized.includes("cmaf") || normalized.includes("dash")) return "dash";
    return "";
  }

  function normalizeLiveQuality(value) {
    const quality = String(value || "unknown")
      .trim()
      .toLowerCase()
      .replace(/[\s-]+/g, "_");
    if (["origin", "origion", "original", "or4"].includes(quality)) return "origin";
    if (["full_hd1", "uhd", "uhd1"].includes(quality)) return "uhd";
    if (["hd", "hd1", "hd2"].includes(quality)) return "hd";
    if (["sd", "sd1", "sd2"].includes(quality)) return "sd";
    if (["ld", "ld1", "ld2"].includes(quality)) return "ld";
    return quality;
  }

  function collectLiveStreamGroups(payload, parseJson = JSON.parse, maxNodes = 30000) {
    const grouped = new Map();
    const visited = new WeakSet();
    let visitedNodes = 0;

    function add(quality, protocol, value, path) {
      const url = normalizeUrl(value);
      if (!url || !protocol) return;
      const normalizedQuality = normalizeLiveQuality(quality);
      const key = `${normalizedQuality}|${protocol}`;
      if (!grouped.has(key)) {
        grouped.set(key, {
          kind: "live",
          quality: normalizedQuality,
          protocol,
          path,
          source: null,
          urls: [],
        });
      }
      const group = grouped.get(key);
      if (!group.urls.includes(url)) group.urls.push(url);
    }

    function parseEmbedded(value, path, depth) {
      if (
        typeof value !== "string" ||
        value.length < 2 ||
        value.length > 10_000_000 ||
        !/^[\s]*[\[{]/.test(value)
      ) {
        return;
      }
      try {
        walk(parseJson(value), path, depth + 1);
      } catch {
        // Embedded live payloads are optional and may not be JSON.
      }
    }

    function walk(value, path, depth) {
      if (
        value === null ||
        typeof value !== "object" ||
        depth > 28 ||
        visitedNodes >= maxNodes
      ) {
        return;
      }
      if (visited.has(value)) return;
      visited.add(value);
      visitedNodes += 1;

      if (Array.isArray(value)) {
        for (let index = 0; index < value.length; index += 1) {
          walk(value[index], [...path, String(index)], depth + 1);
        }
        return;
      }

      const pathText = path.join(".").toLowerCase();
      const qualityFromMain =
        path.length >= 2 && String(path[path.length - 1]).toLowerCase() === "main"
          ? path[path.length - 2]
          : "";
      if (
        qualityFromMain &&
        (pathText.includes("stream_data") ||
          pathText.includes("pull_data") ||
          pathText.includes("live_core_sdk_data"))
      ) {
        for (const protocolKey of ["flv", "hls", "cmaf", "dash", "lls"]) {
          add(
            qualityFromMain,
            liveProtocolFromKey(protocolKey),
            value[protocolKey],
            [...path, protocolKey].join("."),
          );
        }
      }

      for (const [key, child] of Object.entries(value)) {
        const lowerKey = key.toLowerCase();
        const nextPath = [...path, key];
        const protocol = liveProtocolFromKey(lowerKey);
        const isPullMap =
          /^(?:flv_pull_url|hls_pull_url_map|hls_pull_url|rtmp_pull_url)$/.test(
            lowerKey,
          );

        if (isPullMap && typeof child === "string") {
          add("unknown", protocol, child, nextPath.join("."));
        } else if (isPullMap && child && typeof child === "object") {
          for (const [quality, url] of Object.entries(child)) {
            if (typeof url === "string") {
              add(quality, protocol, url, [...nextPath, quality].join("."));
            } else if (url && typeof url === "object") {
              for (const item of Object.values(url)) {
                if (typeof item === "string") {
                  add(quality, protocol, item, [...nextPath, quality].join("."));
                }
              }
            }
          }
        }

        if (
          typeof child === "string" &&
          /^(?:stream_data|room_data|rawdata)$/.test(lowerKey)
        ) {
          parseEmbedded(child, nextPath, depth);
        }
        walk(child, nextPath, depth + 1);
      }
    }

    walk(payload, [], 0);
    return [...grouped.values()];
  }

  function isLiveMediaUrl(value) {
    const normalized = normalizeUrl(value);
    return Boolean(
      normalized &&
        (/\.(?:flv|m3u8|mpd)(?:[/?#]|$)/i.test(normalized) ||
          /(?:pull-(?:flv|hls|cmaf)|\/stream-)/i.test(normalized)),
    );
  }

  function reorderGroup(group, scoreUrl) {
    if (!group || !Array.isArray(group.source) || group.source.length < 2) return false;
    const original = group.source.slice();
    const decorated = original.map((value, index) => ({
      value,
      index,
      score: scoreUrl(normalizeUrl(value)),
    }));
    decorated.sort((left, right) => right.score - left.score || left.index - right.index);
    const changed = decorated.some((item, index) => item.value !== original[index]);
    if (changed) {
      group.source.splice(0, group.source.length, ...decorated.map((item) => item.value));
      group.urls = group.source.map((item) => normalizeUrl(item)).filter(Boolean);
    }
    return changed;
  }

  class CandidateRegistry {
    constructor(now = () => Date.now()) {
      this.now = now;
      this.groups = [];
      this.ttlMs = 5 * 60 * 1000;
    }

    register(groups, source = "") {
      const seenAt = this.now();
      for (const group of groups) {
        if (!group.urls || group.urls.length === 0) continue;
        const signature = group.urls.slice().sort().join("\n");
        const existing = this.groups.find((item) => item.signature === signature);
        if (existing) {
          existing.seenAt = seenAt;
          existing.urls = group.urls.slice();
          existing.source = source || existing.source;
        } else {
          this.groups.push({
            signature,
            urls: group.urls.slice(),
            seenAt,
            source,
          });
        }
      }
      this.prune();
    }

    prune() {
      const oldest = this.now() - this.ttlMs;
      this.groups = this.groups.filter((group) => group.seenAt >= oldest).slice(-300);
    }

    knows(value) {
      const normalized = normalizeUrl(value);
      if (!normalized) return false;
      const fingerprint = assetFingerprint(normalized);
      return this.groups.some((group) =>
        group.urls.some(
          (candidate) =>
            candidate === normalized ||
            (fingerprint && assetFingerprint(candidate) === fingerprint),
        ),
      );
    }

    alternatives(currentUrl, attempted = new Set(), scoreUrl = () => 0) {
      this.prune();
      const normalized = normalizeUrl(currentUrl);
      if (!normalized) return [];
      const fingerprint = assetFingerprint(normalized);
      const matching = this.groups
        .filter((group) =>
          group.urls.some(
            (candidate) =>
              candidate === normalized ||
              (fingerprint && assetFingerprint(candidate) === fingerprint),
          ),
        )
        .sort((left, right) => right.seenAt - left.seenAt);
      if (matching.length === 0) return [];

      return [...new Set(matching.flatMap((group) => group.urls))]
        .filter((candidate) => candidate !== normalized && !attempted.has(candidate))
        .map((candidate, index) => ({ candidate, index, score: scoreUrl(candidate) }))
        .sort((left, right) => right.score - left.score || left.index - right.index)
        .map((item) => item.candidate);
    }
  }

  function bufferAhead(video) {
    if (!video || !video.buffered || !Number.isFinite(video.currentTime)) return 0;
    for (let index = 0; index < video.buffered.length; index += 1) {
      const start = video.buffered.start(index);
      const end = video.buffered.end(index);
      if (video.currentTime >= start - 0.15 && video.currentTime <= end + 0.15) {
        return Math.max(0, end - video.currentTime);
      }
    }
    return 0;
  }

  function createHostScores() {
    const scores = new Map();

    function get(url) {
      const host = hostFromUrl(url);
      if (!host) return null;
      if (!scores.has(host)) {
        scores.set(host, { host, successes: 0, stalls: 0, errors: 0, lastSeen: 0 });
      }
      return scores.get(host);
    }

    return {
      noteSuccess(url) {
        const item = get(url);
        if (!item) return;
        item.successes += 1;
        item.lastSeen = Date.now();
      },
      noteStall(url) {
        const item = get(url);
        if (!item) return;
        item.stalls += 1;
        item.lastSeen = Date.now();
      },
      noteError(url) {
        const item = get(url);
        if (!item) return;
        item.errors += 1;
        item.lastSeen = Date.now();
      },
      score(url) {
        const item = get(url);
        if (!item) return 0;
        return item.successes * 2 - item.stalls * 20 - item.errors * 35;
      },
      reset() {
        scores.clear();
      },
      snapshot() {
        return [...scores.values()].sort(
          (left, right) =>
            right.successes - right.stalls - (left.successes - left.stalls),
        );
      },
    };
  }

  function boot(pageWindow, sandboxWindow) {
    if (!pageWindow || !pageWindow.document || pageWindow.__DY_ACCELERATOR_ACTIVE__) return;
    pageWindow.__DY_ACCELERATOR_ACTIVE__ = true;

    const document = pageWindow.document;
    const registry = new CandidateRegistry();
    const liveRegistry = new CandidateRegistry();
    const hostScores = createHostScores();
    const nativeJsonParse = pageWindow.JSON.parse.bind(pageWindow.JSON);
    const videoStates = new WeakMap();
    const attachedVideos = new WeakSet();
    let activeVideo = null;
    let lastLiveMediaUrl = "";
    let payloadCount = 0;
    let switchCount = 0;
    let lastMessage = "正在等待播放器";
    let ui = null;

    const settingsKey = "douyin-accelerator-settings-v1";
    const defaultSettings = {
      enabled: true,
      autoSwitch: true,
      aggressive: false,
      liveAutoReload: true,
      maxSwitches: 2,
    };

    function loadSettings() {
      try {
        return {
          ...defaultSettings,
          ...JSON.parse(pageWindow.localStorage.getItem(settingsKey) || "{}"),
        };
      } catch {
        return { ...defaultSettings };
      }
    }

    let settings = loadSettings();

    const liveRecoveryKey = "douyin-accelerator-live-recovery-v1";

    function loadLiveRecovery() {
      try {
        const value = nativeJsonParse(
          pageWindow.sessionStorage.getItem(liveRecoveryKey) || "{}",
        );
        const timestamps = Array.isArray(value.timestamps)
          ? value.timestamps.filter((item) => Date.now() - item < 10 * 60 * 1000)
          : [];
        return {
          timestamps,
          badHost: typeof value.badHost === "string" ? value.badHost : "",
        };
      } catch {
        return { timestamps: [], badHost: "" };
      }
    }

    let liveRecovery = loadLiveRecovery();
    if (liveRecovery.badHost) {
      hostScores.noteStall(`https://${liveRecovery.badHost}/`);
    }

    function saveLiveRecovery() {
      try {
        pageWindow.sessionStorage.setItem(
          liveRecoveryKey,
          JSON.stringify(liveRecovery),
        );
      } catch {
        // Session storage may be disabled.
      }
    }

    function saveSettings() {
      try {
        pageWindow.localStorage.setItem(settingsKey, JSON.stringify(settings));
      } catch {
        // Playback should still work when storage is unavailable.
      }
    }

    function setMessage(message) {
      lastMessage = message;
      if (ui) ui.render();
    }

    function processPayload(payload, source = "") {
      try {
        const videoGroups = collectPlayAddressGroups(payload);
        const liveGroups = collectLiveStreamGroups(payload, nativeJsonParse);
        registry.register(videoGroups, source);
        liveRegistry.register(liveGroups, source);
        for (const group of videoGroups) {
          reorderGroup(group, (url) => hostScores.score(url));
        }
        if (videoGroups.length > 0 || liveGroups.length > 0) {
          payloadCount += videoGroups.length + liveGroups.length;
          if (ui) ui.render();
        }
      } catch (error) {
        console.debug("[Douyin Accelerator] Ignored payload:", error);
      }
      return payload;
    }

    function routeLiveRequest(value) {
      const current = normalizeUrl(value);
      if (!isLiveMediaUrl(current)) return current || value;
      lastLiveMediaUrl = current;
      const alternatives = liveRegistry.alternatives(
        current,
        new Set(),
        (url) => hostScores.score(url),
      );
      const better = alternatives.find(
        (candidate) => hostScores.score(candidate) > hostScores.score(current),
      );
      if (better) {
        lastLiveMediaUrl = better;
        return better;
      }
      return current;
    }

    function patchDataPaths() {
      const originalParse = pageWindow.JSON && pageWindow.JSON.parse;
      if (originalParse && !originalParse.__dyAcceleratorPatched) {
        const patchedParse = function (...args) {
          return processPayload(originalParse.apply(this, args), "JSON.parse");
        };
        patchedParse.__dyAcceleratorPatched = true;
        pageWindow.JSON.parse = patchedParse;
      }

      const responsePrototype = pageWindow.Response && pageWindow.Response.prototype;
      const originalResponseJson = responsePrototype && responsePrototype.json;
      if (originalResponseJson && !originalResponseJson.__dyAcceleratorPatched) {
        const patchedResponseJson = async function (...args) {
          const value = await originalResponseJson.apply(this, args);
          return processPayload(value, this.url || "Response.json");
        };
        patchedResponseJson.__dyAcceleratorPatched = true;
        responsePrototype.json = patchedResponseJson;
      }

      const originalFetch = pageWindow.fetch;
      if (originalFetch && !originalFetch.__dyAcceleratorPatched) {
        const patchedFetch = function (input, init) {
          const inputUrl =
            typeof input === "string" || input instanceof pageWindow.URL
              ? String(input)
              : input && input.url;
          if (!inputUrl || !isLiveMediaUrl(inputUrl)) {
            return originalFetch.call(this, input, init);
          }
          const routedUrl = routeLiveRequest(inputUrl);
          if (routedUrl === normalizeUrl(inputUrl)) {
            return originalFetch.call(this, input, init);
          }

          if (input instanceof pageWindow.Request) {
            const method = String((init && init.method) || input.method || "GET").toUpperCase();
            if (method === "GET" || method === "HEAD") {
              const routedRequest = new pageWindow.Request(routedUrl, {
                method,
                headers: (init && init.headers) || input.headers,
                mode: (init && init.mode) || input.mode,
                credentials: (init && init.credentials) || input.credentials,
                cache: (init && init.cache) || input.cache,
                redirect: (init && init.redirect) || input.redirect,
                referrer: (init && init.referrer) || input.referrer,
                referrerPolicy: (init && init.referrerPolicy) || input.referrerPolicy,
                integrity: (init && init.integrity) || input.integrity,
                keepalive:
                  init && typeof init.keepalive === "boolean"
                    ? init.keepalive
                    : input.keepalive,
                signal: (init && init.signal) || input.signal,
              });
              return originalFetch.call(this, routedRequest);
            }
          }
          return originalFetch.call(this, routedUrl, init);
        };
        patchedFetch.__dyAcceleratorPatched = true;
        pageWindow.fetch = patchedFetch;
      }

      const xhrPrototype = pageWindow.XMLHttpRequest && pageWindow.XMLHttpRequest.prototype;
      const originalOpen = xhrPrototype && xhrPrototype.open;
      if (originalOpen && !originalOpen.__dyAcceleratorPatched) {
        const patchedOpen = function (method, url, ...args) {
          const routedUrl = routeLiveRequest(url);
          this.__dyAcceleratorRequestUrl = routedUrl;
          return originalOpen.call(this, method, routedUrl, ...args);
        };
        patchedOpen.__dyAcceleratorPatched = true;
        xhrPrototype.open = patchedOpen;
      }

      const originalSend = xhrPrototype && xhrPrototype.send;
      if (originalSend && !originalSend.__dyAcceleratorPatched) {
        const patchedSend = function (...args) {
          this.addEventListener(
            "load",
            () => {
              try {
                if (
                  (!this.responseType || this.responseType === "text") &&
                  typeof this.responseText === "string" &&
                  this.responseText.length < 10_000_000 &&
                  /^[\s]*[\[{]/.test(this.responseText)
                ) {
                  const value = originalParse.call(pageWindow.JSON, this.responseText);
                  const videoGroups = collectPlayAddressGroups(value);
                  const liveGroups = collectLiveStreamGroups(value, nativeJsonParse);
                  registry.register(videoGroups, this.responseURL || "XMLHttpRequest");
                  liveRegistry.register(liveGroups, this.responseURL || "XMLHttpRequest");
                  if (videoGroups.length > 0 || liveGroups.length > 0) {
                    payloadCount += videoGroups.length + liveGroups.length;
                    if (ui) ui.render();
                  }
                }
              } catch {
                // Some cross-origin XHR responses do not expose responseText.
              }
            },
            { once: true },
          );
          return originalSend.apply(this, args);
        };
        patchedSend.__dyAcceleratorPatched = true;
        xhrPrototype.send = patchedSend;
      }
    }

    function getVideoState(video) {
      if (!videoStates.has(video)) {
        videoStates.set(video, {
          waitSince: 0,
          recovering: false,
          attempted: new Set(),
          switches: 0,
          healthySince: 0,
        });
      }
      return videoStates.get(video);
    }

    function currentVideoUrl(video) {
      return normalizeUrl(video && (video.currentSrc || video.src));
    }

    function isLiveVideo(video) {
      return (
        pageWindow.location.hostname === "live.douyin.com" ||
        pageWindow.location.pathname.startsWith("/live") ||
        pageWindow.location.pathname.includes("/follow/live") ||
        video.duration === Infinity ||
        (!Number.isFinite(video.duration) && video.readyState > 0)
      );
    }

    function chooseActiveVideo() {
      const videos = [...document.querySelectorAll("video")].filter((video) => {
        const rect = video.getBoundingClientRect();
        return rect.width > 80 && rect.height > 80;
      });
      for (const video of videos) attachVideo(video);
      const playing = videos.filter((video) => !video.paused && !video.ended);
      const pool = playing.length > 0 ? playing : videos;
      return (
        pool.sort((left, right) => {
          const leftRect = left.getBoundingClientRect();
          const rightRect = right.getBoundingClientRect();
          return rightRect.width * rightRect.height - leftRect.width * leftRect.height;
        })[0] || null
      );
    }

    function clearWaiting(video, healthy = false) {
      const state = getVideoState(video);
      state.waitSince = 0;
      state.recovering = false;
      if (healthy) {
        if (!state.healthySince) state.healthySince = Date.now();
        if (Date.now() - state.healthySince > 15000) {
          state.switches = 0;
          state.attempted.clear();
        }
      }
    }

    function attachVideo(video) {
      if (attachedVideos.has(video)) return;
      attachedVideos.add(video);
      getVideoState(video);

      video.addEventListener("waiting", () => {
        const state = getVideoState(video);
        if (!state.waitSince) state.waitSince = pageWindow.performance.now();
        state.healthySince = 0;
        setMessage("检测到缓冲，正在观察");
      });
      video.addEventListener("stalled", () => {
        const state = getVideoState(video);
        if (!state.waitSince) state.waitSince = pageWindow.performance.now();
        state.healthySince = 0;
        setMessage("连接暂时停滞");
      });
      video.addEventListener("playing", () => {
        clearWaiting(video, true);
        const url = currentVideoUrl(video);
        if (url) hostScores.noteSuccess(url);
        setMessage("播放正常");
      });
      video.addEventListener("timeupdate", () => clearWaiting(video, true));
      video.addEventListener("error", () => {
        hostScores.noteError(currentVideoUrl(video));
        setMessage("播放器报告了媒体错误");
      });
      video.addEventListener("emptied", () => {
        const state = getVideoState(video);
        state.waitSince = 0;
      });
    }

    function switchVideoSource(video, alternative, manual = false) {
      const state = getVideoState(video);
      if (state.recovering || !alternative) return false;
      state.recovering = true;
      state.attempted.add(alternative);
      state.switches += 1;
      switchCount += 1;

      const resumeAt = Number.isFinite(video.currentTime) ? video.currentTime : 0;
      const shouldPlay = !video.paused;
      const playbackRate = video.playbackRate;
      const oldHost = hostFromUrl(currentVideoUrl(video)) || "当前线路";
      const newHost = hostFromUrl(alternative) || "备用线路";
      setMessage(`${manual ? "手动" : "自动"}切换：${oldHost} → ${newHost}`);

      const onMetadata = () => {
        try {
          if (resumeAt > 0 && (!Number.isFinite(video.duration) || resumeAt < video.duration)) {
            video.currentTime = resumeAt;
          }
          video.playbackRate = playbackRate;
          if (shouldPlay) {
            const playResult = video.play();
            if (playResult && typeof playResult.catch === "function") {
              playResult.catch(() => {});
            }
          }
        } finally {
          state.recovering = false;
          state.waitSince = 0;
        }
      };

      video.addEventListener("loadedmetadata", onMetadata, { once: true });
      try {
        video.src = alternative;
        video.load();
        pageWindow.setTimeout(() => {
          state.recovering = false;
        }, 8000);
        return true;
      } catch (error) {
        state.recovering = false;
        hostScores.noteError(alternative);
        setMessage(`切换失败：${error.message}`);
        return false;
      }
    }

    function recoverVideo(video, manual = false) {
      if (!video || isLiveVideo(video)) {
        setMessage("当前不是可换源的普通视频");
        return false;
      }
      const state = getVideoState(video);
      const current = currentVideoUrl(video);
      if (!current) {
        setMessage("当前是 Blob/MSE 播放，未取得可切换地址");
        return false;
      }
      if (!manual && state.switches >= settings.maxSwitches) {
        setMessage("已达到本条视频的自动切换上限");
        return false;
      }

      hostScores.noteStall(current);
      const alternatives = registry.alternatives(
        current,
        state.attempted,
        (url) => hostScores.score(url),
      );
      if (alternatives.length === 0) {
        setMessage("没有匹配到站点下发的备用地址");
        return false;
      }
      return switchVideoSource(video, alternatives[0], manual);
    }

    function findLiveRetryControl() {
      const retryPattern = /^(?:重新加载|重新连接|点击重试|重试播放|刷新直播|重新进入直播)$/;
      return [...document.querySelectorAll("button,[role='button']")].find((element) => {
        const text = (element.textContent || "").trim();
        const rect = element.getBoundingClientRect();
        return retryPattern.test(text) && rect.width > 0 && rect.height > 0;
      });
    }

    function recoverLive(video, manual = false) {
      if (!video || !isLiveVideo(video)) return false;
      const state = getVideoState(video);
      if (state.recovering) return false;
      state.recovering = true;

      const directUrl = currentVideoUrl(video);
      const current = lastLiveMediaUrl || directUrl;
      if (current) hostScores.noteStall(current);

      const alternatives = current
        ? liveRegistry.alternatives(
            current,
            state.attempted,
            (url) => hostScores.score(url),
          )
        : [];
      if (directUrl && alternatives.length > 0) {
        state.recovering = false;
        return switchVideoSource(video, alternatives[0], manual);
      }

      const retryControl = findLiveRetryControl();
      if (retryControl) {
        retryControl.click();
        state.waitSince = 0;
        switchCount += 1;
        setMessage(`${manual ? "手动" : "自动"}触发直播播放器重连`);
        pageWindow.setTimeout(() => {
          state.recovering = false;
        }, 5000);
        return true;
      }

      if (!manual && !settings.liveAutoReload) {
        state.recovering = false;
        state.waitSince = 0;
        setMessage("直播自动刷新已关闭，可点击“立即恢复”");
        return false;
      }

      const now = Date.now();
      liveRecovery.timestamps = liveRecovery.timestamps.filter(
        (timestamp) => now - timestamp < 10 * 60 * 1000,
      );
      const lastReload = liveRecovery.timestamps[liveRecovery.timestamps.length - 1] || 0;
      if (now - lastReload < 45 * 1000) {
        state.recovering = false;
        state.waitSince = 0;
        setMessage("直播重连冷却中，避免连续刷新");
        return false;
      }
      if (!manual && liveRecovery.timestamps.length >= 2) {
        state.recovering = false;
        state.waitSince = 0;
        setMessage("10 分钟内已自动重连两次，暂停自动刷新");
        return false;
      }

      liveRecovery.timestamps.push(now);
      liveRecovery.badHost = hostFromUrl(current);
      saveLiveRecovery();
      switchCount += 1;
      setMessage(`${manual ? "手动" : "自动"}重连直播，页面即将刷新`);
      pageWindow.setTimeout(() => pageWindow.location.reload(), 500);
      return true;
    }

    function installPerformanceObserver() {
      if (!pageWindow.PerformanceObserver) return;
      try {
        const observer = new pageWindow.PerformanceObserver((list) => {
          for (const entry of list.getEntries()) {
            if (entry.duration > 0 && registry.knows(entry.name)) {
              hostScores.noteSuccess(entry.name);
            }
            if (isLiveMediaUrl(entry.name)) {
              lastLiveMediaUrl = normalizeUrl(entry.name);
              if (entry.duration > 0 && liveRegistry.knows(entry.name)) {
                hostScores.noteSuccess(entry.name);
              }
            }
          }
        });
        observer.observe({ type: "resource", buffered: true });
      } catch {
        // Older browsers may not support buffered resource observation.
      }
    }

    function createUi() {
      if (!document.documentElement || document.getElementById("dy-accelerator-root")) return;
      const host = document.createElement("div");
      host.id = "dy-accelerator-root";
      host.style.cssText =
        "all:initial;position:fixed;right:18px;bottom:20px;z-index:2147483647;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif";
      const shadow = host.attachShadow({ mode: "open" });
      shadow.innerHTML = `
        <style>
          *{box-sizing:border-box}
          button,input{font:inherit}
          #bolt{width:44px;height:44px;border:0;border-radius:50%;cursor:pointer;background:#00d6c9;color:#082f2c;font-size:22px;box-shadow:0 8px 28px #0005}
          #panel{display:none;position:absolute;right:0;bottom:54px;width:300px;padding:15px;color:#f4f7fb;background:#161a22f2;border:1px solid #ffffff18;border-radius:15px;box-shadow:0 16px 50px #0008;backdrop-filter:blur(14px)}
          #panel.open{display:block}
          h2{font-size:15px;margin:0 0 4px}
          .sub{font-size:11px;color:#aeb8ca;margin-bottom:13px}
          .status{padding:10px;border-radius:10px;background:#ffffff0b;font-size:12px;line-height:1.45;word-break:break-all}
          .grid{display:grid;grid-template-columns:1fr 1fr;gap:8px;margin:10px 0}
          .metric{padding:9px;border-radius:9px;background:#ffffff0b}
          .label{display:block;font-size:10px;color:#96a3b8}
          .value{font-size:13px;color:#fff}
          label{display:flex;align-items:center;justify-content:space-between;padding:7px 1px;font-size:12px}
          input{accent-color:#00d6c9}
          .actions{display:flex;gap:7px;margin-top:10px}
          .actions button{flex:1;border:1px solid #ffffff1f;border-radius:8px;padding:8px 5px;cursor:pointer;background:#ffffff0d;color:#edf3fa;font-size:11px}
          .actions button.primary{border-color:#00d6c955;background:#00d6c922;color:#70fff2}
          .foot{margin-top:10px;font-size:9px;color:#748096}
        </style>
        <button id="bolt" title="抖音 Web 播放加速器">⚡</button>
        <section id="panel">
          <h2>抖音 Web 播放加速器</h2>
          <div class="sub">v${VERSION} · 仅使用页面下发的备用地址</div>
          <div id="status" class="status"></div>
          <div class="grid">
            <div class="metric"><span class="label">前方缓冲</span><span id="buffer" class="value">—</span></div>
            <div class="metric"><span class="label">已发现候选组</span><span id="groups" class="value">0</span></div>
            <div class="metric"><span class="label">当前线路</span><span id="hostName" class="value">—</span></div>
            <div class="metric"><span class="label">恢复次数</span><span id="switches" class="value">0</span></div>
          </div>
          <label>启用监测 <input id="enabled" type="checkbox"></label>
          <label>卡顿时自动换源 <input id="autoSwitch" type="checkbox"></label>
          <label>直播卡死时刷新重连 <input id="liveAutoReload" type="checkbox"></label>
          <label>积极模式（更早处理） <input id="aggressive" type="checkbox"></label>
          <div class="actions">
            <button id="recover" class="primary">立即尝试恢复</button>
            <button id="reset">重置线路评分</button>
          </div>
          <div class="foot">不绕过地区限制，不生成或修改播放地址签名。</div>
        </section>
      `;
      document.documentElement.appendChild(host);

      const panel = shadow.getElementById("panel");
      const bolt = shadow.getElementById("bolt");
      bolt.addEventListener("click", () => panel.classList.toggle("open"));

      for (const key of ["enabled", "autoSwitch", "liveAutoReload", "aggressive"]) {
        const input = shadow.getElementById(key);
        input.checked = Boolean(settings[key]);
        input.addEventListener("change", () => {
          settings[key] = input.checked;
          saveSettings();
          ui.render();
        });
      }

      shadow.getElementById("recover").addEventListener("click", () => {
        activeVideo = chooseActiveVideo();
        if (activeVideo && isLiveVideo(activeVideo)) {
          recoverLive(activeVideo, true);
        } else {
          recoverVideo(activeVideo, true);
        }
      });
      shadow.getElementById("reset").addEventListener("click", () => {
        hostScores.reset();
        setMessage("线路评分已重置");
      });

      ui = {
        render() {
          const video = activeVideo;
          const ahead = video ? bufferAhead(video) : 0;
          const current = currentVideoUrl(video);
          const displayUrl = current || (video && isLiveVideo(video) ? lastLiveMediaUrl : "");
          shadow.getElementById("status").textContent = settings.enabled
            ? lastMessage
            : "监测已暂停";
          shadow.getElementById("buffer").textContent = video ? `${ahead.toFixed(1)} 秒` : "—";
          shadow.getElementById("groups").textContent = String(payloadCount);
          shadow.getElementById("hostName").textContent =
            hostFromUrl(displayUrl) || "Blob / 未知";
          shadow.getElementById("switches").textContent = String(switchCount);
          bolt.style.background = settings.enabled ? "#00d6c9" : "#758096";
        },
      };
      ui.render();
    }

    function tick() {
      if (!settings.enabled) {
        if (ui) ui.render();
        return;
      }

      activeVideo = chooseActiveVideo();
      if (!activeVideo) {
        setMessage("正在等待播放器");
        return;
      }

      const state = getVideoState(activeVideo);
      const ahead = bufferAhead(activeVideo);
      const live = isLiveVideo(activeVideo);
      if (
        settings.autoSwitch &&
        state.waitSince &&
        !state.recovering &&
        ahead < 0.35 &&
        !activeVideo.paused
      ) {
        const threshold = live
          ? settings.aggressive
            ? 4500
            : 9000
          : settings.aggressive
            ? 1800
            : 4200;
        if (pageWindow.performance.now() - state.waitSince >= threshold) {
          if (live) {
            recoverLive(activeVideo);
          } else {
            recoverVideo(activeVideo);
          }
        }
      } else if (!state.waitSince && !activeVideo.paused) {
        lastMessage = ahead > 0.2 ? (live ? "直播正常" : "播放正常") : "播放器正在取流";
      }
      if (ui) ui.render();
    }

    patchDataPaths();
    installPerformanceObserver();

    const startUi = () => {
      createUi();
      pageWindow.setInterval(tick, 600);
    };
    if (document.documentElement) {
      startUi();
    } else {
      document.addEventListener("DOMContentLoaded", startUi, { once: true });
    }

    console.info(`[Douyin Accelerator] v${VERSION} active`);
  }

  return {
    VERSION,
    CandidateRegistry,
    assetFingerprint,
    bufferAhead,
    collectLiveStreamGroups,
    collectPlayAddressGroups,
    createHostScores,
    hostFromUrl,
    isLiveMediaUrl,
    liveProtocolFromKey,
    normalizeLiveQuality,
    normalizeUrl,
    reorderGroup,
    boot,
  };
});
