import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import vm from "node:vm";
import { addToOutbox, restoreOutbox, matchesAccountResult, filterUserHistory, SerializedBridge, DurableScoreOutbox, canReplaceSession, persistPresentSession, isAccountCacheFresh, matchesScoreRecord, scoreRecordFromSession, hasConfirmedScoreEvidence } from "../mobile_app/learning_sync.mjs";
import { computeResultSummary } from "../mobile_app/quiz_core.mjs";

function score(id, user = "A") {
  return { type: "save_score", requestId: `request-${id}`, saveId: `save-${id}`, sessionId: id, user, points: 12.5, total: 4 };
}

function fakeBridge(onTimeout = () => {}) {
  const sent = [];
  const timers = new Map();
  let counter = 0;
  const queue = new SerializedBridge({
    send: (payload) => sent.push({ ...payload }), onTimeout,
    schedule: (callback, delay) => { const id = ++counter; timers.set(id, { callback, delay }); return id; },
    cancel: (id) => timers.delete(id),
  });
  const advance = (delay) => {
    const ready = [...timers].filter(([, timer]) => timer.delay === delay);
    ready.forEach(([id, timer]) => { timers.delete(id); timer.callback(); });
  };
  return { queue, sent, advance };
}

test("unsent scores survive active-session replacement and history pruning", () => {
  let pending = addToOutbox([], score("first"));
  const stored = JSON.stringify(pending);
  const activeSession = { id: "second" };
  const history = [];
  pending = restoreOutbox(JSON.parse(stored));
  assert.equal(activeSession.id, "second");
  assert.equal(history.length, 0);
  assert.equal(pending.length, 1);
  assert.equal(pending[0].payload.saveId, "save-first");
  assert.equal(pending[0].payload.points, 12.5);
});

test("adopting a completed session twice keeps one immutable save identity", () => {
  const original = addToOutbox([], score("same"));
  const repeated = addToOutbox(original, { ...score("same"), requestId: "retry" });
  assert.equal(repeated.length, 1);
  assert.equal(repeated[0].payload.requestId, "request-same");
  const reloaded = restoreOutbox(JSON.parse(JSON.stringify(repeated)));
  reloaded[0].payload.requestId = "retry-new-request";
  assert.equal(reloaded[0].payload.saveId, "save-same");
});

test("outbox is independent of the 100-item device history limit and preserves failures", () => {
  const entries = Array.from({ length: 105 }, (_, index) => ({ payload: score(String(index)), status: index === 0 ? "error" : "pending", message: "offline" }));
  const restored = restoreOutbox(JSON.parse(JSON.stringify(entries)));
  assert.equal(restored.length, 105);
  assert.equal(restored[0].status, "error");
  assert.equal(restored[0].message, "offline");
});

test("corrupted outbox fails visibly instead of silently dropping pending work", () => {
  assert.throws(() => restoreOutbox({}), /Invalid saved result queue/);
  assert.throws(() => restoreOutbox([{ payload: { ...score("bad"), user: "" } }]), /Invalid saved result/);
  assert.throws(() => restoreOutbox([{ payload: { ...score("bad"), points: null } }]), /Invalid saved result/);
});

test("history and responses retain exact trimmed, case-sensitive user identities", () => {
  assert.deepEqual(filterUserHistory([{ userName: "A" }, { userName: " B " }, { userName: "a" }, { userName: "" }], "A"), [{ userName: "A" }]);
  const pending = { requestId: "r", user: "A", targetLang: "ja" };
  assert.equal(matchesAccountResult({ requestId: "r", user: "A" }, pending, "A", "ja"), true);
  for (const result of [{ requestId: "older", user: "A" }, { requestId: "r", user: "B" }, { requestId: "r" }]) {
    assert.equal(matchesAccountResult(result, pending, "A", "ja"), false);
  }
  assert.equal(matchesAccountResult({ requestId: "r", user: "A" }, pending, "B", "ja"), false);
  assert.equal(matchesAccountResult({ requestId: "r", user: "A" }, pending, "A", "zh"), false);
});

test("all score/progress/settings/ranking requests share a single in-flight bridge", () => {
  const { queue, sent, advance } = fakeBridge();
  queue.enqueue(score("one"));
  queue.enqueue({ type: "load_progress", requestId: "progress", user: "A" });
  queue.enqueue({ type: "save_user_settings", requestId: "settings", user: "A", rankingPublic: false });
  queue.enqueue({ type: "load_rankings", requestId: "ranking", user: "A" });
  assert.equal(sent.length, 1);
  assert.equal(queue.accept({ type: "rankings_result", requestId: "request-one" }), false);
  assert.equal(queue.accept({ type: "score_save_result", requestId: "request-one" }), true);
  assert.equal(sent.length, 1);
  advance(0);
  assert.equal(sent.at(-1).requestId, "progress");
  queue.accept({ type: "progress_result", requestId: "progress", user: "A" }); advance(0);
  assert.equal(sent.at(-1).requestId, "settings");
  queue.accept({ type: "user_settings_result", requestId: "settings", user: "A" }); advance(0);
  assert.equal(sent.at(-1).requestId, "ranking");
});

test("timeouts unblock subsequent requests while late acknowledgements cannot release another account request", () => {
  const failures = [];
  const { queue, sent, advance } = fakeBridge((payload) => failures.push(payload));
  queue.enqueue(score("one"));
  queue.enqueue({ type: "load_progress", requestId: "progress-b", user: "B" });
  advance(30000);
  assert.equal(failures[0].saveId, "save-one");
  assert.equal(sent.at(-1).user, "B");
  assert.equal(queue.accept({ type: "score_save_result", requestId: "request-one" }), false);
  assert.equal(queue.active.requestId, "progress-b");
});

test("switching names can discard stale queued reads without losing an authorized save", () => {
  const { queue, sent, advance } = fakeBridge();
  queue.enqueue(score("one"));
  queue.enqueue({ type: "load_progress", requestId: "progress-a", user: "A" });
  queue.enqueue({ type: "save_user_settings", requestId: "settings-a", user: "A", rankingPublic: false });
  queue.discardPending((payload) => payload.type === "load_progress");
  queue.accept({ type: "score_save_result", requestId: "request-one" }); advance(0);
  assert.equal(sent.at(-1).requestId, "settings-a");
});

test("synchronous bridge failure reports the failed request and releases the queue", () => {
  const failures = [];
  const queue = new SerializedBridge({
    send: () => { throw new Error("transport unavailable"); },
    onTimeout: (payload, error) => failures.push({ payload, error }),
  });
  queue.enqueue(score("one"));
  assert.equal(queue.active, null);
  assert.equal(failures[0].payload.saveId, "save-one");
  assert.match(failures[0].error.message, /transport unavailable/);
});


test("a response for the wrong user cannot cancel the active request timeout", () => {
  const { queue, advance } = fakeBridge();
  queue.enqueue({ type: "load_progress", requestId: "progress-a", user: "A" });
  assert.equal(queue.accept({ type: "progress_result", requestId: "progress-a", user: "B" }), false);
  assert.equal(queue.active.user, "A");
  advance(30000);
  assert.equal(queue.active, null);
});

class SharedStorage {
  constructor() { this.values = new Map(); this.failWrite = () => false; }
  get length() { return this.values.size; }
  key(index) { return [...this.values.keys()][index] ?? null; }
  getItem(key) { return this.values.get(key) ?? null; }
  setItem(key, value) {
    if (this.failWrite(key, value)) throw new DOMException("Storage quota exceeded", "QuotaExceededError");
    this.values.set(key, String(value));
  }
  removeItem(key) { this.values.delete(key); }
}

const prefix = "esperanto-choice-mobile:outbox:v2:";
const legacyKey = "esperanto-choice-mobile:outbox:v1";
const sessionKey = "esperanto-choice-mobile:session:v2";
const outboxFor = (storage) => new DurableScoreOutbox({ storage, prefix, legacyKey });
const entryFor = (id, user = "A") => restoreOutbox([{ payload: score(id, user) }])[0];

test("two tabs starting with empty queues preserve each other's independently saved results", () => {
  const storage = new SharedStorage();
  const tabA = outboxFor(storage);
  const tabB = outboxFor(storage);
  assert.equal(tabA.list().entries.length, 0);
  assert.equal(tabB.list().entries.length, 0);
  tabA.put(entryFor("a", "A"));
  tabB.put(entryFor("b", "B"));
  const reloaded = outboxFor(storage).list().entries;
  assert.deepEqual(reloaded.map((entry) => entry.payload.user).sort(), ["A", "B"]);
});

test("an acknowledgement touches only its result and prevents stale-tab resurrection", () => {
  const storage = new SharedStorage();
  const tabA = outboxFor(storage);
  const tabB = outboxFor(storage);
  const staleA = entryFor("a");
  tabA.put(staleA);
  tabB.put(entryFor("b", "B"));
  tabA.acknowledge("save-a");
  assert.deepEqual(tabA.read("save-a"), { type: "saved_score_receipt", saveId: "save-a" });
  assert.deepEqual(tabB.put(staleA), { saved: true });
  assert.deepEqual(tabA.list().entries.map((entry) => entry.payload.saveId), ["save-b"]);
});

test("partial v1 migration preserves the original array and can finish safely on retry", () => {
  const storage = new SharedStorage();
  const original = JSON.stringify([entryFor("a"), entryFor("b", "B")]);
  storage.setItem(legacyKey, original);
  storage.failWrite = (key) => key === `${prefix}save-b`;
  const firstTab = outboxFor(storage);
  assert.throws(() => firstTab.migrateLegacy(), /quota/);
  assert.equal(storage.getItem(legacyKey), original);
  assert.equal(firstTab.read("save-a").payload.user, "A");
  storage.failWrite = () => false;
  const secondTab = outboxFor(storage);
  secondTab.migrateLegacy();
  assert.equal(storage.getItem(legacyKey), null);
  assert.deepEqual(secondTab.list().entries.map((entry) => entry.payload.user).sort(), ["A", "B"]);
});

test("legacy migration cannot restore a result acknowledged by another tab", () => {
  const storage = new SharedStorage();
  storage.setItem(legacyKey, JSON.stringify([entryFor("a"), entryFor("b")]));
  const tabA = outboxFor(storage);
  tabA.acknowledge("save-a");
  outboxFor(storage).migrateLegacy();
  assert.deepEqual(tabA.list().entries.map((entry) => entry.payload.saveId), ["save-b"]);
  assert.equal(tabA.read("save-a").type, "saved_score_receipt");
});

test("a corrupt legacy array is preserved while new results can be saved independently", () => {
  const storage = new SharedStorage();
  storage.setItem(legacyKey, "broken original data");
  const outbox = outboxFor(storage);
  assert.throws(() => outbox.migrateLegacy());
  outbox.put(entryFor("new"));
  assert.equal(storage.getItem(legacyKey), "broken original data");
  assert.equal(outboxFor(storage).list().entries[0].payload.saveId, "save-new");
});

test("storage failure retains the completed result until a successful durable retry permits a new quiz", () => {
  const storage = new SharedStorage();
  const completed = { id: "old", status: "complete", settings: { userName: "A" }, scoreSyncStatus: "error" };
  let session = completed;
  storage.setItem(sessionKey, JSON.stringify(session));
  storage.failWrite = (key) => key.startsWith(prefix);
  const options = {
    cloudEnabled: true,
    ensureDurable: () => {
      try { outboxFor(storage).put(entryFor("old")); return true; }
      catch { return false; }
    },
  };
  const beginNext = () => {
    if (!canReplaceSession(session, options)) return false;
    session = { id: "next", status: "active" };
    storage.setItem(sessionKey, JSON.stringify(session));
    return true;
  };
  assert.equal(beginNext(), false);
  assert.equal(session, completed);
  assert.equal(JSON.parse(storage.getItem(sessionKey)).id, "old");
  storage.failWrite = () => false;
  assert.equal(beginNext(), true);
  assert.equal(JSON.parse(storage.getItem(sessionKey)).id, "next");
  assert.equal(outboxFor(storage).list().entries[0].payload.sessionId, "old");
});

test("confirmed and view-only results may be replaced without attempting another score save", () => {
  const ensureDurable = () => { throw new Error("must not resend"); };
  const session = { status: "complete", settings: { userName: "A" }, scoreSyncStatus: "saved" };
  assert.equal(canReplaceSession(session, { cloudEnabled: true, ensureDurable }), true);
  assert.equal(canReplaceSession({ ...session, scoreSyncStatus: "error" }, { cloudEnabled: true, viewOnly: true, ensureDurable }), true);
});

test("an empty current session never creates JSON null that would suppress legacy import", () => {
  const storage = new SharedStorage();
  storage.setItem("legacy-original", "untouched");
  const write = (session) => { storage.setItem(sessionKey, JSON.stringify(session)); return true; };
  assert.equal(persistPresentSession(null, write), true);
  assert.equal(storage.getItem(sessionKey), null);
  assert.equal(storage.getItem("legacy-original"), "untouched");
  storage.setItem(sessionKey, "null");
  persistPresentSession(null, write);
  assert.equal(storage.getItem(sessionKey), "null");
  assert.equal(persistPresentSession({ id: "active" }, write), true);
  assert.equal(JSON.parse(storage.getItem(sessionKey)).id, "active");
});

test("a malformed independent entry remains intact while valid entries are available", () => {
  const storage = new SharedStorage();
  storage.setItem(`${prefix}bad`, "broken");
  const outbox = outboxFor(storage);
  outbox.put(entryFor("good"));
  const result = outbox.list();
  assert.equal(result.entries.length, 1);
  assert.equal(result.errors.length, 1);
  assert.equal(storage.getItem(`${prefix}bad`), "broken");
});

test("default bridge timers retain their browser global receiver", () => {
  const originalSchedule = globalThis.setTimeout;
  const originalCancel = globalThis.clearTimeout;
  let schedules = 0;
  let cancels = 0;
  try {
    globalThis.setTimeout = function () { assert.equal(this, globalThis); schedules += 1; return 123; };
    globalThis.clearTimeout = function () { assert.equal(this, globalThis); cancels += 1; };
    const queue = new SerializedBridge({ send: () => {}, onTimeout: () => {} });
    queue.enqueue(score("receiver"));
    queue.accept({ type: "score_save_result", requestId: "request-receiver" });
    assert.equal(schedules, 2);
    assert.equal(cancels, 1);
  } finally {
    globalThis.setTimeout = originalSchedule;
    globalThis.clearTimeout = originalCancel;
  }
});

test("a conflicting legacy save identity cannot overwrite newer data or remove the original array", () => {
  const storage = new SharedStorage();
  const outbox = outboxFor(storage);
  outbox.put(entryFor("same", "A"));
  const original = JSON.stringify([entryFor("same", "B")]);
  storage.setItem(legacyKey, original);
  assert.throws(() => outbox.migrateLegacy(), /conflicts/);
  assert.equal(storage.getItem(legacyKey), original);
  assert.equal(outbox.read("save-same").payload.user, "A");
});

test("a storage backend that silently discards writes cannot permit completed-session replacement", () => {
  const storage = new SharedStorage();
  storage.setItem = () => {};
  const session = { status: "complete", settings: { userName: "A" }, scoreSyncStatus: "pending" };
  const allowed = canReplaceSession(session, {
    cloudEnabled: true,
    ensureDurable: () => {
      try { outboxFor(storage).put(entryFor("lost")); return true; }
      catch { return false; }
    },
  });
  assert.equal(allowed, false);
  assert.equal(storage.getItem(`${prefix}save-lost`), null);
});

test("retrying A's completed quiz cannot reuse B's fresh private progress or personalized rankings", () => {
  const now = 100000;
  const progressForB = {
    status: "ready", user: "B", targetLang: "ja", loadedAt: now - 100,
    totals: { overall: 900 }, settings: { rankingPublic: false },
  };
  const rankingForB = { ...progressForB, rankings: { overall: [{ user: "B", isCurrentUser: true }] } };
  const retriedQuiz = { status: "complete", settings: { userName: "A" }, targetLang: "ja" };
  const retryAccount = { user: retriedQuiz.settings.userName, targetLang: retriedQuiz.targetLang, ttlMs: 120000, now };
  assert.equal(isAccountCacheFresh(progressForB, retryAccount), false);
  assert.equal(isAccountCacheFresh(rankingForB, retryAccount), false);
  assert.equal(isAccountCacheFresh(progressForB, { ...retryAccount, user: "B" }), true);
});

test("account caches require exact language, name, successful state, and a valid TTL", () => {
  const cached = { status: "ready", user: "A", targetLang: "ja", loadedAt: 1000 };
  const request = { user: "A", targetLang: "ja", ttlMs: 1000, now: 1500 };
  assert.equal(isAccountCacheFresh(cached, request), true);
  assert.equal(isAccountCacheFresh(cached, { ...request, user: "a" }), false);
  assert.equal(isAccountCacheFresh(cached, { ...request, targetLang: "zh" }), false);
  assert.equal(isAccountCacheFresh(cached, { ...request, now: 2000 }), false);
  assert.equal(isAccountCacheFresh(cached, { ...request, now: 999 }), false);
  assert.equal(isAccountCacheFresh({ ...cached, status: "error" }, request), false);
});

const historyKey = "esperanto-choice-mobile:history:v2";
const settingsKey = "esperanto-choice-mobile:settings:v2";

function completedSession(id = "ack", user = "A") {
  return {
    id, status: "complete", settings: { userName: user, mode: "vocab", direction: "eo_to_ja" },
    questions: Array.from({ length: 4 }, () => ({
      options: Array.from({ length: 4 }, (_, index) => ({ eo: `eo-${index}`, ja: `ja-${index}` })), answerIndex: 0,
    })),
    correct: 1, mainPoints: 10, spartanRawPoints: 0, spartanScaledPoints: 0,
    spartanAttempts: 0, spartanCorrect: 0, finalPoints: 15,
    scoreSaveId: `save-${id}`, scoreSyncRequestId: `request-${id}`, scoreSyncStatus: "pending",
  };
}

function seededScoreStorage() {
  const storage = new SharedStorage();
  const session = completedSession();
  const record = { ...scoreRecordFromSession(session), scoreSyncStatus: "pending" };
  storage.setItem(sessionKey, JSON.stringify(session));
  storage.setItem(historyKey, JSON.stringify([record]));
  outboxFor(storage).put(restoreOutbox([{ payload: { ...score("ack"), points: 15 } }])[0]);
  return storage;
}

// Run the application's actual persistence and restore handlers, with only browser I/O replaced.
// This catches ordering bugs that pure outbox tests cannot observe (e.g. a pending retry overwriting saved history).
const scoreAppSource = readFileSync(new URL("../mobile_app/app.js", import.meta.url), "utf8");
const scoreAppFunctions = [
  "scoreOutboxStorage", "readConfirmedScoreEvidence", "recoverConfirmedScore", "loadPendingScoresFromStorage",
  "persistOutboxEntry", "enqueueCompletedScore", "restorePendingScores", "updateScoreRecord", "refreshScoreViews",
  "pumpScoreOutbox", "retryPendingScores", "handleScoreSyncResult", "handleBridgeTimeout", "saveSession", "saveHistory", "saveSettings",
  "buildScoreSyncPayload", "writeJson", "recoverLocalStorageWrite", "isQuotaExceededError", "isPlainObject", "isCompleteSession",
].map((name) => {
  const start = scoreAppSource.indexOf(`function ${name}(`);
  assert.notEqual(start, -1, `Application handler ${name} must exist`);
  const end = scoreAppSource.indexOf("\nfunction ", start + 1);
  return scoreAppSource.slice(start, end === -1 ? undefined : end);
}).join("\n");

function restoredScoreApp(storage) {
  const state = {
    session: JSON.parse(storage.getItem(sessionKey)), history: JSON.parse(storage.getItem(historyKey)) || [],
    settings: JSON.parse(storage.getItem(settingsKey)) || {},
    outbox: [], currentView: "setup", rankings: {}, progress: {}, mobileConfig: { targetLang: "ja", source: "test" },
  };
  const bridge = fakeBridge();
  const saveStatuses = [];
  let requestId = 0;
  const app = vm.createContext({
    state, window: { localStorage: storage, clearTimeout: () => {}, setTimeout: () => 0 },
    bridgeQueue: bridge.queue, DurableScoreOutbox, addToOutbox, persistPresentSession,
    matchesScoreRecord, scoreRecordFromSession, hasConfirmedScoreEvidence, computeResultSummary,
    isLegacyScoreSaveBlocked: () => false, currentUserName: () => state.session?.settings.userName || "",
    createId: () => `app-request-${++requestId}`, t: (key) => key,
    console: { warn: () => {} }, showToast: () => {}, updateSaveStatus: (message) => saveStatuses.push(message),
    renderResult: () => {}, renderHistory: () => {}, requestProgress: () => {}, requestRankings: () => {},
    APP_VERSION: "test", IS_STREAMLIT_COMPONENT: true,
    SESSION_KEY: sessionKey, HISTORY_KEY: historyKey, SETTINGS_KEY: settingsKey, OUTBOX_KEY: legacyKey, OUTBOX_ENTRY_PREFIX: prefix,
    HISTORY_MAX_ITEMS: 100, HISTORY_RECOVERY_LIMITS: [50, 20, 5, 0],
    SCORE_SYNC_AUTO_RETRY_MAX: 3, SCORE_SYNC_RETRY_DELAY_MS: 10000,
  });
  vm.runInContext(scoreAppFunctions, app);
  return { app, state, sent: bridge.sent, saveStatuses };
}

function confirmScore(storage) {
  const instance = restoredScoreApp(storage);
  instance.app.restorePendingScores();
  assert.equal(instance.sent.length, 1);
  const payload = instance.sent[0];
  instance.app.handleScoreSyncResult({
    type: "score_save_result", ok: true, requestId: payload.requestId, saveId: payload.saveId,
  });
  assert.equal(instance.state.session.scoreSyncStatus, "saved");
  assert.equal(instance.state.outbox.length, 0);
  return instance;
}

test("saved evidence requires matching durable identity, owner, points, and question count", () => {
  const session = { ...completedSession(), scoreSyncStatus: "saved" };
  const payload = { ...score("ack"), points: 15 };
  const history = [{ ...scoreRecordFromSession(session), scoreSyncStatus: "saved" }];
  assert.equal(hasConfirmedScoreEvidence(payload, { session }), true);
  assert.equal(hasConfirmedScoreEvidence(payload, { history }), true);
  for (const altered of [
    { ...payload, user: "B" }, { ...payload, user: "a" }, { ...payload, saveId: "other" },
    { ...payload, sessionId: "other" }, { ...payload, points: 16 }, { ...payload, total: 3 },
  ]) assert.equal(hasConfirmedScoreEvidence(altered, { session, history }), false);
  assert.equal(hasConfirmedScoreEvidence(payload, { session: { ...session, scoreSyncStatus: "pending" } }), false);
  assert.equal(hasConfirmedScoreEvidence(payload, { session: { ...session, status: "active" } }), false);
  assert.equal(hasConfirmedScoreEvidence(payload, { history: [{ ...history[0], scoreSyncStatus: "unknown" }] }), false);
});

for (const durableCopy of ["session", "history", "both"]) {
  test(`failed ACK receipt preserves saved result after reload offline using ${durableCopy}`, () => {
    const storage = seededScoreStorage();
    storage.failWrite = (key, raw) => {
      const value = JSON.parse(raw);
      return value?.type === "saved_score_receipt"
        || (durableCopy === "history" && key === sessionKey && value.scoreSyncStatus === "saved")
        || (durableCopy === "session" && key === historyKey && value.some((row) => row.scoreSyncStatus === "saved"));
    };
    confirmScore(storage);
    assert.equal(outboxFor(storage).list().entries.length, 1, "Failed receipt leaves original pending entry intact");
    const reloaded = restoredScoreApp(storage);
    reloaded.app.restorePendingScores();
    assert.equal(reloaded.state.session.scoreSyncStatus, "saved");
    assert.equal(reloaded.state.history[0].scoreSyncStatus, "saved");
    assert.equal(reloaded.state.outbox.length, 0);
    assert.equal(reloaded.sent.length, 0, "No bridge save is attempted while offline with durable saved evidence");
    const evidence = reloaded.app.readConfirmedScoreEvidence();
    assert.equal(hasConfirmedScoreEvidence({ ...score("ack"), points: 15 }, evidence), true);
    storage.failWrite = () => false;
    reloaded.app.retryPendingScores();
    assert.deepEqual(outboxFor(storage).read("save-ack"), { type: "saved_score_receipt", saveId: "save-ack" });
    assert.equal(outboxFor(storage).list().entries.length, 0);
    assert.equal(reloaded.sent.length, 0);
  });
}

test("an acknowledgement existing only in memory never falsely confirms the durable pending result", () => {
  const storage = seededScoreStorage();
  storage.failWrite = (key, raw) => {
    const value = JSON.parse(raw);
    return value?.type === "saved_score_receipt"
      || (key === sessionKey && value.scoreSyncStatus === "saved")
      || (key === historyKey && value.some((row) => row.scoreSyncStatus === "saved"));
  };
  confirmScore(storage);
  assert.equal(JSON.parse(storage.getItem(sessionKey)).scoreSyncStatus, "pending");
  assert.equal(JSON.parse(storage.getItem(historyKey))[0].scoreSyncStatus, "pending");
  const reloaded = restoredScoreApp(storage);
  reloaded.app.restorePendingScores();
  assert.equal(reloaded.state.session.scoreSyncStatus, "pending");
  assert.equal(reloaded.state.outbox.length, 1);
  assert.equal(reloaded.sent.length, 1);
  assert.equal(reloaded.sent[0].saveId, "save-ack", "An uncertain result retries only its original deduplicated ID");
});

test("history-only confirmation repairs the ACK after the active session is gone", () => {
  const storage = seededScoreStorage();
  storage.failWrite = (_key, raw) => JSON.parse(raw)?.type === "saved_score_receipt";
  confirmScore(storage);
  storage.removeItem(sessionKey);
  const reloaded = restoredScoreApp(storage);
  reloaded.app.restorePendingScores();
  assert.equal(reloaded.state.session, null);
  assert.equal(reloaded.state.outbox.length, 0);
  assert.equal(reloaded.state.history[0].scoreSyncStatus, "saved");
  assert.equal(reloaded.sent.length, 0);
  assert.equal(storage.getItem(sessionKey), null);
});

test("a saved session restores matching pending history even when an ACK receipt already exists", () => {
  const storage = seededScoreStorage();
  storage.failWrite = (key, raw) => key === historyKey && JSON.parse(raw).some((row) => row.scoreSyncStatus === "saved");
  confirmScore(storage);
  assert.equal(outboxFor(storage).list().entries.length, 0);
  assert.equal(JSON.parse(storage.getItem(historyKey))[0].scoreSyncStatus, "pending");
  storage.failWrite = () => false;
  const reloaded = restoredScoreApp(storage);
  reloaded.app.restorePendingScores();
  assert.equal(reloaded.state.history[0].scoreSyncStatus, "saved");
  assert.equal(JSON.parse(storage.getItem(historyKey))[0].scoreSyncStatus, "saved");
  assert.equal(reloaded.sent.length, 0);
});

test("a different user's saved result with the same IDs cannot acknowledge or be overwritten by a pending score", () => {
  const storage = seededScoreStorage();
  const otherSession = { ...completedSession("ack", "B"), scoreSyncStatus: "saved" };
  storage.setItem(sessionKey, JSON.stringify(otherSession));
  storage.setItem(historyKey, JSON.stringify([{ ...scoreRecordFromSession(otherSession), scoreSyncStatus: "saved" }]));
  const reloaded = restoredScoreApp(storage);
  reloaded.app.restorePendingScores();
  assert.equal(reloaded.sent.length, 1);
  assert.equal(reloaded.sent[0].user, "A");
  assert.equal(reloaded.state.outbox.length, 1);
  assert.equal(reloaded.state.session.settings.userName, "B");
  assert.equal(reloaded.state.session.scoreSyncStatus, "saved");
  assert.equal(reloaded.state.history[0].userName, "B");
  assert.equal(reloaded.state.history[0].scoreSyncStatus, "saved");
  assert.equal(JSON.parse(storage.getItem(sessionKey)).scoreSyncStatus, "saved");
  assert.equal(outboxFor(storage).read("save-ack").payload.user, "A");
});

for (const response of ["failure", "timeout"]) {
  test(`a stale tab's late ${response} cannot downgrade another tab's durable saved confirmation`, () => {
    const storage = seededScoreStorage();
    const stale = restoredScoreApp(storage);
    stale.app.restorePendingScores();
    const pendingPayload = stale.sent[0];
    storage.failWrite = (_key, raw) => JSON.parse(raw)?.type === "saved_score_receipt";
    confirmScore(storage);
    if (response === "failure") {
      stale.app.handleScoreSyncResult({
        type: "score_save_result", ok: false, requestId: pendingPayload.requestId, saveId: pendingPayload.saveId,
      });
    } else stale.app.handleBridgeTimeout(pendingPayload);
    assert.equal(stale.state.session.scoreSyncStatus, "saved");
    assert.equal(stale.state.history[0].scoreSyncStatus, "saved");
    assert.equal(stale.state.outbox.length, 0);
    assert.equal(stale.sent.length, 1);
    assert.equal(JSON.parse(storage.getItem(sessionKey)).scoreSyncStatus, "saved");
    assert.equal(JSON.parse(storage.getItem(historyKey))[0].scoreSyncStatus, "saved");
  });
}

test("a failed settings save keeps history-only ACK evidence and the previous durable name", () => {
  const storage = seededScoreStorage();
  storage.setItem(settingsKey, JSON.stringify({ userName: "A" }));
  let settingsFull = false;
  storage.failWrite = (key, raw) => {
    const value = JSON.parse(raw);
    return value?.type === "saved_score_receipt"
      || (key === sessionKey && value.scoreSyncStatus === "saved")
      || (key === settingsKey && settingsFull);
  };
  const instance = confirmScore(storage);
  const durableBefore = new Map(storage.values);
  settingsFull = true;
  instance.state.settings.userName = "B";
  assert.equal(instance.app.saveSettings(), false);
  assert.equal(instance.state.settings.userName, "B", "Keep the current UI selection while reporting persistence failure");
  assert.equal(instance.saveStatuses.at(-1), "saveFailed");
  assert.deepEqual(storage.values, durableBefore, "A preference write must not alter session/history/outbox or the previous stored settings");
  const reloaded = restoredScoreApp(storage);
  reloaded.app.restorePendingScores();
  assert.equal(reloaded.state.settings.userName, "A");
  assert.equal(reloaded.state.session.scoreSyncStatus, "saved");
  assert.equal(reloaded.sent.length, 0, "A name change must not resurrect the confirmed score");
});

test("active-session quota recovery cannot delete another result's history-only acknowledgement", () => {
  const storage = seededScoreStorage();
  storage.failWrite = (key, raw) => JSON.parse(raw)?.type === "saved_score_receipt"
    || (key === sessionKey && JSON.parse(raw).scoreSyncStatus === "saved");
  const instance = confirmScore(storage);
  const durableBefore = new Map(storage.values);
  storage.failWrite = (key) => key === sessionKey;
  instance.state.session = { ...completedSession("next", "B"), status: "active", scoreSyncStatus: "idle" };
  assert.equal(instance.app.saveSession(), false);
  assert.deepEqual(storage.values, durableBefore);
  assert.equal(instance.saveStatuses.at(-1), "saveFailed");
});

function longAcknowledgedHistory() {
  const record = { ...scoreRecordFromSession(completedSession()), scoreSyncStatus: "saved" };
  return [
    ...Array.from({ length: 99 }, (_, index) => ({ id: `local-${index}`, userName: "B", scoreSyncStatus: "local" })),
    record,
  ];
}

test("history quota trimming preserves an older saved acknowledgement without a separate receipt", () => {
  const storage = seededScoreStorage();
  storage.setItem(historyKey, JSON.stringify(longAcknowledgedHistory()));
  const original = storage.getItem(historyKey);
  storage.failWrite = (key, raw) => key === historyKey && JSON.parse(raw).length > 20;
  const instance = restoredScoreApp(storage);
  instance.app.saveHistory();
  assert.equal(storage.getItem(historyKey), original);
  assert.equal(instance.state.history.length, 100);
  assert.equal(instance.saveStatuses.at(-1), "saveFailed");
});

test("history quota recovery can still trim when an independent receipt protects the saved result", () => {
  const storage = seededScoreStorage();
  storage.setItem(historyKey, JSON.stringify(longAcknowledgedHistory()));
  outboxFor(storage).acknowledge("save-ack");
  storage.failWrite = (key, raw) => key === historyKey && JSON.parse(raw).length > 20;
  const instance = restoredScoreApp(storage);
  instance.app.saveHistory();
  assert.equal(JSON.parse(storage.getItem(historyKey)).length, 20);
  assert.equal(instance.state.history.length, 20);
  assert.equal(outboxFor(storage).read("save-ack").type, "saved_score_receipt");
  const reloaded = restoredScoreApp(storage);
  reloaded.app.restorePendingScores();
  assert.equal(reloaded.state.session.scoreSyncStatus, "saved");
  assert.equal(reloaded.sent.length, 0);
});

test("unreadable receipts cannot authorize deleting saved history during quota recovery", () => {
  const storage = seededScoreStorage();
  storage.setItem(historyKey, JSON.stringify(longAcknowledgedHistory()));
  storage.setItem(`${prefix}save-ack`, "unreadable receipt");
  const before = new Map(storage.values);
  storage.failWrite = (key, raw) => key === historyKey && JSON.parse(raw).length > 20;
  const instance = restoredScoreApp(storage);
  instance.app.saveHistory();
  assert.deepEqual(storage.values, before);
  assert.equal(instance.saveStatuses.at(-1), "saveFailed");
});
