import { scaleSpartanPoints } from "./quiz_core.mjs";

const MOBILE_SESSION_KEY = "esperanto-choice-mobile:session:v2";
const LANGUAGES = new Set(["ja", "zh", "ko"]);
const MODES = new Set(["vocab", "sentence"]);

export function classicStorageKey(targetLang, mode) {
  if (!LANGUAGES.has(targetLang) || !MODES.has(mode)) {
    throw new TypeError("A supported language and quiz mode are required for migration.");
  }
  return `esperanto-choice-classic:${targetLang}:${mode}:session:v1`;
}

function migrationMarkerKey(storageKey) {
  return `${storageKey}:unified-import:v1`;
}

export function hasClassicMigrationProvenance(session) {
  const legacy = session?.legacyMigration;
  return Boolean(isObject(legacy) && legacy.version === 1
    && LANGUAGES.has(session.targetLang) && MODES.has(session.settings?.mode)
    && legacy.storageKey === classicStorageKey(session.targetLang, session.settings.mode)
    && typeof legacy.fingerprint === "string" && /^[a-f0-9]{64}$/.test(legacy.fingerprint));
}

export function isLegacyScoreSaveBlocked(session) {
  return hasClassicMigrationProvenance(session) && session.legacyMigration.saveState === "unknown";
}

/**
 * Inspect only storage accessible to this frame; absence does not prove another
 * origin has no classic data. Invalid mobile data still blocks replacement so a
 * migration can never silently destroy a more recent quiz.
 */
export async function inspectLegacySession({
  storage,
  currentSession = null,
  sessionKey = MOBILE_SESSION_KEY,
  ...context
}) {
  if (currentSession !== null) {
    return { status: "current-session" };
  }
  const storageKey = classicStorageKey(context.targetLang, context.mode);
  let raw;
  let marker;
  try {
    if (storage.getItem(sessionKey) !== null) {
      return { status: "current-session" };
    }
    raw = storage.getItem(storageKey);
    marker = storage.getItem(migrationMarkerKey(storageKey));
  } catch (error) {
    return { status: "storage-unavailable", reason: errorMessage(error) };
  }
  if (raw === null) {
    return { status: "none", storageKey };
  }
  // The classic UI has been retired. Consume each language/mode only once,
  // even if an old tab rewrites its timestamp after the successful import.
  if (marker !== null) {
    return { status: "handled", storageKey };
  }
  let snapshot;
  try {
    snapshot = JSON.parse(raw);
  } catch {
    return { status: "invalid", reason: "invalid-json", storageKey, raw };
  }
  const candidate = await convertClassicSession(snapshot, context);
  return { ...candidate, storageKey, raw };
}

/**
 * Convert without recomputing earned points or fetching new question text. A
 * result whose old save state is unknown can be viewed, but must never enter
 * score synchronization: a new save ID could count an already saved score twice.
 */
export async function convertClassicSession(snapshot, {
  targetLang,
  mode,
  source = "",
  appVersion = "",
  sentenceEntries = [],
}) {
  const storageKey = classicStorageKey(targetLang, mode);
  if (!isObject(snapshot) || snapshot.version !== 1
      || snapshot.appKind !== mode || snapshot.targetLang !== targetLang) {
    return { status: "invalid", reason: "wrong-context-or-version" };
  }
  const old = snapshot.state;
  if (!isObject(old) || !Array.isArray(old.questions) || !old.questions.length
      || !Array.isArray(old.answers) || !Array.isArray(old.spartan_pending)) {
    return { status: "invalid", reason: "malformed-state" };
  }
  const audioByPhrase = new Map(sentenceEntries.map((entry) => [String(entry.id), entry]));
  const questions = old.questions.map((question) => convertQuestion(question, mode, audioByPhrase));
  if (questions.some((question) => !question)) {
    return { status: "invalid", reason: "malformed-question" };
  }
  const total = questions.length;
  const pending = old.spartan_pending;
  const completeMain = old.q_index === total;
  if (!boundedInteger(old.q_index, total) || !boundedInteger(old.correct, total)
      || !boundedInteger(old.streak, 99999)
      || !boundedInteger(old.spartan_attempts, 99999)
      || !boundedInteger(old.spartan_correct_count, old.spartan_attempts)
      || new Set(pending).size !== pending.length
      || pending.some((index) => !boundedInteger(index, total - 1))
      || (old.in_spartan_round && !completeMain)
      || (pending.length && !old.spartan_mode)
      || typeof old.showing_result !== "boolean"
      || typeof old.spartan_mode !== "boolean"
      || typeof old.in_spartan_round !== "boolean"
      || (old.pending_save_id != null && typeof old.pending_save_id !== "string")
      || !validDate(snapshot.savedAt)) {
    return { status: "invalid", reason: "malformed-state" };
  }
  const inSpartan = completeMain && old.spartan_mode && pending.length > 0;
  const complete = completeMain && !inSpartan;
  const unknownSaveState = complete && typeof old.score_saved !== "boolean";
  if (old.score_saved && !complete) {
    return { status: "invalid", reason: "saved-unfinished-session" };
  }
  const direction = mode === "sentence" ? old.direction : old.quiz_direction;
  if (!["ja_to_eo", "eo_to_ja"].includes(direction)) {
    return { status: "invalid", reason: "malformed-direction" };
  }
  let current = inSpartan ? old.spartan_current_q_idx : old.q_index;
  if (inSpartan && !pending.includes(current)) {
    if (old.showing_result) {
      return { status: "invalid", reason: "missing-feedback-question" };
    }
    current = pending[0];
  }
  const mainAnswerCount = old.q_index + (old.showing_result && !inSpartan ? 1 : 0);
  const answers = old.answers.map((answer, index) => {
    const phase = index < mainAnswerCount ? "main" : "spartan";
    if (!isObject(answer) || !boundedInteger(answer.q_idx, total - 1)) {
      return null;
    }
    const question = questions[answer.q_idx];
    if (!question
        || !boundedInteger(answer.selected, question.options.length - 1)
        || answer.correct !== question.answerIndex
        || (phase === "main" && answer.q_idx !== index)
        || (mode === "vocab" && answer.phase && answer.phase !== phase)) {
      return null;
    }
    return {
      qIndex: answer.q_idx,
      selectedIndex: answer.selected,
      answerIndex: answer.correct,
      phase,
      at: snapshot.savedAt,
    };
  });
  const lastAnswer = answers.at(-1);
  if (answers.some((answer) => !answer) || answers.length < mainAnswerCount
      || answers.length - mainAnswerCount !== old.spartan_attempts
      || answers.slice(0, mainAnswerCount).filter(isCorrect).length !== old.correct
      || answers.slice(mainAnswerCount).filter(isCorrect).length !== old.spartan_correct_count
      || (old.showing_result && (complete || !lastAnswer || lastAnswer.qIndex !== current || isCorrect(lastAnswer)))) {
    return { status: "invalid", reason: "inconsistent-answer-history" };
  }
  const mainPoints = mode === "vocab" ? old.main_points : old.points_main;
  const spartanRawPoints = mode === "vocab" ? old.spartan_points : old.points_spartan_raw;
  const spartanScaledPoints = mode === "vocab"
    ? scaleSpartanPoints(spartanRawPoints)
    : old.points_spartan_scaled;
  if (![mainPoints, spartanRawPoints, spartanScaledPoints].every(nonnegativeNumber)) {
    return { status: "invalid", reason: "invalid-points" };
  }
  let fingerprint;
  try {
    // This is an idempotency identifier, never an account credential. A stable
    // digest also protects against re-import if writing the marker fails.
    const bytes = new TextEncoder().encode(JSON.stringify(snapshot));
    const digest = await globalThis.crypto.subtle.digest("SHA-256", bytes);
    fingerprint = [...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, "0")).join("");
  } catch (error) {
    return { status: "unsupported", reason: "fingerprint-unavailable", detail: errorMessage(error) };
  }
  const id = `classic-${targetLang}-${mode}-${fingerprint}`;
  const scoreSaveId = typeof old.pending_save_id === "string" && old.pending_save_id.trim()
    ? old.pending_save_id
    : id;
  const settings = {
    mode,
    direction,
    userName: String((mode === "vocab" ? old.user_name : old.sentence_user_name) || "").trim().slice(0, 32),
    seed: mode === "vocab" && boundedInteger(old.seed, 8192) && old.seed > 0 ? old.seed : 1,
    pos: String(old.pos_select || old.questions[0].pos || "noun"),
    groupId: String(old.group_id || old.questions[0].group_id || ""),
    topic: String(old.quiz_topic || ""),
    subtopic: String(old.quiz_subtopic || ""),
    levels: Array.isArray(old.quiz_levels) ? [...old.quiz_levels] : [],
    audioMode: old.show_option_audio === false ? "prompt" : "all",
    spartanMode: old.spartan_mode,
  };
  const session = {
    id,
    appVersion,
    source,
    targetLang,
    status: complete ? "complete" : "active",
    settings,
    questions,
    qIndex: old.q_index,
    correct: old.correct,
    streak: old.streak,
    answers,
    showingFeedback: old.showing_result,
    feedback: old.showing_result ? {
      correct: false,
      selectedIndex: lastAnswer.selectedIndex,
      message: String(old.last_result_msg || questions[current].options[questions[current].answerIndex][direction === "ja_to_eo" ? "eo" : "ja"]),
    } : null,
    mainPoints,
    spartanRawPoints,
    spartanScaledPoints,
    spartanPending: [...pending],
    inSpartan,
    spartanCurrent: inSpartan ? current : null,
    spartanAttempts: old.spartan_attempts,
    spartanCorrect: old.spartan_correct_count,
    savedToHistory: false,
    scoreSaveId,
    scoreSyncRequestId: "",
    scoreSyncStatus: unknownSaveState ? "error" : old.score_saved ? "saved" : "idle",
    scoreSyncRecoverable: unknownSaveState ? "legacy_save_unknown" : "",
    scoreSyncRetryCount: 0,
    scoreSyncMessage: "",
    startedAt: snapshot.savedAt,
    updatedAt: snapshot.savedAt,
    ...(complete ? { completedAt: snapshot.savedAt } : {}),
    legacyMigration: {
      version: 1,
      storageKey,
      fingerprint,
      savedAt: snapshot.savedAt,
      saveState: unknownSaveState ? "unknown" : old.score_saved ? "saved" : "unsaved",
    },
  };
  return { status: "ready", session, fingerprint, storageKey };
}

/** Call only after the user chooses to import the inspected candidate. */
export function commitLegacySessionImport({ storage, candidate, sessionKey = MOBILE_SESSION_KEY }) {
  if (candidate?.status !== "ready" || !candidate.session || !candidate.fingerprint) {
    return { ok: false, reason: "invalid-candidate" };
  }
  try {
    if (storage.getItem(sessionKey) !== null) {
      return { ok: false, reason: "current-session" };
    }
    // The quiz could have advanced in an older tab while the prompt was open.
    if (storage.getItem(candidate.storageKey) !== candidate.raw) {
      return { ok: false, reason: "legacy-session-changed" };
    }
    storage.setItem(sessionKey, JSON.stringify(candidate.session));
  } catch (error) {
    return { ok: false, reason: "storage-unavailable", detail: errorMessage(error) };
  }
  try {
    storage.setItem(migrationMarkerKey(candidate.storageKey), candidate.fingerprint);
    return { ok: true, markerSaved: true };
  } catch (error) {
    // The imported session is durable already. Do not undo it or modify the
    // classic source when only the optional one-time marker cannot be written.
    return { ok: true, markerSaved: false, detail: errorMessage(error) };
  }
}

function convertQuestion(question, mode, audioByPhrase) {
  if (!isObject(question) || !Array.isArray(question.options)
      || question.options.length < (mode === "vocab" ? 2 : 4)
      || (mode === "vocab" && question.options.length > 4)
      || !boundedInteger(question.answer_index, question.options.length - 1)
      || (mode === "vocab" && (!Array.isArray(question.stages) || !question.stages.every((stage) => typeof stage === "string")))) {
    return null;
  }
  const options = question.options.map((option, index) => {
    if (!isObject(option) || typeof option.japanese !== "string"
        || typeof option[mode === "sentence" ? "phrase" : "esperanto"] !== "string"
        || (mode === "sentence" && !nonnegativeNumber(option.level))) {
      return null;
    }
    const eo = mode === "sentence" ? option.phrase : option.esperanto;
    const audioEntry = mode === "sentence" ? audioByPhrase.get(String(option.phrase_id)) : null;
    const matchingAudio = audioEntry?.eo === eo ? audioEntry : null;
    const audioKey = mode === "vocab" ? String(option.audio_key || "") : String(matchingAudio?.audioKey || "");
    return {
      id: String(mode === "sentence" ? option.phrase_id : option.audio_key || index),
      eo,
      ja: option.japanese,
      level: mode === "sentence" ? option.level : Number(option.unified_level) || 0,
      audioKey,
      hasAudio: mode === "vocab" ? Boolean(audioKey) : Boolean(matchingAudio?.hasAudio),
    };
  });
  if (options.some((option) => !option)) {
    return null;
  }
  const answer = options[question.answer_index];
  const promptEo = mode === "sentence" ? question.prompt_eo : question.prompt;
  const promptJa = mode === "sentence" ? question.prompt_ja : answer.ja;
  if (typeof promptEo !== "string" || typeof promptJa !== "string") {
    return null;
  }
  return {
    mode,
    promptEo,
    promptJa,
    stages: mode === "vocab" ? [...question.stages] : [],
    level: answer.level,
    answerIndex: question.answer_index,
    options,
  };
}

function isObject(value) {
  return Boolean(value && typeof value === "object" && !Array.isArray(value));
}

function boundedInteger(value, max) {
  return Number.isInteger(value) && value >= 0 && value <= max;
}

function nonnegativeNumber(value) {
  return typeof value === "number" && Number.isFinite(value) && value >= 0;
}

function validDate(value) {
  return typeof value === "string" && Number.isFinite(Date.parse(value));
}

function isCorrect(answer) {
  return answer && answer.selectedIndex === answer.answerIndex;
}

function errorMessage(error) {
  return String(error?.message || error || "Unknown storage error");
}
