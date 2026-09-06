import test from "node:test";
import assert from "node:assert/strict";
import { addToOutbox, restoreOutbox, matchesAccountResult, filterUserHistory, SerializedBridge, DurableScoreOutbox, canReplaceSession, persistPresentSession, isAccountCacheFresh } from "../mobile_app/learning_sync.mjs";

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
    if (this.failWrite(key)) throw new DOMException("Storage quota exceeded", "QuotaExceededError");
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
