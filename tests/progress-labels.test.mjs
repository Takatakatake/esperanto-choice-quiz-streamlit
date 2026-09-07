import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import vm from "node:vm";

const source = readFileSync(new URL("../mobile_app/app.js", import.meta.url), "utf8");
const functions = [
  "currentLangMeta", "t", "modeLabel", "renderProgress",
  "formatProgressLevelLabel", "labelForPos", "createProgressRow",
].map((name) => {
  const start = source.indexOf(`function ${name}(`);
  assert.notEqual(start, -1, `Application renderer ${name} must exist`);
  const end = source.indexOf("\nfunction ", start + 1);
  return source.slice(start, end === -1 ? undefined : end);
}).join("\n");
const constants = ["TARGET_LANG_META", "POS_LABELS", "STAGE_LABELS"].map((name) => {
  const start = source.indexOf(`const ${name} =`);
  assert.notEqual(start, -1, `Application labels ${name} must exist`);
  return source.slice(start, source.indexOf("\n};", start) + 3);
}).join("\n");

// Render the actual application functions; replace only the DOM surface they use.
class Element {
  constructor(tag = "div") {
    this.tagName = tag.toUpperCase();
    this.children = [];
    this.dataset = {};
    this.className = "";
    this.classList = { toggle() {} };
    this.textContent = "";
    this.open = false;
  }
  append(...children) { this.children.push(...children); }
  replaceChildren(...children) { this.children = children; }
}

function nodesWithin(element) {
  return [element, ...element.children.flatMap(nodesWithin)];
}

function renderProgressFor(locale) {
  const level = (key, points) => ({ key, points, attempts: points ? 1 : 0 });
  const vocab = (key, points, levels = []) => ({ key, points, attempts: 1, levels, subtopics: [] });
  const sentence = (key, points, subtopics = []) => ({ key, points, attempts: 1, subtopics, levels: [] });
  const progress = {
    status: "ready", user: "Legacy-Labels", targetLang: locale.lang, message: "",
    settings: { ok: true, rankingPublic: false, message: "" },
    totals: { overall: 49, vocab: 15, sentence: 34 },
    categories: {
      vocab: [
        vocab("unknown", 1, [level("beginner", 0), level("intermediate", 0), level("advanced", 0), level("unknown", 1)]),
        vocab("", 2, [level("unknown", 2)]),
        vocab("noun", 3, [level("beginner", 3)]),
        vocab("名詞", 4),
        vocab("custom_pos", 5),
      ],
      sentence: [
        sentence("unknown", 6, [sentence("unknown", 1), sentence("", 2), sentence("Train", 3)]),
        sentence("", 4),
        sentence("Travel", 7, [sentence("Weather", 7)]),
        sentence("独自テーマ", 8, [sentence("独自小テーマ", 8)]),
        sentence("Unknown", 9),
      ],
    },
  };
  const original = JSON.stringify(progress);
  const els = Object.fromEntries([
    "progressRefreshButton", "rankingPublic", "rankingSettingsStatus", "progressStatus", "progressContent",
  ].map((name) => [name, new Element()]));
  let heightRequests = 0;
  const context = vm.createContext({
    state: { progress, mobileConfig: { targetLang: locale.lang } }, els,
    IS_STREAMLIT_COMPONENT: true, currentUserName: () => "Legacy-Labels",
    document: { createElement: (tag) => new Element(tag) },
    requestFrameHeightSync: () => { heightRequests += 1; },
  });
  vm.runInContext(`${constants}\n${functions}`, context);
  context.renderProgress();
  assert.equal(JSON.stringify(progress), original, "Rendering must not rewrite category keys, points or account settings");
  assert.equal(heightRequests, 1, "Keep the existing layout-height notification");
  return els.progressContent;
}

for (const locale of [
  { lang: "ja", uncategorized: "未分類", noun: "名詞", levels: ["初級", "中級", "上級"], unknownLevel: "レベル不明", unit: "点" },
  { lang: "zh", uncategorized: "未分类", noun: "名词", levels: ["初级", "中级", "高级"], unknownLevel: "级别不明", unit: "分" },
  { lang: "ko", uncategorized: "미분류", noun: "명사", levels: ["초급", "중급", "고급"], unknownLevel: "수준 미상", unit: "점" },
]) {
  test(`progress category labels localize missing classifications while preserving legacy labels and scores in ${locale.lang}`, () => {
    const root = renderProgressFor(locale);
    const categoryRows = (mode) => nodesWithin(root.children.find((node) => node.dataset.progressMode === mode))
      .filter((node) => node.className === "progress-category-row")
      .map((node) => node.children.map((child) => child.textContent));
    const row = (label, points) => [label, `${points.toFixed(1)}${locale.unit}`];
    assert.deepEqual(categoryRows("vocab"), [
      row(locale.uncategorized, 1),
      row(locale.levels[0], 0), row(locale.levels[1], 0), row(locale.levels[2], 0), row(locale.unknownLevel, 1),
      row(locale.uncategorized, 2), row(locale.unknownLevel, 2),
      row(locale.noun, 3), row(locale.levels[0], 3),
      row("名詞", 4), row("custom_pos", 5),
    ]);
    assert.deepEqual(categoryRows("sentence"), [
      row(locale.uncategorized, 6), row(locale.uncategorized, 1), row(locale.uncategorized, 2), row("Train", 3),
      row(locale.uncategorized, 4), row("Travel", 7), row("Weather", 7),
      row("独自テーマ", 8), row("独自小テーマ", 8), row("Unknown", 9),
    ]);
    assert.deepEqual(root.children[0].children.map((card) => card.children[1].textContent),
      [49, 15, 34].map((points) => `${points.toFixed(1)}${locale.unit}`));
    const details = nodesWithin(root).filter((node) => node.tagName === "DETAILS");
    assert.equal(details.length, 6);
    assert.ok(details.every((node) => !node.open && node.children[0].tagName === "SUMMARY"),
      "Keep the same native, initially collapsed details/summary structure");
  });
}
