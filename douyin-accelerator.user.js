// ==UserScript==
// @name         抖音 Web 播放加速器
// @namespace    https://github.com/Orchidroot/douyin-web-accelerator
// @version      0.4.0
// @description  主动检测抖音网页视频和直播假死，并使用站点下发的备用线路恢复播放
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

// Playback model and panel structure are adapted from
// realzza/bilibili-accelerator (MIT, Copyright (c) 2026 realzza).
// This Douyin implementation is independent and is not an official fork.
//
// Permission is hereby granted, free of charge, to any person obtaining a copy
// of this software and associated documentation files (the "Software"), to deal
// in the Software without restriction, including without limitation the rights
// to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
// copies of the Software, and to permit persons to whom the Software is
// furnished to do so, subject to the following conditions:
//
// The above copyright notice and this permission notice shall be included in all
// copies or substantial portions of the Software.
//
// THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
// IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
// FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
// AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
// LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
// OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
// SOFTWARE.

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

  const VERSION = "0.4.0";
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

  function createLiveRerouteGate(now = () => Date.now()) {
    let badHost = "";
    let expiresAt = 0;

    function clear() {
      badHost = "";
      expiresAt = 0;
    }

    function canReroute(value) {
      if (!badHost || now() >= expiresAt) {
        clear();
        return false;
      }
      return hostFromUrl(value) === badHost;
    }

    return {
      arm(value, ttlMs = 20000) {
        const host = hostFromUrl(value);
        if (!host) {
          clear();
          return false;
        }
        badHost = host;
        expiresAt = now() + Math.max(1000, Number(ttlMs) || 0);
        return true;
      },
      canReroute,
      consume(value) {
        if (!canReroute(value)) return false;
        clear();
        return true;
      },
      clear,
      snapshot() {
        return { badHost, expiresAt };
      },
    };
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

    candidateUrls(currentUrl = "") {
      this.prune();
      const normalized = normalizeUrl(currentUrl);
      if (!normalized) {
        return [...new Set(this.groups.flatMap((group) => group.urls))];
      }
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
      return [...new Set(matching.flatMap((group) => group.urls))];
    }

    alternatives(currentUrl, attempted = new Set(), scoreUrl = () => 0) {
      const normalized = normalizeUrl(currentUrl);
      if (!normalized) return [];
      return this.candidateUrls(normalized)
        .filter((candidate) => candidate !== normalized && !attempted.has(candidate))
        .map((candidate, index) => ({ candidate, index, score: scoreUrl(candidate) }))
        .sort((left, right) => right.score - left.score || left.index - right.index)
        .map((item) => item.candidate);
    }
  }

  function selectLiveReroute(
    currentUrl,
    candidateRegistry,
    rerouteGate,
    scoreUrl = () => 0,
  ) {
    const current = normalizeUrl(currentUrl);
    if (
      !current ||
      !candidateRegistry ||
      !rerouteGate ||
      !rerouteGate.canReroute(current)
    ) {
      return "";
    }
    return (
      candidateRegistry
        .alternatives(current, new Set(), scoreUrl)
        .find((candidate) => !rerouteGate.canReroute(candidate)) || ""
    );
  }

  function createDiagnostics(value = {}, now = Date.now()) {
    function count(key) {
      const item = Number(value[key]);
      return Number.isSafeInteger(item) && item >= 0 ? item : 0;
    }
    return {
      startedAt:
        Number.isFinite(Number(value.startedAt)) && Number(value.startedAt) > 0
          ? Number(value.startedAt)
          : now,
      stallEvents: count("stallEvents"),
      candidateReorders: count("candidateReorders"),
      sourceSwitches: count("sourceSwitches"),
      requestReroutes: count("requestReroutes"),
      playerRetries: count("playerRetries"),
      pageReloads: count("pageReloads"),
      lastAction:
        typeof value.lastAction === "string" ? value.lastAction.slice(0, 240) : "",
      lastActionAt:
        Number.isFinite(Number(value.lastActionAt)) && Number(value.lastActionAt) > 0
          ? Number(value.lastActionAt)
          : 0,
    };
  }

  function interventionCount(diagnostics) {
    return (
      diagnostics.candidateReorders +
      diagnostics.sourceSwitches +
      diagnostics.requestReroutes +
      diagnostics.playerRetries +
      diagnostics.pageReloads
    );
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

  function updatePlaybackClock(clock, currentTime, now, stalledAfterMs) {
    const previous = clock || {};
    const mediaTime = Number(currentTime);
    const wallTime = Number(now);
    const threshold = Math.max(500, Number(stalledAfterMs) || 0);
    if (!Number.isFinite(mediaTime) || !Number.isFinite(wallTime)) {
      return {
        lastMediaTime: Number.isFinite(previous.lastMediaTime)
          ? previous.lastMediaTime
          : 0,
        lastProgressAt: Number.isFinite(previous.lastProgressAt)
          ? previous.lastProgressAt
          : 0,
        stalled: false,
      };
    }

    const lastMediaTime = Number(previous.lastMediaTime);
    const lastProgressAt = Number(previous.lastProgressAt);
    if (
      !Number.isFinite(lastMediaTime) ||
      !Number.isFinite(lastProgressAt) ||
      mediaTime > lastMediaTime + 0.05 ||
      mediaTime < lastMediaTime - 0.5
    ) {
      return {
        lastMediaTime: mediaTime,
        lastProgressAt: wallTime,
        stalled: false,
      };
    }

    return {
      lastMediaTime,
      lastProgressAt,
      stalled: wallTime - lastProgressAt >= threshold,
    };
  }

  function throughputMbps(bytes, durationMs) {
    const size = Number(bytes);
    const duration = Number(durationMs);
    if (!(size > 0) || !(duration > 0)) return 0;
    return Math.min(10000, (size * 8) / (duration / 1000) / 1_000_000);
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
    const liveRerouteGate = createLiveRerouteGate();
    const nativeJsonParse = pageWindow.JSON.parse.bind(pageWindow.JSON);
    const videoStates = new WeakMap();
    const attachedVideos = new WeakSet();
    let activeVideo = null;
    let lastLiveMediaUrl = "";
    let lastMessage = "正在等待播放器";
    let lastRerouteSignature = "";
    let lastRerouteAt = 0;
    let lastCandidateReorderAt = 0;
    let ui = null;
    const telemetry = {
      mode: "buffer",
      currentMbps: 0,
      peakMbps: 0,
      lastNetworkSampleAt: 0,
      mbpsSeries: [],
      bufferSeries: [],
    };

    const settingsKey = "douyin-accelerator-settings-v2";
    const legacySettingsKey = "douyin-accelerator-settings-v1";
    const defaultSettings = {
      enabled: true,
      autoSwitch: true,
      aggressive: false,
      liveAutoReload: false,
      theme: "system",
      maxSwitches: 2,
    };

    function loadSettings() {
      try {
        const current = JSON.parse(pageWindow.localStorage.getItem(settingsKey) || "null");
        if (current && typeof current === "object") {
          return { ...defaultSettings, ...current };
        }
        const legacy = JSON.parse(
          pageWindow.localStorage.getItem(legacySettingsKey) || "null",
        );
        if (!legacy || typeof legacy !== "object") return { ...defaultSettings };
        const migrated = { ...defaultSettings };
        for (const key of ["enabled", "autoSwitch", "aggressive", "maxSwitches"]) {
          if (Object.hasOwn(legacy, key)) migrated[key] = legacy[key];
        }
        return migrated;
      } catch {
        return { ...defaultSettings };
      }
    }

    let settings = loadSettings();

    const liveRecoveryKey = "douyin-accelerator-live-recovery-v1";
    const diagnosticsKey = "douyin-accelerator-diagnostics-v1";

    function loadDiagnostics() {
      try {
        return createDiagnostics(
          nativeJsonParse(pageWindow.sessionStorage.getItem(diagnosticsKey) || "{}"),
        );
      } catch {
        return createDiagnostics();
      }
    }

    let diagnostics = loadDiagnostics();

    function saveDiagnostics() {
      try {
        pageWindow.sessionStorage.setItem(diagnosticsKey, JSON.stringify(diagnostics));
      } catch {
        // Session storage may be disabled.
      }
    }

    function recordDiagnostic(field, message) {
      if (Object.hasOwn(diagnostics, field) && Number.isInteger(diagnostics[field])) {
        diagnostics[field] += 1;
      }
      diagnostics.lastAction = message;
      diagnostics.lastActionAt = Date.now();
      saveDiagnostics();
      setMessage(message);
    }

    function recordStallEvent() {
      diagnostics.stallEvents += 1;
      saveDiagnostics();
      if (ui) ui.render();
    }

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
      const latestReload =
        liveRecovery.timestamps[liveRecovery.timestamps.length - 1] || 0;
      if (Date.now() - latestReload < 60 * 1000) {
        liveRerouteGate.arm(`https://${liveRecovery.badHost}/`, 30000);
      }
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

    function noteNetworkTransfer(bytes, durationMs) {
      const sample = throughputMbps(bytes, durationMs);
      if (!(sample > 0)) return;
      telemetry.mode = "speed";
      telemetry.currentMbps =
        telemetry.currentMbps > 0
          ? telemetry.currentMbps * 0.65 + sample * 0.35
          : sample;
      telemetry.peakMbps = Math.max(telemetry.peakMbps, sample);
      telemetry.lastNetworkSampleAt = Date.now();
    }

    function sampleTelemetry(video, ahead) {
      if (Date.now() - telemetry.lastNetworkSampleAt > 5000) {
        telemetry.mode = "buffer";
      }
      telemetry.currentMbps =
        telemetry.mode === "speed" ? telemetry.currentMbps * 0.96 : 0;
      telemetry.mbpsSeries.push(telemetry.currentMbps);
      telemetry.bufferSeries.push(Math.max(0, Number(ahead) || 0));
      if (telemetry.mbpsSeries.length > 48) telemetry.mbpsSeries.shift();
      if (telemetry.bufferSeries.length > 48) telemetry.bufferSeries.shift();
      if (!video) {
        telemetry.currentMbps = 0;
      }
    }

    function processPayload(payload, source = "") {
      try {
        const videoGroups = collectPlayAddressGroups(payload);
        const liveGroups = collectLiveStreamGroups(payload, nativeJsonParse);
        registry.register(videoGroups, source);
        liveRegistry.register(liveGroups, source);
        if (settings.enabled && settings.autoSwitch) {
          for (const group of videoGroups) {
            const oldFirst = group.urls[0] || "";
            if (reorderGroup(group, (url) => hostScores.score(url))) {
              const newFirst = group.urls[0] || "";
              if (Date.now() - lastCandidateReorderAt > 1500) {
                recordDiagnostic(
                  "candidateReorders",
                  `主动预选线路：${hostFromUrl(oldFirst) || "原线路"} → ${
                    hostFromUrl(newFirst) || "备用线路"
                  }`,
                );
                lastCandidateReorderAt = Date.now();
              }
            }
          }
        }
        if (videoGroups.length > 0 || liveGroups.length > 0) {
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
      if (!settings.enabled) return current;
      const better = selectLiveReroute(
        current,
        liveRegistry,
        liveRerouteGate,
        (url) => hostScores.score(url),
      );
      if (better) {
        liveRerouteGate.consume(current);
        const signature = `${current}\n${better}`;
        const now = Date.now();
        if (signature !== lastRerouteSignature || now - lastRerouteAt > 30000) {
          const oldHost = hostFromUrl(current) || "原线路";
          const newHost = hostFromUrl(better) || "备用线路";
          recordDiagnostic("requestReroutes", `实际改写直播请求：${oldHost} → ${newHost}`);
          lastRerouteSignature = signature;
          lastRerouteAt = now;
        }
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
          const requestUrl = this.__dyAcceleratorRequestUrl || "";
          if (isLiveMediaUrl(requestUrl) || registry.knows(requestUrl)) {
            let lastLoaded = 0;
            let lastProgressAt = pageWindow.performance.now();
            this.addEventListener("progress", (event) => {
              const now = pageWindow.performance.now();
              const loaded = Number(event.loaded) || 0;
              noteNetworkTransfer(loaded - lastLoaded, now - lastProgressAt);
              lastLoaded = loaded;
              lastProgressAt = now;
            });
          }
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
          lastMediaTime: Number.NaN,
          lastProgressAt: pageWindow.performance.now(),
          softRetries: 0,
          syntheticStall: false,
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
      state.syntheticStall = false;
      if (Number.isFinite(video.currentTime)) {
        state.lastMediaTime = video.currentTime;
        state.lastProgressAt = pageWindow.performance.now();
      }
      if (healthy) {
        if (!state.healthySince) state.healthySince = Date.now();
        if (Date.now() - state.healthySince > 15000) {
          state.switches = 0;
          state.softRetries = 0;
          state.attempted.clear();
        }
      }
    }

    function resetPlaybackWatchdog(video, state = getVideoState(video)) {
      state.waitSince = 0;
      state.syntheticStall = false;
      state.lastMediaTime = Number(video.currentTime) || 0;
      state.lastProgressAt = pageWindow.performance.now();
    }

    function beginStallEpisode(video, message, detectedSince = 0) {
      const state = getVideoState(video);
      if (!state.waitSince) {
        state.waitSince = detectedSince || pageWindow.performance.now();
        recordStallEvent();
      }
      state.healthySince = 0;
      setMessage(message);
    }

    function observePlaybackProgress(video, live) {
      const state = getVideoState(video);
      const now = pageWindow.performance.now();
      if (
        document.visibilityState === "hidden" ||
        video.paused ||
        video.ended ||
        video.seeking ||
        video.readyState === 0
      ) {
        state.lastMediaTime = Number(video.currentTime) || 0;
        state.lastProgressAt = now;
        state.syntheticStall = false;
        return;
      }

      const clock = updatePlaybackClock(
        {
          lastMediaTime: state.lastMediaTime,
          lastProgressAt: state.lastProgressAt,
        },
        video.currentTime,
        now,
        live ? 5500 : 2800,
      );
      state.lastMediaTime = clock.lastMediaTime;
      state.lastProgressAt = clock.lastProgressAt;
      if (clock.stalled) state.syntheticStall = true;
      if (clock.stalled && !state.waitSince) {
        beginStallEpisode(
          video,
          live ? "检测到直播画面停止前进" : "检测到画面停止前进",
          clock.lastProgressAt,
        );
      }
    }

    function attachVideo(video) {
      if (attachedVideos.has(video)) return;
      attachedVideos.add(video);
      getVideoState(video);

      video.addEventListener("waiting", () =>
        beginStallEpisode(video, "检测到缓冲，正在观察"),
      );
      video.addEventListener("stalled", () =>
        beginStallEpisode(video, "连接暂时停滞"),
      );
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

      const resumeAt = Number.isFinite(video.currentTime) ? video.currentTime : 0;
      const shouldPlay = !video.paused;
      const playbackRate = video.playbackRate;
      const oldHost = hostFromUrl(currentVideoUrl(video)) || "当前线路";
      const newHost = hostFromUrl(alternative) || "备用线路";
      const actionMessage = `${manual ? "手动" : "自动"}切换播放源：${oldHost} → ${newHost}`;
      setMessage(`正在${manual ? "手动" : "自动"}尝试备用线路`);

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
          resetPlaybackWatchdog(video, state);
        }
      };

      video.addEventListener("loadedmetadata", onMetadata, { once: true });
      try {
        video.src = alternative;
        video.load();
        recordDiagnostic("sourceSwitches", actionMessage);
        pageWindow.setTimeout(() => {
          state.recovering = false;
        }, 8000);
        return true;
      } catch (error) {
        state.recovering = false;
        resetPlaybackWatchdog(video, state);
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
        if (state.softRetries < 1 || manual) {
          return softRecoverVideo(video, manual);
        }
        resetPlaybackWatchdog(video, state);
        setMessage("当前是 Blob/MSE 播放，等待页面下发新片段");
        return false;
      }
      if (!manual && state.switches >= settings.maxSwitches) {
        resetPlaybackWatchdog(video, state);
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
        if (state.softRetries < 1 || manual) {
          return softRecoverVideo(video, manual);
        }
        resetPlaybackWatchdog(video, state);
        setMessage("没有匹配到站点下发的备用地址，已唤醒播放器");
        return false;
      }
      return switchVideoSource(video, alternatives[0], manual);
    }

    function softRecoverVideo(video, manual = false) {
      const state = getVideoState(video);
      if (state.recovering) return false;
      state.recovering = true;
      let nudged = false;
      try {
        if (video.buffered && video.buffered.length > 0) {
          const bufferedEnd = video.buffered.end(video.buffered.length - 1);
          if (
            Number.isFinite(bufferedEnd) &&
            bufferedEnd > video.currentTime + 0.12
          ) {
            video.currentTime = Math.min(
              bufferedEnd - 0.05,
              video.currentTime + 0.08,
            );
            nudged = true;
          }
        }
        const playResult = video.play();
        if (playResult && typeof playResult.catch === "function") {
          playResult.catch(() => {});
        }
      } catch {
        // A managed MSE element can reject a seek while changing segments.
      }
      state.softRetries += 1;
      resetPlaybackWatchdog(video, state);
      recordDiagnostic(
        "playerRetries",
        `${manual ? "手动" : "自动"}${
          nudged ? "推进短视频时间轴并唤醒播放器" : "唤醒短视频播放器"
        }`,
      );
      pageWindow.setTimeout(() => {
        state.recovering = false;
      }, 3000);
      return true;
    }

    function findLiveRetryControl() {
      const retryPattern = /^(?:重新加载|重新连接|点击重试|重试播放|刷新直播|重新进入直播)$/;
      return [...document.querySelectorAll("button,[role='button']")].find((element) => {
        const text = (element.textContent || "").trim();
        const rect = element.getBoundingClientRect();
        return retryPattern.test(text) && rect.width > 0 && rect.height > 0;
      });
    }

    function softRecoverLive(video, current, manual = false) {
      const state = getVideoState(video);
      if (current) liveRerouteGate.arm(current);
      let jumpedToLiveEdge = false;
      try {
        if (video.buffered && video.buffered.length > 0) {
          const liveEdge = video.buffered.end(video.buffered.length - 1);
          if (Number.isFinite(liveEdge) && liveEdge > video.currentTime + 0.35) {
            video.currentTime = Math.max(0, liveEdge - 0.12);
            jumpedToLiveEdge = true;
          }
        }
        const playResult = video.play();
        if (playResult && typeof playResult.catch === "function") {
          playResult.catch(() => {});
        }
      } catch {
        // The site player may reject a seek while it rebuilds MSE.
      }
      state.softRetries += 1;
      resetPlaybackWatchdog(video, state);
      recordDiagnostic(
        "playerRetries",
        `${manual ? "手动" : "自动"}${
          jumpedToLiveEdge ? "跳到直播最新缓冲" : "唤醒直播播放器并准备备用线路"
        }`,
      );
      pageWindow.setTimeout(() => {
        state.recovering = false;
      }, 5000);
      return true;
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
        if (current) liveRerouteGate.arm(current);
        retryControl.click();
        state.softRetries += 1;
        resetPlaybackWatchdog(video, state);
        recordDiagnostic(
          "playerRetries",
          `${manual ? "手动" : "自动"}触发直播播放器重连`,
        );
        pageWindow.setTimeout(() => {
          state.recovering = false;
        }, 5000);
        return true;
      }

      if (state.softRetries < 1) {
        return softRecoverLive(video, current, manual);
      }

      if (!manual && !settings.liveAutoReload) {
        state.recovering = false;
        resetPlaybackWatchdog(video, state);
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
        resetPlaybackWatchdog(video, state);
        setMessage("直播重连冷却中，避免连续刷新");
        return false;
      }
      if (!manual && liveRecovery.timestamps.length >= 2) {
        state.recovering = false;
        resetPlaybackWatchdog(video, state);
        setMessage("10 分钟内已自动重连两次，暂停自动刷新");
        return false;
      }

      liveRecovery.timestamps.push(now);
      liveRecovery.badHost = hostFromUrl(current);
      saveLiveRecovery();
      recordDiagnostic(
        "pageReloads",
        `${manual ? "手动" : "自动"}刷新直播页面重连`,
      );
      pageWindow.setTimeout(() => pageWindow.location.reload(), 500);
      return true;
    }

    function installPerformanceObserver() {
      if (!pageWindow.PerformanceObserver) return;
      try {
        const observer = new pageWindow.PerformanceObserver((list) => {
          for (const entry of list.getEntries()) {
            const knownVideo = registry.knows(entry.name);
            const knownLive = isLiveMediaUrl(entry.name);
            if (entry.duration > 0 && knownVideo) {
              hostScores.noteSuccess(entry.name);
            }
            if (knownLive) {
              lastLiveMediaUrl = normalizeUrl(entry.name);
              if (entry.duration > 0 && liveRegistry.knows(entry.name)) {
                hostScores.noteSuccess(entry.name);
              }
            }
            if (entry.duration > 0 && (knownVideo || knownLive)) {
              noteNetworkTransfer(
                entry.transferSize || entry.encodedBodySize || entry.decodedBodySize,
                entry.duration,
              );
            }
          }
        });
        observer.observe({ type: "resource", buffered: true });
      } catch {
        // Older browsers may not support buffered resource observation.
      }
    }

    // The information hierarchy follows realzza/bilibili-accelerator's MIT panel:
    // connection state first, live chart second, then one main switch and details.
    function createUi() {
      if (!document.documentElement || document.getElementById("dy-accelerator-root")) return;
      const host = document.createElement("div");
      host.id = "dy-accelerator-root";
      host.style.cssText =
        "all:initial;position:fixed;right:18px;bottom:20px;z-index:2147483647;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI','PingFang SC',sans-serif";
      const shadow = host.attachShadow({ mode: "open" });
      shadow.innerHTML = `
        <style>
          *{box-sizing:border-box}
          button,input{font:inherit}
          button{color:inherit}
          #launcher{display:grid;place-items:center;width:48px;height:48px;border:0;border-radius:50%;cursor:pointer;background:linear-gradient(145deg,#00e7d4,#00b9e8);color:#fff;font-size:25px;box-shadow:0 10px 30px #00c8d766;transition:.2s transform,.2s filter}
          #launcher:hover{transform:translateY(-2px);filter:brightness(1.06)}
          #launcher.off{background:#9099a7;box-shadow:0 8px 24px #0003}
          #panel{--bg:#fff;--surface:#f5f7fa;--surface2:#edf1f6;--text:#181c24;--muted:#8a94a5;--line:#e8ebf0;--accent:#00bfc8;--accent-soft:#e6fbfa;display:none;position:absolute;right:0;bottom:58px;width:344px;max-height:calc(100vh - 92px);overflow:auto;color:var(--text);background:var(--bg);border:1px solid var(--line);border-radius:20px;box-shadow:0 18px 60px #1a243133}
          #panel[data-theme="dark"]{--bg:#171a21;--surface:#222630;--surface2:#292e39;--text:#f4f6fa;--muted:#939dac;--line:#303642;--accent:#29d9d1;--accent-soft:#143a3b}
          #panel.open{display:block}
          .inner{padding:17px}
          .top{display:flex;align-items:center;justify-content:space-between}
          .brand{display:flex;align-items:center;gap:8px;font-size:14px;font-weight:700}
          .brand-bolt{display:grid;place-items:center;width:27px;height:27px;border-radius:9px;background:linear-gradient(145deg,#00e2d3,#00aeea);color:#fff;font-size:15px}
          .themes{display:flex;padding:3px;border-radius:9px;background:var(--surface)}
          .theme{width:27px;height:25px;padding:0;border:0;border-radius:7px;background:transparent;cursor:pointer;color:var(--muted)}
          .theme.active{background:var(--bg);color:var(--text);box-shadow:0 1px 5px #0002}
          .hero{text-align:center;padding:22px 5px 18px}
          .state-dot{display:inline-block;width:9px;height:9px;margin-right:7px;border-radius:50%;background:#24c981;box-shadow:0 0 0 6px #24c98118}
          .state-dot.busy{background:#ffb020;box-shadow:0 0 0 6px #ffb02018}
          .state-dot.off{background:#9aa2af;box-shadow:none}
          .state-title{font-size:20px;font-weight:700;letter-spacing:.2px}
          .state-sub{min-height:18px;margin-top:6px;color:var(--muted);font-size:11px;line-height:1.5}
          .counter{display:inline-flex;align-items:center;gap:5px;margin-top:10px;padding:4px 9px;border-radius:99px;background:var(--accent-soft);color:var(--accent);font-size:10px;font-weight:600}
          .speed-card{padding:13px 14px 8px;border-radius:15px;background:var(--surface);overflow:hidden}
          .speed-top{display:flex;align-items:flex-start;justify-content:space-between}
          .speed-label{font-size:11px;color:var(--muted)}
          .speed-value{margin-top:2px;font-size:21px;font-weight:750}
          .speed-unit{margin-left:3px;font-size:10px;color:var(--muted);font-weight:500}
          .mode-pill{padding:4px 7px;border-radius:7px;background:var(--bg);font-size:9px;color:var(--muted)}
          #chart{display:block;width:100%;height:56px;margin-top:3px}
          .main-row,.setting-row{display:flex;align-items:center;justify-content:space-between}
          .main-row{padding:17px 2px 12px;font-size:14px;font-weight:700}
          .switch{position:relative;width:42px;height:24px;flex:none}
          .switch input{position:absolute;opacity:0;pointer-events:none}
          .slider{position:absolute;inset:0;border-radius:99px;background:#b8bec8;cursor:pointer;transition:.2s}
          .slider:after{content:"";position:absolute;left:3px;top:3px;width:18px;height:18px;border-radius:50%;background:#fff;box-shadow:0 1px 4px #0003;transition:.2s}
          .switch input:checked+.slider{background:var(--accent)}
          .switch input:checked+.slider:after{transform:translateX(18px)}
          #boost{display:none;width:100%;margin:2px 0 10px;padding:10px;border:1px solid var(--accent);border-radius:11px;background:var(--accent-soft);color:var(--accent);font-size:12px;font-weight:650;cursor:pointer}
          #boost.show{display:block}
          #advancedToggle{display:flex;align-items:center;justify-content:space-between;width:100%;padding:12px 2px;border:0;border-top:1px solid var(--line);background:transparent;font-size:12px;font-weight:650;cursor:pointer}
          #chevron{color:var(--muted);transition:.2s transform}
          #advancedToggle.open #chevron{transform:rotate(180deg)}
          #advanced[hidden]{display:none}
          .setting-row{padding:8px 1px;font-size:11px}
          .setting-row .switch{transform:scale(.86);transform-origin:right center}
          .grid{display:grid;grid-template-columns:1fr 1fr;gap:7px;margin-top:8px}
          .metric{min-width:0;padding:9px;border-radius:10px;background:var(--surface)}
          .metric-label{display:block;color:var(--muted);font-size:9px}
          .metric-value{display:block;margin-top:3px;overflow:hidden;color:var(--text);font-size:11px;font-weight:650;text-overflow:ellipsis;white-space:nowrap}
          .last-action{margin-top:8px;padding:9px;border-radius:10px;background:var(--surface);color:var(--muted);font-size:9px;line-height:1.45;word-break:break-all}
          .actions{display:flex;gap:7px;margin-top:8px}
          .actions button{flex:1;padding:8px 5px;border:1px solid var(--line);border-radius:9px;background:var(--bg);font-size:10px;cursor:pointer}
          .foot{padding-top:9px;color:var(--muted);font-size:8px;line-height:1.45;text-align:center}
        </style>
        <button id="launcher" title="抖音 Web 播放加速器">⚡</button>
        <section id="panel">
          <div class="inner">
            <div class="top">
              <div class="brand"><span class="brand-bolt">⚡</span><span>抖音 Web 加速器</span></div>
              <div class="themes">
                <button class="theme" data-theme="light" title="浅色">☀</button>
                <button class="theme" data-theme="dark" title="深色">☾</button>
              </div>
            </div>
            <div class="hero">
              <div><span id="stateDot" class="state-dot"></span><span id="stateTitle" class="state-title">正在连接</span></div>
              <div id="stateSub" class="state-sub">正在等待抖音播放器</div>
              <div id="counter" class="counter">⚡ 尚未介入</div>
            </div>
            <div class="speed-card">
              <div class="speed-top">
                <div><div id="speedLabel" class="speed-label">前方缓冲</div><div class="speed-value"><span id="speedValue">0.0</span><span id="speedUnit" class="speed-unit">秒</span></div></div>
                <span id="modePill" class="mode-pill">等待播放器</span>
              </div>
              <canvas id="chart"></canvas>
            </div>
            <div class="main-row"><span>加速</span><label class="switch"><input id="enabled" type="checkbox"><span class="slider"></span></label></div>
            <button id="boost">还在卡？立即恢复</button>
            <button id="advancedToggle"><span>高级设置</span><span id="chevron">⌄</span></button>
            <div id="advanced" hidden>
              <div class="setting-row"><span>卡顿时自动恢复</span><label class="switch"><input id="autoSwitch" type="checkbox"><span class="slider"></span></label></div>
              <div class="setting-row"><span>直播卡死时刷新重连</span><label class="switch"><input id="liveAutoReload" type="checkbox"><span class="slider"></span></label></div>
              <div class="setting-row"><span>积极模式（更早处理）</span><label class="switch"><input id="aggressive" type="checkbox"><span class="slider"></span></label></div>
              <div class="grid">
                <div class="metric"><span class="metric-label">播放模式</span><span id="mode" class="metric-value">—</span></div>
                <div class="metric"><span class="metric-label">候选线路</span><span id="candidates" class="metric-value">0</span></div>
                <div class="metric"><span class="metric-label">卡顿事件</span><span id="stalls" class="metric-value">0</span></div>
                <div class="metric"><span class="metric-label">实际介入</span><span id="interventions" class="metric-value">0</span></div>
                <div class="metric"><span class="metric-label">当前线路</span><span id="hostName" class="metric-value">—</span></div>
                <div class="metric"><span class="metric-label">前方缓冲</span><span id="buffer" class="metric-value">—</span></div>
              </div>
              <div id="lastAction" class="last-action">最近介入：尚无</div>
              <div class="actions"><button id="copy">复制诊断</button><button id="reset">重置统计</button></div>
              <div class="foot">v${VERSION} · 仅使用页面下发的已签名候选地址<br>面板结构借鉴 bilibili-accelerator（MIT）</div>
            </div>
          </div>
        </section>
      `;
      document.documentElement.appendChild(host);

      const panel = shadow.getElementById("panel");
      const launcher = shadow.getElementById("launcher");
      const themeButtons = [...shadow.querySelectorAll(".theme")];

      function resolvedTheme() {
        if (settings.theme === "light" || settings.theme === "dark") {
          return settings.theme;
        }
        return pageWindow.matchMedia &&
          pageWindow.matchMedia("(prefers-color-scheme: dark)").matches
          ? "dark"
          : "light";
      }

      function applyTheme() {
        const theme = resolvedTheme();
        panel.dataset.theme = theme;
        for (const button of themeButtons) {
          button.classList.toggle("active", button.dataset.theme === theme);
        }
      }

      function drawChart() {
        const canvas = shadow.getElementById("chart");
        const width = Math.floor(canvas.getBoundingClientRect().width);
        if (!width) return;
        const height = 56;
        const ratio = Math.min(2, pageWindow.devicePixelRatio || 1);
        canvas.width = Math.floor(width * ratio);
        canvas.height = Math.floor(height * ratio);
        const context = canvas.getContext("2d");
        context.scale(ratio, ratio);
        const series =
          telemetry.mode === "speed" ? telemetry.mbpsSeries : telemetry.bufferSeries;
        const values = series.length > 1 ? series : [0, 0];
        const max = Math.max(1, ...values) * 1.15;
        const accent = getComputedStyle(panel).getPropertyValue("--accent").trim();
        const gradient = context.createLinearGradient(0, 0, 0, height);
        gradient.addColorStop(0, `${accent}55`);
        gradient.addColorStop(1, `${accent}00`);
        context.beginPath();
        values.forEach((value, index) => {
          const x = (index / Math.max(1, values.length - 1)) * width;
          const y = height - 5 - (Math.max(0, value) / max) * (height - 12);
          if (index === 0) context.moveTo(x, y);
          else context.lineTo(x, y);
        });
        context.strokeStyle = accent;
        context.lineWidth = 2;
        context.stroke();
        context.lineTo(width, height);
        context.lineTo(0, height);
        context.closePath();
        context.fillStyle = gradient;
        context.fill();
      }

      launcher.addEventListener("click", () => {
        panel.classList.toggle("open");
        if (panel.classList.contains("open")) {
          pageWindow.requestAnimationFrame(drawChart);
        }
      });

      for (const button of themeButtons) {
        button.addEventListener("click", () => {
          settings.theme = button.dataset.theme;
          saveSettings();
          applyTheme();
          drawChart();
        });
      }

      for (const key of ["enabled", "autoSwitch", "liveAutoReload", "aggressive"]) {
        const input = shadow.getElementById(key);
        input.checked = Boolean(settings[key]);
        input.addEventListener("change", () => {
          settings[key] = input.checked;
          if ((key === "enabled" || key === "autoSwitch") && !settings[key]) {
            liveRerouteGate.clear();
          }
          saveSettings();
          ui.render();
        });
      }

      shadow.getElementById("advancedToggle").addEventListener("click", (event) => {
        const details = shadow.getElementById("advanced");
        details.hidden = !details.hidden;
        event.currentTarget.classList.toggle("open", !details.hidden);
      });

      shadow.getElementById("boost").addEventListener("click", () => {
        activeVideo = chooseActiveVideo();
        if (activeVideo && isLiveVideo(activeVideo)) {
          recoverLive(activeVideo, true);
        } else {
          recoverVideo(activeVideo, true);
        }
      });
      shadow.getElementById("reset").addEventListener("click", () => {
        hostScores.reset();
        diagnostics = createDiagnostics();
        saveDiagnostics();
        setMessage("诊断统计和线路评分已清除");
      });
      shadow.getElementById("copy").addEventListener("click", () => {
        const report = JSON.stringify(
          {
            version: VERSION,
            page: pageWindow.location.href,
            message: lastMessage,
            diagnostics,
          },
          null,
          2,
        );
        if (pageWindow.navigator.clipboard) {
          pageWindow.navigator.clipboard.writeText(report).catch(() => {});
        }
        setMessage("诊断信息已复制");
      });

      ui = {
        render() {
          const video = activeVideo;
          const ahead = video ? bufferAhead(video) : 0;
          const current = currentVideoUrl(video);
          const live = Boolean(video && isLiveVideo(video));
          const displayUrl = current || (live ? lastLiveMediaUrl : "");
          const candidateRegistry = live ? liveRegistry : registry;
          const candidateCount = displayUrl
            ? candidateRegistry.candidateUrls(displayUrl).length
            : 0;
          const interventions = interventionCount(diagnostics);
          const videoState = video ? getVideoState(video) : null;
          const busy = Boolean(videoState && (videoState.waitSince || videoState.recovering));
          const title = !settings.enabled
            ? "加速已暂停"
            : !video
              ? "正在连接"
              : busy
                ? "正在优化连接"
                : "播放流畅";
          shadow.getElementById("stateTitle").textContent = title;
          shadow.getElementById("stateSub").textContent = settings.enabled
            ? video
              ? busy
                ? lastMessage
                : "已连接到当前可用的播放线路"
              : "正在等待抖音播放器"
            : "打开下方“加速”开关即可继续";
          const stateDot = shadow.getElementById("stateDot");
          stateDot.classList.toggle("busy", busy);
          stateDot.classList.toggle("off", !settings.enabled);
          shadow.getElementById("counter").textContent =
            interventions > 0 ? `⚡ 已实际介入 ${interventions} 次` : "⚡ 已启动，尚未介入";
          const speedMode = telemetry.mode === "speed" && telemetry.currentMbps > 0.01;
          shadow.getElementById("speedLabel").textContent = speedMode
            ? "实时媒体下载速度"
            : "前方缓冲";
          shadow.getElementById("speedValue").textContent = speedMode
            ? telemetry.currentMbps.toFixed(1)
            : ahead.toFixed(1);
          shadow.getElementById("speedUnit").textContent = speedMode ? "Mbps" : "秒";
          shadow.getElementById("modePill").textContent = video
            ? live
              ? "直播"
              : "短视频"
            : "等待播放器";
          shadow.getElementById("boost").classList.toggle(
            "show",
            Boolean(video && (busy || diagnostics.stallEvents > 0)),
          );
          shadow.getElementById("mode").textContent = video
            ? live
              ? "直播"
              : "短视频"
            : "等待播放器";
          shadow.getElementById("buffer").textContent = video
            ? `${ahead.toFixed(1)} 秒`
            : "—";
          shadow.getElementById("candidates").textContent = String(candidateCount);
          shadow.getElementById("hostName").textContent =
            hostFromUrl(displayUrl) || "Blob / 未知";
          shadow.getElementById("stalls").textContent = String(diagnostics.stallEvents);
          shadow.getElementById("interventions").textContent = String(interventions);
          shadow.getElementById("lastAction").textContent = diagnostics.lastActionAt
            ? `最近介入：${new Date(diagnostics.lastActionAt).toLocaleTimeString()} · ${diagnostics.lastAction}`
            : "最近介入：尚无";
          launcher.classList.toggle("off", !settings.enabled);
          drawChart();
        },
      };
      applyTheme();
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
      observePlaybackProgress(activeVideo, live);
      sampleTelemetry(activeVideo, ahead);
      if (
        settings.autoSwitch &&
        state.waitSince &&
        !state.recovering &&
        (ahead < 0.35 || state.syntheticStall) &&
        !activeVideo.paused
      ) {
        const threshold = state.syntheticStall
          ? 0
          : live
            ? settings.aggressive
              ? 7000
              : 12000
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
    createDiagnostics,
    createHostScores,
    createLiveRerouteGate,
    hostFromUrl,
    interventionCount,
    isLiveMediaUrl,
    liveProtocolFromKey,
    normalizeLiveQuality,
    normalizeUrl,
    reorderGroup,
    selectLiveReroute,
    throughputMbps,
    updatePlaybackClock,
    boot,
  };
});
