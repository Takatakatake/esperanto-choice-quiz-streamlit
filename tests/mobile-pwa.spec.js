const { test, expect } = require("@playwright/test");

function localAppUrl() {
  const url = new URL(process.env.MOBILE_APP_URL || "http://127.0.0.1:8765/mobile_app/");
  if (!["127.0.0.1", "localhost", "[::1]"].includes(url.hostname)) {
    throw new Error("MOBILE_APP_URL must point to a local test server.");
  }
  return url.toString();
}

async function expectUnifiedNavigation(scope, mode) {
  await expect(scope.locator("#classicAppLink, #mobileAppLink")).toHaveCount(0);
  await expect(scope.locator("input[type='password']")).toHaveCount(0);
  for (const [lang, hostname] of [["ja", "esperanto-quiz"], ["zh", "esperanto-quiz-zh"], ["ko", "esperanto-quiz-ko"]]) {
    const link = scope.locator(`#${lang}AppLink`);
    await expect(link).toHaveAttribute("href", `https://${hostname}.streamlit.app/?quiz=${mode}`);
    await expect(link).toHaveAttribute("target", "_blank");
    await expect(link).toHaveAttribute("rel", /noopener/);
  }
}

test.use({
  viewport: { width: 393, height: 851 },
  isMobile: true,
  hasTouch: true,
  deviceScaleFactor: 2.75,
  userAgent: "Mozilla/5.0 (Linux; Android 13; Pixel 5) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120 Mobile Safari/537.36",
});

async function answerRemainingCorrectly(page, scope) {
  for (let guard = 0; guard < 120; guard += 1) {
    const session = await page.evaluate(() => JSON.parse(localStorage.getItem("esperanto-choice-mobile:session:v2")));
    if (session.status === "complete") {
      return;
    }
    const question = session.questions[session.inSpartan ? session.spartanCurrent : session.qIndex];
    await scope.locator(`.choice-button[data-index="${question.answerIndex}"]`).click();
    await page.waitForTimeout(80);
  }
  throw new Error("Quiz did not complete within the guard limit");
}

function expectSessionChoicesToBeUnique(session) {
  const direction = session.settings.direction;
  for (const [questionIndex, question] of session.questions.entries()) {
    const labels = question.options.map((option) => direction === "ja_to_eo" ? option.eo : option.ja);
    expect(
      new Set(labels).size,
      `question ${questionIndex} has duplicate labels: ${labels.join(" / ")}`,
    ).toBe(labels.length);
  }
}

async function startDuplicateProneSentenceSession(page, direction) {
  const appUrl = localAppUrl();
  await page.goto(appUrl, { waitUntil: "networkidle" });
  await expect(page.locator("#setupView")).toHaveClass(/is-active/);

  await page.locator("#modeSentence").click();
  await page.locator("#topicSelect").selectOption("Basic Sentences");
  await page.locator("#subtopicSelect").selectOption("Saying Hello & Goodbye");
  await page.locator("#levelChips input").evaluateAll((inputs) => {
    inputs.forEach((input) => {
      input.checked = true;
      input.dispatchEvent(new Event("change", { bubbles: true }));
    });
  });
  await page.locator("#directionSelect").selectOption(direction);
  await page.locator("#startButton").scrollIntoViewIfNeeded();
  await page.locator("#startButton").click();

  return page.evaluate(() => JSON.parse(localStorage.getItem("esperanto-choice-mobile:session:v2")));
}

test("mobile quiz state survives reload", async ({ page }) => {
  const errors = [];
  page.on("console", (message) => {
    if (message.type() === "error") {
      errors.push(message.text());
    }
  });
  page.on("pageerror", (error) => errors.push(error.message));

  const appUrl = localAppUrl();
  await page.goto(appUrl, { waitUntil: "networkidle" });
  await expect(page.locator("#setupView")).toHaveClass(/is-active/);
  await expect(page.locator("#audioMode")).toBeEnabled();
  await expect(page.locator("#audioMode")).toHaveValue("prompt");
  await expect(page.locator("#lengthSelect")).toHaveCount(0);

  await page.locator("#modeSentence").click();
  await expect(page.locator("#modeSentence")).toHaveAttribute("aria-selected", "true");
  await expectUnifiedNavigation(page, "sentence");
  await page.locator("#modeVocab").click();
  await expect(page.locator("#modeVocab")).toHaveAttribute("aria-selected", "true");
  await expect(page.locator("#jaAppLink")).toHaveClass(/is-active/);
  await expectUnifiedNavigation(page, "vocab");

  const setupMetrics = await page.evaluate(() => {
    const start = document.querySelector("#startButton");
    const nav = document.querySelector(".bottom-nav");
    const startRect = start.getBoundingClientRect();
    const navRect = nav.getBoundingClientRect();
    return {
      startDisabled: start.disabled,
      navPosition: getComputedStyle(nav).position,
      startBottom: startRect.bottom,
      navTop: navRect.top,
    };
  });
  expect(setupMetrics.startDisabled).toBe(false);
  expect(setupMetrics.navPosition).toBe("static");
  expect(setupMetrics.startBottom).toBeLessThanOrEqual(setupMetrics.navTop);

  await page.fill("#userName", "mobile-test");
  await page.locator("#startButton").scrollIntoViewIfNeeded();
  await page.locator("#startButton").click({ trial: true });
  await page.locator("#quizNav").click();
  await expect(page.locator("#quizView")).toHaveClass(/is-active/);
  await expect(page.locator(".choice-button").first()).toBeVisible();
  await expect(page.locator("#promptAudioButton")).toBeVisible();
  const audioUrlPattern = /\/audio\/.+\.wav$/;
  const audioRequestPromise = page.waitForRequest(
    (request) => audioUrlPattern.test(request.url()),
    { timeout: 5000 },
  );
  const audioResponsePromise = page.waitForResponse(
    (response) => audioUrlPattern.test(response.url()),
    { timeout: 5000 },
  );
  const [audioRequest, audioResponse] = await Promise.all([
    audioRequestPromise,
    audioResponsePromise,
    page.locator("#promptAudioButton").click(),
  ]);
  expect(audioRequest.url()).toContain("/audio/");
  expect([200, 206]).toContain(audioResponse.status());
  expect(audioResponse.headers()["content-type"] || "").toMatch(/audio|octet-stream/);

  const quizMetrics = await page.evaluate(() => {
    const grid = document.querySelector("#choiceGrid");
    const progress = document.querySelector(".progress-block");
    const nav = document.querySelector(".bottom-nav");
    const gridRect = grid.getBoundingClientRect();
    const progressRect = progress.getBoundingClientRect();
    const navRect = nav.getBoundingClientRect();
    return {
      navPosition: getComputedStyle(nav).position,
      progressToChoicesGap: Math.round(gridRect.top - progressRect.bottom),
      gridBottom: gridRect.bottom,
      navTop: navRect.top,
    };
  });
  expect(quizMetrics.navPosition).toBe("fixed");
  expect(quizMetrics.progressToChoicesGap).toBeGreaterThanOrEqual(0);
  expect(quizMetrics.progressToChoicesGap).toBeLessThanOrEqual(80);
  expect(quizMetrics.gridBottom).toBeLessThanOrEqual(quizMetrics.navTop + 1);

  const firstPrompt = await page.locator("#promptText").textContent();
  expect(firstPrompt && firstPrompt.trim().length).toBeGreaterThan(0);

  const startedSession = await page.evaluate(() => JSON.parse(localStorage.getItem("esperanto-choice-mobile:session:v2")));
  expect(startedSession.settings).not.toHaveProperty("length");
  expectSessionChoicesToBeUnique(startedSession);
  const answerIndex = startedSession.questions[startedSession.qIndex].answerIndex;
  const wrongIndex = (answerIndex + 1) % startedSession.questions[startedSession.qIndex].options.length;
  await page.locator(`.choice-button[data-index="${wrongIndex}"]`).click();
  await expect(page.locator("#feedbackPanel")).toBeVisible();
  await page.locator("#nextButton").click({ trial: true });
  await page.waitForTimeout(300);
  const storedBeforeReload = await page.evaluate(() => JSON.parse(localStorage.getItem("esperanto-choice-mobile:session:v2")));
  expect(storedBeforeReload.status).toBe("active");
  expect(storedBeforeReload.answers.length).toBeGreaterThanOrEqual(1);
  expect(storedBeforeReload.answers[0].selectedIndex).not.toBe(storedBeforeReload.answers[0].answerIndex);
  expect(storedBeforeReload.spartanPending.length).toBeGreaterThanOrEqual(1);

  await page.reload({ waitUntil: "networkidle" });
  const activeView = await page.evaluate(() => document.querySelector(".state-view.is-active")?.id);
  expect(["quizView", "resultView"]).toContain(activeView);
  const storedAfterReload = await page.evaluate(() => JSON.parse(localStorage.getItem("esperanto-choice-mobile:session:v2")));
  expect(storedAfterReload.status).toMatch(/active|complete/);

  let dialogSeen = false;
  page.once("dialog", async (dialog) => {
    dialogSeen = true;
    expect(dialog.message()).toContain("進行中のクイズ");
    await dialog.dismiss();
  });
  await page.locator("#homeNav").click();
  await page.locator("#startButton").scrollIntoViewIfNeeded();
  await page.locator("#startButton").click();
  await expect(page.locator("#quizView")).toHaveClass(/is-active/);
  const protectedSession = await page.evaluate(() => JSON.parse(localStorage.getItem("esperanto-choice-mobile:session:v2")));
  expect(protectedSession.id).toBe(storedAfterReload.id);
  expect(dialogSeen).toBe(true);

  let replaceDialogSeen = false;
  page.once("dialog", async (dialog) => {
    replaceDialogSeen = true;
    expect(dialog.message()).toContain("進行中のクイズ");
    await dialog.accept();
  });
  await page.locator("#homeNav").click();
  await page.locator("#startButton").scrollIntoViewIfNeeded();
  await page.locator("#startButton").click();
  await expect(page.locator("#quizView")).toHaveClass(/is-active/);
  const replacedSession = await page.evaluate(() => JSON.parse(localStorage.getItem("esperanto-choice-mobile:session:v2")));
  expect(replaceDialogSeen).toBe(true);
  expect(replacedSession.id).not.toBe(protectedSession.id);
  expect(replacedSession.status).toBe("active");
  expect(replacedSession.qIndex).toBe(0);
  expect(replacedSession.answers).toHaveLength(0);

  expect(errors).toEqual([]);
});

for (const direction of ["eo_to_ja", "ja_to_eo"]) {
  test(`mobile sentence questions avoid duplicate displayed choices: ${direction}`, async ({ page }) => {
    const session = await startDuplicateProneSentenceSession(page, direction);
    expect(session.settings.mode).toBe("sentence");
    expect(session.settings.subtopic).toBe("Saying Hello & Goodbye");
    expect(session.settings.direction).toBe(direction);
    expectSessionChoicesToBeUnique(session);
  });
}

test("mobile app can quiz with Chinese and Korean target translations", async ({ page, browser }) => {
  const appUrl = localAppUrl();

  const zhUrl = new URL(appUrl);
  zhUrl.searchParams.set("lang", "zh");
  zhUrl.searchParams.set("mode", "vocab");
  await page.goto(zhUrl.toString(), { waitUntil: "networkidle" });
  await expect(page.locator("#modeVocab")).toHaveText("单词");
  await expect(page.locator("#languageLinksLabel")).toHaveText("语言");
  await expectUnifiedNavigation(page, "vocab");
  await expect(page.locator("#directionSelect option[value='eo_to_ja']")).toHaveText("世界语 → 中文");
  await expect(page.locator("#historyNav")).toHaveText("学习记录");
  await expect(page.locator("#diagnosticsNav")).toHaveText("诊断");
  await page.locator("#historyNav").click();
  await expect(page.locator("#clearHistoryButton")).toHaveText("仅清除本机记录");
  await expect(page.locator("#rankingStatus")).toHaveText("在线版可查看排行榜。");
  await page.locator("#homeNav").click();
  await page.locator("#startButton").scrollIntoViewIfNeeded();
  await page.locator("#startButton").click();
  await expect(page.locator("#quizView")).toHaveClass(/is-active/);
  const zhQuestion = await page.evaluate(() => {
    const session = JSON.parse(localStorage.getItem("esperanto-choice-mobile:session:v2"));
    return session.questions[0];
  });
  expect(zhQuestion.promptJa).toMatch(/[\u4e00-\u9fff]/);
  expect(zhQuestion.options.every((option) => /[\u4e00-\u9fff]/.test(option.ja))).toBe(true);

  const koContext = await browser.newContext({
    viewport: { width: 393, height: 851 },
    isMobile: true,
    hasTouch: true,
    deviceScaleFactor: 2.75,
    userAgent: "Mozilla/5.0 (Linux; Android 13; Pixel 5) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120 Mobile Safari/537.36",
  });
  const koPage = await koContext.newPage();
  const koUrl = new URL(appUrl);
  koUrl.searchParams.set("lang", "ko");
  koUrl.searchParams.set("mode", "sentence");
  await koPage.goto(koUrl.toString(), { waitUntil: "networkidle" });
  await expect(koPage.locator("#modeSentence")).toHaveText("예문");
  await expect(koPage.locator("#languageLinksLabel")).toHaveText("언어");
  await expectUnifiedNavigation(koPage, "sentence");
  await expect(koPage.locator("#directionSelect option[value='eo_to_ja']")).toHaveText("에스페란토 → 한국어");
  await expect(koPage.locator("#historyNav")).toHaveText("학습 기록");
  await expect(koPage.locator("#diagnosticsNav")).toHaveText("진단");
  await koPage.locator("#diagnosticsNav").click();
  await expect(koPage.locator("#diagnosticsList")).toContainText("퀴즈 데이터");
  await expect(koPage.locator("#diagnosticsList")).toContainText("기기 저장 사용량");
  await koPage.locator("#homeNav").click();
  await expect(koPage.locator("#modeSentence")).toHaveAttribute("aria-selected", "true");
  await koPage.locator("#startButton").scrollIntoViewIfNeeded();
  await koPage.locator("#startButton").click();
  await expect(koPage.locator("#quizView")).toHaveClass(/is-active/);
  const koQuestion = await koPage.evaluate(() => {
    const session = JSON.parse(localStorage.getItem("esperanto-choice-mobile:session:v2"));
    return session.questions[0];
  });
  expect(koQuestion.promptJa).toMatch(/[가-힣]/);
  expect(koQuestion.options.every((option) => /[가-힣]/.test(option.ja))).toBe(true);
  await koContext.close();
});

test("mobile result and history stay readable", async ({ page }) => {
  const errors = [];
  page.on("console", (message) => {
    if (message.type() === "error") {
      errors.push(message.text());
    }
  });
  page.on("pageerror", (error) => errors.push(error.message));

  const appUrl = localAppUrl();
  await page.goto(appUrl, { waitUntil: "networkidle" });
  await page.evaluate(() => {
    const original = Storage.prototype.setItem;
    let historyFailures = 0;
    Storage.prototype.setItem = function patchedSetItem(key, value) {
      if (String(key).includes(":history") && historyFailures < 1) {
        historyFailures += 1;
        throw new DOMException("Quota exceeded", "QuotaExceededError");
      }
      return original.call(this, key, value);
    };
  });
  await page.locator("#spartanMode").uncheck();
  await page.locator("#startButton").scrollIntoViewIfNeeded();
  await page.locator("#startButton").click();
  await expect(page.locator("#quizView")).toHaveClass(/is-active/);

  await answerRemainingCorrectly(page, page);
  await expect(page.locator("#resultView")).toHaveClass(/is-active/);
  await expect(page.locator("#accuracyMetric")).toHaveText("100%");
  await expect(page.locator("#syncScoreButton")).toBeDisabled();
  await expect(page.locator("#syncScoreStatus")).toHaveText("アカウントへの記録保存はオンライン版で利用できます。");
  await expect(page.locator("#reviewList .review-item").first()).toBeVisible();

  const resultMetrics = await page.evaluate(() => {
    const actions = document.querySelector(".result-actions").getBoundingClientRect();
    const nav = document.querySelector(".bottom-nav").getBoundingClientRect();
    return {
      actionsWidth: actions.width,
      actionsBottom: actions.bottom,
      navTop: nav.top,
      navBottom: nav.bottom,
      viewportHeight: window.innerHeight,
    };
  });
  expect(resultMetrics.actionsWidth).toBeGreaterThan(300);
  expect(resultMetrics.actionsBottom).toBeLessThanOrEqual(resultMetrics.navTop + 1);
  expect(resultMetrics.navBottom).toBeLessThanOrEqual(resultMetrics.viewportHeight + 1);

  await page.locator("#historyNav").click();
  await expect(page.locator("#historyView")).toHaveClass(/is-active/);
  await expect(page.locator("#clearHistoryButton")).toHaveText("端末履歴のみ消去");
  await expect(page.locator("#rankingStatus")).toHaveText("ランキングはオンライン版で利用できます。");
  await expect(page.locator("#historyUserName")).toBeVisible();
  await expect(page.locator("#rankingPublic")).toBeDisabled();
  await expect(page.locator("#historyList .history-item").first()).toContainText("単語");

  await page.locator("#diagnosticsNav").click();
  await expect(page.locator("#diagnosticsView")).toHaveClass(/is-active/);
  await expect(page.locator("#diagnosticsList")).toContainText("静的/PWA");
  await expect(page.locator("#diagnosticsList")).toContainText("クイズデータ");
  await expect(page.locator("#diagnosticsList")).toContainText("端末保存使用量");
  await expect(page.locator("#diagnosticsList")).toContainText("Service Worker");
  await expect(page.locator("#audioDiagVocabButton")).toBeEnabled();
  const diagnosticAudioResponsePromise = page.waitForResponse(
    (response) => /\/audio\/.+\.wav$/.test(response.url()),
    { timeout: 5000 },
  );
  await page.locator("#audioDiagVocabButton").click();
  const diagnosticAudioResponse = await diagnosticAudioResponsePromise;
  expect([200, 206]).toContain(diagnosticAudioResponse.status());
  await expect(page.locator("#audioDiagVocabStatus")).toContainText("再生できました");
  await expect(errors).toEqual([]);
});

test("mobile review can replay the Esperanto correct answer", async ({ page }) => {
  const errors = [];
  page.on("console", (message) => {
    if (message.type() === "error") {
      errors.push(message.text());
    }
  });
  page.on("pageerror", (error) => errors.push(error.message));

  const appUrl = localAppUrl();
  await page.goto(appUrl, { waitUntil: "networkidle" });
  await page.locator("#spartanMode").uncheck();
  await page.locator("#startButton").scrollIntoViewIfNeeded();
  await page.locator("#startButton").click();
  await expect(page.locator("#quizView")).toHaveClass(/is-active/);

  const startedSession = await page.evaluate(() => JSON.parse(localStorage.getItem("esperanto-choice-mobile:session:v2")));
  const answerIndex = startedSession.questions[startedSession.qIndex].answerIndex;
  const wrongIndex = (answerIndex + 1) % startedSession.questions[startedSession.qIndex].options.length;
  await page.locator(`.choice-button[data-index="${wrongIndex}"]`).click();
  await expect(page.locator("#feedbackPanel")).toBeVisible();
  await page.locator("#nextButton").click();

  await answerRemainingCorrectly(page, page);
  await expect(page.locator("#resultView")).toHaveClass(/is-active/);
  await expect(page.locator(".review-audio-button").first()).toBeVisible();

  const audioUrlPattern = /\/audio\/.+\.wav$/;
  const audioResponsePromise = page.waitForResponse(
    (response) => audioUrlPattern.test(response.url()),
    { timeout: 5000 },
  );
  await page.locator(".review-audio-button").first().click();
  const audioResponse = await audioResponsePromise;
  expect([200, 206]).toContain(audioResponse.status());
  expect(audioResponse.headers()["content-type"] || "").toMatch(/audio|octet-stream/);

  await expect(errors).toEqual([]);
});

test("mobile setup recovers from malformed localStorage", async ({ page }) => {
  const appUrl = localAppUrl();
  await page.goto(appUrl, { waitUntil: "networkidle" });
  await page.evaluate(() => {
    localStorage.setItem("esperanto-choice-mobile:session:v2", JSON.stringify({ status: "active", questions: "broken" }));
    localStorage.setItem("esperanto-choice-mobile:history:v2", JSON.stringify([{ points: "not-a-number" }]));
  });
  await page.reload({ waitUntil: "networkidle" });
  await expect(page.locator("#setupView")).toHaveClass(/is-active/);
  await expect(page.locator("#startButton")).toBeEnabled();
});


test.describe("unified app on desktop", () => {
  test.use({
    viewport: { width: 1440, height: 1000 }, isMobile: false, hasTouch: false, deviceScaleFactor: 1,
    userAgent: "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0.0.0 Safari/537.36",
  });

  test("uses the same setup, quiz and reload flow without a PC switch", async ({ page }) => {
    await page.goto(localAppUrl(), { waitUntil: "networkidle" });
    await expect(page.locator("#setupView")).toHaveClass(/is-active/);
    await expectUnifiedNavigation(page, "vocab");
    await page.locator("#audioMode").selectOption("off");
    await page.locator("#startButton").click();
    await expect(page.locator("#quizView")).toHaveClass(/is-active/);
    await expect(page.locator(".choice-button")).toHaveCount(4);
    const before = await page.evaluate(() => JSON.parse(localStorage.getItem("esperanto-choice-mobile:session:v2")));
    await page.locator(`.choice-button[data-index="${before.questions[0].answerIndex}"]`).click();
    const answered = await page.evaluate(() => JSON.parse(localStorage.getItem("esperanto-choice-mobile:session:v2")));
    expect(answered.correct).toBe(1);
    expect(answered.qIndex).toBe(1);
    const geometry = await page.evaluate(() => {
      const choices = document.querySelector("#choiceGrid").getBoundingClientRect();
      const nav = document.querySelector(".bottom-nav").getBoundingClientRect();
      return { left: choices.left, right: choices.right, bottom: choices.bottom, navTop: nav.top, width: innerWidth, scrollWidth: document.documentElement.scrollWidth };
    });
    expect(geometry.left).toBeGreaterThanOrEqual(0);
    expect(geometry.right).toBeLessThanOrEqual(geometry.width);
    expect(geometry.bottom).toBeLessThanOrEqual(geometry.navTop + 1);
    expect(geometry.scrollWidth).toBeLessThanOrEqual(geometry.width);
    await page.reload({ waitUntil: "networkidle" });
    await expect(page.locator("#quizView")).toHaveClass(/is-active/);
    const restored = await page.evaluate(() => JSON.parse(localStorage.getItem("esperanto-choice-mobile:session:v2")));
    expect(restored.id).toBe(answered.id);
    expect(restored.answers).toEqual(answered.answers);
  });
});
