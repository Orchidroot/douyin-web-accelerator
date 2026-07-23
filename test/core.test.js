"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const {
  CandidateRegistry,
  assetFingerprint,
  collectLiveStreamGroups,
  collectPlayAddressGroups,
  createDiagnostics,
  createHostScores,
  createLiveRerouteGate,
  interventionCount,
  isLiveMediaUrl,
  reorderGroup,
  selectLiveReroute,
} = require("../douyin-accelerator.user.js");

const URL_A = "https://cdn-a.example.com/tos-cn/video/abc123.mp4?ratio=1080p";
const URL_B = "https://cdn-b.example.com/tos-cn/video/abc123.mp4?ratio=1080p";

test("collects snake_case and camelCase play address lists", () => {
  const payload = {
    aweme_list: [
      { video: { play_addr: { url_list: [URL_A, URL_B] } } },
      { video: { playAddrH264: { urlList: [URL_B, URL_A] } } },
    ],
  };

  const groups = collectPlayAddressGroups(payload);
  assert.equal(groups.length, 2);
  assert.deepEqual(groups[0].urls, [URL_A, URL_B]);
  assert.deepEqual(groups[1].urls, [URL_B, URL_A]);
});

test("does not treat cover image lists as playable alternatives", () => {
  const payload = {
    video: {
      cover: {
        url_list: [
          "https://img-a.example.com/cover.jpg",
          "https://img-b.example.com/cover.jpg",
        ],
      },
    },
  };

  assert.deepEqual(collectPlayAddressGroups(payload), []);
});

test("reorders only existing candidates using host scores", () => {
  const payload = { video: { play_addr: { url_list: [URL_A, URL_B] } } };
  const [group] = collectPlayAddressGroups(payload);
  const changed = reorderGroup(group, (url) => (url.includes("cdn-b") ? 10 : -10));

  assert.equal(changed, true);
  assert.deepEqual(payload.video.play_addr.url_list, [URL_B, URL_A]);
});

test("registry matches redirected hosts by asset fingerprint", () => {
  let now = 1000;
  const registry = new CandidateRegistry(() => now);
  const payload = { video: { play_addr: { url_list: [URL_A, URL_B] } } };
  registry.register(collectPlayAddressGroups(payload));

  const redirected =
    "https://redirected.example.net/tos-cn/video/abc123.mp4?ratio=1080p&token=new";
  assert.equal(assetFingerprint(redirected), assetFingerprint(URL_A));
  assert.deepEqual(registry.candidateUrls(redirected), [URL_A, URL_B]);
  assert.deepEqual(registry.alternatives(redirected), [URL_A, URL_B]);

  now += 6 * 60 * 1000;
  assert.deepEqual(registry.alternatives(redirected), []);
});

test("stall penalties make another host rank first", () => {
  const scores = createHostScores();
  scores.noteStall(URL_A);
  scores.noteSuccess(URL_B);
  assert.ok(scores.score(URL_B) > scores.score(URL_A));
});

test("collects live pull maps without mixing quality or protocol", () => {
  const payload = {
    stream_url: {
      flv_pull_url: {
        ORIGION: "https://pull-a.douyincdn.com/live/room_or4.flv?sign=a",
        HD1: "https://pull-a.douyincdn.com/live/room_hd.flv?sign=b",
      },
      hls_pull_url_map: {
        ORIGION: "https://pull-hls.douyincdn.com/live/room_or4.m3u8?sign=c",
      },
      live_core_sdk_data: {
        pull_data: {
          stream_data: JSON.stringify({
            data: {
              origin: {
                main: {
                  flv: "https://pull-b.douyincdn.com/live/room_or4.flv?sign=d",
                  hls: "https://pull-hls.douyincdn.com/live/room_or4.m3u8?sign=c",
                },
              },
            },
          }),
        },
      },
    },
  };

  const groups = collectLiveStreamGroups(payload);
  const originFlv = groups.find(
    (group) => group.quality === "origin" && group.protocol === "flv",
  );
  assert.equal(originFlv.urls.length, 2);
  assert.ok(groups.some((group) => group.quality === "hd" && group.protocol === "flv"));
  assert.ok(groups.some((group) => group.protocol === "hls"));
});

test("recognizes FLV, HLS and DASH live request URLs", () => {
  assert.equal(isLiveMediaUrl("https://pull.example.com/live/room.flv?sign=1"), true);
  assert.equal(isLiveMediaUrl("https://pull.example.com/live/index.m3u8"), true);
  assert.equal(isLiveMediaUrl("https://pull.example.com/live/index.mpd"), true);
  assert.equal(isLiveMediaUrl("https://www.douyin.com/aweme/v1/web/feed/"), false);
});

test("arms live request rerouting only temporarily and consumes it once", () => {
  let now = 1000;
  const gate = createLiveRerouteGate(() => now);
  const badUrl = "https://pull-a.douyincdn.com/live/room.flv?sign=a";
  const otherHost = "https://pull-b.douyincdn.com/live/room.flv?sign=b";

  assert.equal(gate.canReroute(badUrl), false);
  assert.equal(gate.arm(badUrl, 5000), true);
  assert.equal(gate.canReroute(badUrl), true);
  assert.equal(gate.canReroute(otherHost), false);
  assert.equal(gate.consume(badUrl), true);
  assert.equal(gate.canReroute(badUrl), false);

  gate.arm(badUrl, 5000);
  now += 5000;
  assert.equal(gate.canReroute(badUrl), false);
});

test("does not select a live reroute until recovery explicitly arms it", () => {
  const registry = new CandidateRegistry();
  const gate = createLiveRerouteGate(() => 1000);
  const badUrl = "https://pull-a.douyincdn.com/live/room.flv?sign=a";
  const alternative = "https://pull-b.douyincdn.com/live/room.flv?sign=b";
  registry.register([{ urls: [badUrl, alternative] }]);

  assert.equal(selectLiveReroute(badUrl, registry, gate, () => 0), "");
  gate.arm(badUrl, 5000);
  assert.equal(
    selectLiveReroute(badUrl, registry, gate, () => 0),
    alternative,
  );
});

test("normalizes persisted diagnostics and counts real interventions", () => {
  const diagnostics = createDiagnostics(
    {
      startedAt: 100,
      stallEvents: 4,
      sourceSwitches: 1,
      requestReroutes: 2,
      playerRetries: 1,
      pageReloads: 1,
      lastAction: "自动刷新直播页面重连",
      lastActionAt: 200,
    },
    999,
  );

  assert.equal(diagnostics.stallEvents, 4);
  assert.equal(interventionCount(diagnostics), 5);
  assert.equal(diagnostics.lastAction, "自动刷新直播页面重连");
  assert.equal(diagnostics.lastActionAt, 200);

  const invalid = createDiagnostics({ stallEvents: -1, sourceSwitches: "bad" }, 999);
  assert.equal(invalid.startedAt, 999);
  assert.equal(invalid.stallEvents, 0);
  assert.equal(invalid.sourceSwitches, 0);
});
