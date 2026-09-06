import assert from "node:assert/strict";
import test from "node:test";
import { buildLocalizedQuestion, targetTextForLanguage } from "../mobile_app/quiz_questions.mjs";

const pool = Array.from({ length: 6 }, (_, id) => ({
  id,
  eo: `vorto ${id}`,
  ja: `日本語 ${id}`,
  level: 1,
  translations: { ja: `日本語 ${id}`, zh: `中文 ${id}`, ko: `한국어 ${id}` },
}));

test("both directions use the selected language for every option", () => {
  for (const targetLang of ["ja", "zh", "ko"]) {
    for (const direction of ["eo_to_ja", "ja_to_eo"]) {
      const question = buildLocalizedQuestion({
        mode: "vocab", correct: pool[0], pool, direction, targetLang,
        stages: ["beginner_1"], rng: () => 0.5,
      });
      assert.equal(question.promptJa, pool[0].translations[targetLang]);
      assert.equal(question.options.length, 4);
      assert.equal(question.options[question.answerIndex].eo, pool[0].eo);
      for (const option of question.options) {
        assert.equal(option.ja, pool[option.id].translations[targetLang]);
      }
    }
  }
});

test("translation collisions cannot produce duplicate visible choices", () => {
  const entries = pool.map((entry) => ({
    ...entry, translations: { ...entry.translations, zh: "相同的选择" },
  }));
  assert.equal(buildLocalizedQuestion({
    mode: "sentence", correct: entries[0], pool: entries,
    direction: "eo_to_ja", targetLang: "zh",
  }), null);
});

test("missing localized translations retain the existing Japanese fallback", () => {
  assert.equal(targetTextForLanguage({ ja: "互換の訳" }, "ko"), "互換の訳");
  assert.equal(targetTextForLanguage({
    ja: "旧訳", translations: { ja: "現在の訳", zh: "" },
  }, "zh"), "現在の訳");
  assert.equal(targetTextForLanguage(null, "ja"), "");
});
