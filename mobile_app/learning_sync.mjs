// A separate durable queue keeps unsent results when the active quiz or local history changes.
export function restoreOutbox(value) {
  if (!Array.isArray(value)) throw new TypeError("Invalid saved result queue");
  const seen = new Set();
  return value.map((entry) => {
    const payload = entry?.payload;
    if (!payload || payload.type !== "save_score" || typeof payload.saveId !== "string" || !payload.saveId
        || typeof payload.sessionId !== "string" || !payload.sessionId
        || typeof payload.user !== "string" || !payload.user.trim()
        || !Number.isFinite(payload.points) || !Number.isFinite(payload.total)) {
      throw new TypeError("Invalid saved result in queue");
    }
    return {
      payload: { ...payload, user: payload.user.trim() },
      status: entry.status === "error" ? "error" : "pending",
      attempts: Math.max(0, Number(entry.attempts) || 0),
      nextAttemptAt: Math.max(0, Number(entry.nextAttemptAt) || 0),
      message: String(entry.message || ""),
    };
  }).filter((entry) => {
    const key = entry.payload.saveId;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

export function addToOutbox(outbox, payload) {
  if (outbox.some((entry) => entry.payload.saveId === payload.saveId)) return outbox;
  return [...outbox, ...restoreOutbox([{ payload }])];
}

export function matchesAccountResult(result, { requestId, user, targetLang }, currentUser, currentLang) {
  return Boolean(requestId && result?.requestId === requestId && result.user === user
    && user === currentUser && targetLang === currentLang);
}

export function isAccountCacheFresh(cache, { user, targetLang, ttlMs, now = Date.now() }) {
  return cache.status === "ready" && cache.user === user && cache.targetLang === targetLang
    && cache.loadedAt > 0 && now >= cache.loadedAt && now - cache.loadedAt < ttlMs;
}

export function filterUserHistory(history, user) {
  return history.filter((record) => String(record.userName || "").trim() === user);
}

const RESPONSE_TYPES = {
  save_score: "score_save_result",
  load_rankings: "rankings_result",
  load_progress: "progress_result",
  save_user_settings: "user_settings_result",
};

// Streamlit's component value is a single slot. Wait for each response before sending another value.
export class SerializedBridge {
  constructor({ send, onTimeout, timeoutMs = 30000, schedule = (...args) => globalThis.setTimeout(...args), cancel = (...args) => globalThis.clearTimeout(...args) }) {
    this.send = send;
    this.onTimeout = onTimeout;
    this.timeoutMs = timeoutMs;
    this.schedule = schedule;
    this.cancel = cancel;
    this.pending = [];
    this.active = null;
    this.timer = null;
  }

  enqueue(payload) {
    if (!RESPONSE_TYPES[payload.type] || !payload.requestId) throw new TypeError("Invalid bridge request");
    if (this.has(payload.requestId)) return;
    this.pending.push(payload);
    this.drain();
  }

  has(requestId) {
    return this.active?.requestId === requestId || this.pending.some((item) => item.requestId === requestId);
  }

  discardPending(predicate) {
    this.pending = this.pending.filter((payload) => !predicate(payload));
  }

  accept(result) {
    if (!this.active || this.active.requestId !== result?.requestId
        || RESPONSE_TYPES[this.active.type] !== result.type
        || (this.active.type !== "save_score" && result.user !== this.active.user)) return false;
    this.cancel(this.timer);
    this.active = null;
    this.timer = null;
    // Let all response handlers update state before sending the next request.
    this.schedule(() => this.drain(), 0);
    return true;
  }

  drain() {
    if (this.active || !this.pending.length) return;
    const payload = this.pending.shift();
    this.active = payload;
    this.timer = this.schedule(() => {
      if (this.active !== payload) return;
      this.active = null;
      this.timer = null;
      this.onTimeout(payload);
      this.drain();
    }, this.timeoutMs);
    try {
      this.send(payload);
    } catch (error) {
      this.cancel(this.timer);
      this.active = null;
      this.timer = null;
      this.onTimeout(payload, error);
      this.drain();
    }
  }
}

// Independent keys prevent a tab with an older in-memory queue from deleting another tab's work.
export class DurableScoreOutbox {
  constructor({ storage, prefix, legacyKey }) {
    this.storage = storage;
    this.prefix = prefix;
    this.legacyKey = legacyKey;
  }

  key(saveId) {
    return `${this.prefix}${encodeURIComponent(saveId)}`;
  }

  read(saveId) {
    const raw = this.storage.getItem(this.key(saveId));
    if (raw === null) return null;
    const value = JSON.parse(raw);
    if (value?.type === "saved_score_receipt" && value.saveId === saveId) return value;
    const entry = restoreOutbox([value])[0];
    if (entry.payload.saveId !== saveId) throw new TypeError("Saved result identity does not match its storage key");
    return entry;
  }

  put(entry) {
    const clean = restoreOutbox([entry])[0];
    const saveId = clean.payload.saveId;
    const existing = this.read(saveId);
    if (existing?.type === "saved_score_receipt") return { saved: true };
    if (existing && (existing.payload.sessionId !== clean.payload.sessionId
        || existing.payload.user !== clean.payload.user || existing.payload.points !== clean.payload.points
        || existing.payload.total !== clean.payload.total)) {
      throw new TypeError("A different result already uses this save identity");
    }
    this.writeVerified(this.key(saveId), clean);
    return { saved: false };
  }

  acknowledge(saveId) {
    // A small receipt prevents a stale tab from recreating an already acknowledged score.
    this.writeVerified(this.key(saveId), { type: "saved_score_receipt", saveId });
  }

  writeVerified(key, value) {
    const raw = JSON.stringify(value);
    this.storage.setItem(key, raw);
    if (this.storage.getItem(key) !== raw) throw new Error("Could not verify saved learning record");
  }

  list() {
    const keys = [];
    for (let index = 0; index < this.storage.length; index += 1) {
      const key = this.storage.key(index);
      if (key?.startsWith(this.prefix)) keys.push(key);
    }
    const entries = [];
    const errors = [];
    for (const key of keys) {
      try {
        const saveId = decodeURIComponent(key.slice(this.prefix.length));
        const value = this.read(saveId);
        if (value && value.type !== "saved_score_receipt") entries.push(value);
      } catch (error) {
        errors.push({ key, error });
      }
    }
    return { entries, errors };
  }

  migrateLegacy() {
    const raw = this.storage.getItem(this.legacyKey);
    if (raw === null) return;
    const entries = restoreOutbox(JSON.parse(raw));
    for (const entry of entries) {
      // A newer retry or receipt from another tab takes precedence over the old shared array.
      const existing = this.read(entry.payload.saveId);
      if (!existing) this.put(entry);
      else if (existing.type !== "saved_score_receipt"
          && (existing.payload.sessionId !== entry.payload.sessionId || existing.payload.user !== entry.payload.user
            || existing.payload.points !== entry.payload.points || existing.payload.total !== entry.payload.total)) {
        throw new TypeError("The previous result queue conflicts with a saved result; original retained");
      }
    }
    // Keep the original intact on any write/verification failure or concurrent legacy change.
    if (this.storage.getItem(this.legacyKey) === raw) this.storage.removeItem(this.legacyKey);
  }
}

export function canReplaceSession(session, { cloudEnabled, viewOnly = false, ensureDurable }) {
  if (!cloudEnabled || viewOnly || session?.status !== "complete"
      || !String(session.settings?.userName || "").trim() || session.scoreSyncStatus === "saved") return true;
  return ensureDurable(session) === true;
}

export function persistPresentSession(session, write) {
  // Writing JSON null would suppress an unaccepted legacy migration after reload.
  return session ? write(session) : true;
}
