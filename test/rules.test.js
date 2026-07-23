"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");

const RULES_PATH = path.join(
  __dirname,
  "..",
  "rules",
  "shadowrocket-douyin-bilibili.list",
);
const DIRECT_CONFIG_PATH = path.join(
  __dirname,
  "..",
  "rules",
  "shadowrocket-douyin-bilibili-direct.conf",
);

function readRules() {
  return fs
    .readFileSync(RULES_PATH, "utf8")
    .split(/\r?\n/u)
    .map((line) => line.trim())
    .filter((line) => line && !line.startsWith("#"));
}

test("combined Shadowrocket list contains valid policy-neutral domain rules", () => {
  const rules = readRules();

  assert.ok(rules.length > 0);
  for (const rule of rules) {
    assert.match(rule, /^(?:DOMAIN|DOMAIN-SUFFIX),[a-z0-9._*-]+$/u);
    assert.equal(rule.split(",").length, 2);
  }
  assert.equal(new Set(rules).size, rules.length);
});

test("combined list covers core Douyin and Bilibili traffic", () => {
  const rules = new Set(readRules());

  for (const rule of [
    "DOMAIN-SUFFIX,douyin.com",
    "DOMAIN-SUFFIX,douyincdn.com",
    "DOMAIN-SUFFIX,douyinvod.com",
    "DOMAIN-SUFFIX,bilibili.com",
    "DOMAIN-SUFFIX,bilivideo.com",
    "DOMAIN-SUFFIX,hdslb.com",
  ]) {
    assert.ok(rules.has(rule), `missing ${rule}`);
  }
});

test("minimal Shadowrocket config imports the combined list without a node", () => {
  const config = fs.readFileSync(DIRECT_CONFIG_PATH, "utf8");
  const ruleSetUrl =
    "https://raw.githubusercontent.com/Orchidroot/douyin-web-accelerator/main/" +
    "rules/shadowrocket-douyin-bilibili.list";

  assert.match(config, /^\[General\]$/mu);
  assert.match(config, /^\[Rule\]$/mu);
  assert.match(
    config,
    new RegExp(`^RULE-SET,${ruleSetUrl.replaceAll(".", String.raw`\.`)},DIRECT$`, "mu"),
  );
  assert.match(config, /^FINAL,DIRECT$/mu);
  assert.doesNotMatch(config, /^\[(?:Proxy|Proxy Group)\]$/mu);
  assert.doesNotMatch(config, /,(?:PROXY|REJECT)$/mu);
});
