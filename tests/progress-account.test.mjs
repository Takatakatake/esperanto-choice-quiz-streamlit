import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import vm from "node:vm";
import { matchesAccountResult, SerializedBridge } from "../mobile_app/learning_sync.mjs";

const source = readFileSync(new URL("../mobile_app/app.js", import.meta.url), "utf8");
const handlers = ["handleProgressResult", "createEmptyRankingsState", "isPlainObject"].map((name) => {
  const start = source.indexOf(`function ${name}(`);
  assert.notEqual(start, -1, `Application handler ${name} must exist`);
  const end = source.indexOf("\nfunction ", start + 1);
  return source.slice(start, end === -1 ? undefined : end);
}).join("\n");

function progressApp({ previousPublic = true, uncertain = false, requestedUser = "A", currentUser = requestedUser, currentLang = "ja", view = "history" } = {}) {
  const state = {
    currentView: view,
    mobileConfig: { targetLang: currentLang },
    progress: {
      status: "loading", requestId: "refresh-A", user: requestedUser, targetLang: "ja",
      // requestProgress invalidates settings.ok while retaining the confirmed value.
      settings: { ok: false, rankingPublic: previousPublic }, settingsUncertain: uncertain,
      settingsPending: false, totals: { overall: 200, vocab: 150, sentence: 50 },
    },
    rankings: { status: "ready", rankings: { overall: [{ user: "A", points: 200 }] } },
  };
  const requests = [];
  const rendered = [];
  const bridge = new SerializedBridge({ send: () => {}, schedule: () => 1, cancel: () => {}, onTimeout: () => {} });
  bridge.enqueue({ type: "load_progress", requestId: "refresh-A", user: requestedUser });
  bridge.enqueue({ type: "load_rankings", requestId: "stale-ranking-A", user: "A" });
  bridge.enqueue({ type: "save_score", requestId: "authorized-score", user: "A" });
  const app = vm.createContext({
    state, bridgeQueue: bridge, matchesAccountResult, currentUserName: () => currentUser,
    finiteNumber: (value, fallback) => Number.isFinite(Number(value)) ? Number(value) : fallback,
    clampInteger: (value) => value, t: (key) => key,
    requestRankings: (options) => requests.push(options), renderProgress: () => {},
    renderCloudRankings: () => rendered.push(JSON.parse(JSON.stringify(state.rankings))),
  });
  vm.runInContext(handlers, app);
  const result = {
    type: "progress_result", requestId: "refresh-A", user: requestedUser, ok: true,
    totals: { overall: 200, vocab: 150, sentence: 50 }, categories: { vocab: [], sentence: [] },
    settings: { ok: true, rankingPublic: false },
  };
  return { app, state, bridge, requests, rendered, result };
}

test("refreshing progress removes a public ranking after this name becomes private in another tab", () => {
  const { app, state, bridge, requests, result } = progressApp();
  app.handleProgressResult(result);
  assert.equal(state.progress.settings.rankingPublic, false);
  assert.deepEqual(Array.from(state.rankings.rankings.overall), []);
  assert.equal(bridge.pending.some((item) => item.requestId === "stale-ranking-A"), false);
  assert.equal(bridge.pending.some((item) => item.requestId === "authorized-score"), true);
  assert.equal(requests.length, 1);
  assert.equal(requests[0].force, true);
});

test("a failed preference read hides cached public names until preferences can be verified again", () => {
  const { app, state, bridge, requests, rendered, result } = progressApp();
  result.settings = { ok: false, rankingPublic: false, message: "Cannot read preferences" };
  app.handleProgressResult(result);
  assert.equal(state.progress.status, "ready");
  assert.equal(state.progress.totals.overall, 200);
  assert.equal(state.progress.settingsUncertain, true);
  assert.deepEqual(Array.from(state.rankings.rankings.overall), []);
  assert.equal(bridge.pending.some((item) => item.type === "load_rankings"), false);
  assert.equal(requests.length, 0);
  assert.equal(rendered.length, 1);
});

test("confirming publication after an uncertain or changed preference refreshes the public lists", () => {
  for (const options of [{ previousPublic: false }, { uncertain: true }]) {
    const { app, state, requests, result } = progressApp(options);
    result.settings.rankingPublic = true;
    app.handleProgressResult(result);
    assert.equal(state.progress.settingsUncertain, false);
    assert.deepEqual(Array.from(state.rankings.rankings.overall), []);
    assert.equal(requests.length, 1);
  }
});

test("an unchanged public preference keeps its existing ranking cache", () => {
  const { app, state, requests, result } = progressApp();
  result.settings.rankingPublic = true;
  app.handleProgressResult(result);
  assert.equal(state.rankings.rankings.overall[0].user, "A");
  assert.equal(requests.length, 0);
});

test("a late account or language result cannot invalidate the currently displayed rankings", () => {
  for (const options of [{ currentUser: "B" }, { currentLang: "zh" }]) {
    const { app, state, requests, result } = progressApp(options);
    app.handleProgressResult(result);
    assert.equal(state.progress.status, "loading");
    assert.equal(state.rankings.rankings.overall[0].user, "A");
    assert.equal(requests.length, 0);
  }
});

test("leaving the history view still invalidates obsolete names without fetching unused rankings", () => {
  const { app, state, requests, result } = progressApp({ view: "quiz" });
  app.handleProgressResult(result);
  assert.deepEqual(Array.from(state.rankings.rankings.overall), []);
  assert.equal(requests.length, 0);
});

test("invalid-name responses show the validation error immediately and release the bridge", () => {
  for (const requestedUser of ["Ali\tce", "\u0085Alice\u0085"]) {
    const { app, state, bridge, result } = progressApp({ requestedUser });
    result.ok = false;
    result.totals = null;
    result.message = "有効なユーザー名を入力してください。";
    result.settings = { ok: false, rankingPublic: false };
    app.handleProgressResult(result);
    assert.equal(state.progress.status, "error");
    assert.equal(state.progress.message, "有効なユーザー名を入力してください。");
    assert.equal(state.progress.requestId, "");
    assert.equal(bridge.active, null);
  }
});
