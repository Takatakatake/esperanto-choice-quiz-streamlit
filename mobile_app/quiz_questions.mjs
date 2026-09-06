// Pure question construction shared by the live UI and its regression tests.

function isRecord(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

export function targetTextForLanguage(entry, targetLang = "ja") {
  const translations = isRecord(entry?.translations) ? entry.translations : {};
  return String(translations[targetLang] || translations.ja || entry?.ja || "").trim();
}

function shuffled(items, rng) {
  const result = [...items];
  for (let index = result.length - 1; index > 0; index -= 1) {
    const other = Math.floor(rng() * (index + 1));
    [result[index], result[other]] = [result[other], result[index]];
  }
  return result;
}

export function buildLocalizedQuestion({
  mode, correct, pool, stages = [], rng = Math.random, direction, targetLang = "ja",
}) {
  const targetText = (entry) => targetTextForLanguage(entry, targetLang);
  const displayText = (entry) => direction === "ja_to_eo"
    ? String(entry?.eo || "").trim() : targetText(entry);
  const correctTarget = targetText(correct);
  const wrongPool = pool.filter((entry) => (
    entry !== correct && entry.eo !== correct.eo && targetText(entry) !== correctTarget
  ));
  if (wrongPool.length < 3) {
    return null;
  }
  const wrongOptions = [];
  const seenDisplays = new Set([displayText(correct)]);
  for (const entry of shuffled(wrongPool, rng)) {
    const display = displayText(entry);
    if (!display || seenDisplays.has(display)) {
      continue;
    }
    seenDisplays.add(display);
    wrongOptions.push(entry);
    if (wrongOptions.length === 3) {
      break;
    }
  }
  if (wrongOptions.length < 3) {
    return null;
  }
  const options = shuffled([...wrongOptions, correct], rng).map((entry) => ({
    id: entry.id,
    eo: entry.eo,
    ja: targetText(entry),
    translations: isRecord(entry.translations) ? { ...entry.translations } : undefined,
    level: Number(entry.level),
    audioKey: entry.audioKey,
    hasAudio: Boolean(entry.hasAudio),
  }));
  return {
    mode,
    promptEo: correct.eo,
    promptJa: correctTarget,
    stages: [...stages],
    level: Number(correct.level),
    answerIndex: options.findIndex((option) => option.id === correct.id && option.eo === correct.eo),
    options,
  };
}
