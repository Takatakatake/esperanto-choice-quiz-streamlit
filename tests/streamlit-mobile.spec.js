const { test, expect } = require("@playwright/test");

function localAppUrl(fixture = false) {
  const value = fixture
    ? process.env.STUDY_APP_URL || "http://127.0.0.1:8502/"
    : process.env.STREAMLIT_APP_URL || "http://127.0.0.1:8501/";
  const url = new URL(value);
  if (!["127.0.0.1", "localhost", "[::1]"].includes(url.hostname)) {
    throw new Error("Browser regressions must use local Streamlit test servers.");
  }
  return url.toString();
}

async function expectLocalFixture(page) {
  await expect(page.locator('[data-local-learning-fixture="memory"]')).toHaveCount(1, { timeout: 15000 });
}

async function readSession(scope) {
  return scope.locator("body").evaluate(() => JSON.parse(localStorage.getItem("esperanto-choice-mobile:session:v2")));
}

async function expectSetupHeightStable(page, scope) {
  await expect(scope.locator("#setupView")).toHaveClass(/is-active/);
  await scope.locator("body").evaluate(() => document.fonts.ready.then(() => undefined));
  await page.waitForTimeout(500);
  const iframe = page.locator("iframe[title*='esperanto_mobile_pwa']");
  const heights = [];
  // Observe multiple resize cycles: a per-cycle padding error can look correct
  // initially while increasing the frame height indefinitely.
  for (let sample = 0; sample < 9; sample += 1) {
    heights.push(await iframe.evaluate((element) => element.getBoundingClientRect().height));
    if (sample < 8) await page.waitForTimeout(500);
  }
  expect(Math.min(...heights)).toBeGreaterThanOrEqual(640);
  expect(Math.max(...heights) - Math.min(...heights), `Setup iframe heights: ${heights.join(", ")}`).toBeLessThanOrEqual(4);
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
    const session = await readSession(scope);
    if (session.status === "complete") {
      return;
    }
    const question = session.questions[session.inSpartan ? session.spartanCurrent : session.qIndex];
    await scope.locator(`.choice-button[data-index="${question.answerIndex}"]`).click();
    await page.waitForTimeout(80);
  }
  throw new Error("Quiz did not complete within the guard limit");
}

test("Streamlit mobile entry uses the localStorage app and survives reload", async ({ page }) => {
  const appUrl = localAppUrl();
  const errors = [];
  page.on("console", (message) => {
    if (message.type() === "error") {
      errors.push(message.text());
    }
  });
  page.on("pageerror", (error) => errors.push(error.message));

  await page.goto(appUrl, { waitUntil: "domcontentloaded" });
  const mobileApp = page.frameLocator("iframe[title*='esperanto_mobile_pwa']");
  await expect(mobileApp.locator("#startButton")).toBeEnabled({ timeout: 15000 });
  await mobileApp.locator("#homeNav").click();
  await expect(mobileApp.locator("#setupView")).toHaveClass(/is-active/);
  await expect(mobileApp.locator("#audioMode")).toBeEnabled();
  await expect(mobileApp.locator("#audioMode")).toHaveValue("prompt");
  await expect(mobileApp.locator("#lengthSelect")).toHaveCount(0);

  await mobileApp.locator("#modeSentence").click();
  await expect(mobileApp.locator("#modeSentence")).toHaveAttribute("aria-selected", "true");
  await expectUnifiedNavigation(mobileApp, "sentence");
  await mobileApp.locator("#modeVocab").click();
  await expect(mobileApp.locator("#modeVocab")).toHaveAttribute("aria-selected", "true");
  await expect(mobileApp.locator("#jaAppLink")).toHaveClass(/is-active/);
  await expectUnifiedNavigation(mobileApp, "vocab");
  await mobileApp.locator("#directionSelect").selectOption("ja_to_eo");
  await expect(mobileApp.locator("#directionSelect")).toHaveValue("ja_to_eo");
  await mobileApp.locator("#directionSelect").selectOption("eo_to_ja");
  await expectSetupHeightStable(page, mobileApp);

  const setupMetrics = await mobileApp.locator("body").evaluate(() => {
    const start = document.querySelector("#startButton");
    const nav = document.querySelector(".bottom-nav");
    const startRect = start.getBoundingClientRect();
    const navRect = nav.getBoundingClientRect();
    const navStyle = getComputedStyle(nav);
    return {
      startDisabled: start.disabled,
      navPosition: navStyle.position,
      startBottom: startRect.bottom,
      navTop: navRect.top,
      navBottom: navRect.bottom,
    };
  });
  expect(setupMetrics.startDisabled).toBe(false);
  expect(setupMetrics.navPosition).toBe("static");
  expect(setupMetrics.startBottom).toBeLessThanOrEqual(setupMetrics.navTop);
  const iframeBox = await page.locator("iframe[title*='esperanto_mobile_pwa']").boundingBox();
  expect(iframeBox.height).toBeGreaterThan(setupMetrics.navBottom - 1);

  await mobileApp.locator("#userName").fill("streamlit-mobile-test");
  await mobileApp.locator("#startButton").scrollIntoViewIfNeeded();
  await mobileApp.locator("#startButton").click({ trial: true });
  await mobileApp.locator("#quizNav").click();
  await expect(mobileApp.locator("#quizView")).toHaveClass(/is-active/);
  await expect(mobileApp.locator(".choice-button").first()).toBeVisible();
  await expect(mobileApp.locator("#promptAudioButton")).toBeVisible();
  const audioUrlPattern = /\/component\/mobile_streamlit_bridge\.esperanto_mobile_pwa\/(audio|sentence-audio)\/.+\.wav$/;
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
    mobileApp.locator("#promptAudioButton").click(),
  ]);
  expect(audioRequest.url()).not.toContain("drive.google");
  expect([200, 206]).toContain(audioResponse.status());
  expect(audioResponse.headers()["content-type"] || "").toMatch(/audio|octet-stream/);

  const quizMetrics = await mobileApp.locator("body").evaluate(() => {
    const grid = document.querySelector("#choiceGrid");
    const nav = document.querySelector(".bottom-nav");
    const gridRect = grid.getBoundingClientRect();
    const navRect = nav.getBoundingClientRect();
    const navStyle = getComputedStyle(nav);
    return {
      navPosition: navStyle.position,
      gridBottom: gridRect.bottom,
      navTop: navRect.top,
      scrollY: window.scrollY,
    };
  });
  expect(quizMetrics.navPosition).toBe("fixed");
  expect(quizMetrics.gridBottom).toBeLessThanOrEqual(quizMetrics.navTop + 1);
  expect(quizMetrics.scrollY).toBe(0);

  const startedSession = await readSession(mobileApp);
  expect(startedSession.settings).not.toHaveProperty("length");
  const answerIndex = startedSession.questions[startedSession.qIndex].answerIndex;
  const wrongIndex = (answerIndex + 1) % startedSession.questions[startedSession.qIndex].options.length;
  await mobileApp.locator(`.choice-button[data-index="${wrongIndex}"]`).click();
  await expect(mobileApp.locator("#feedbackPanel")).toBeVisible();
  await mobileApp.locator("#nextButton").click({ trial: true });
  await page.waitForTimeout(300);
  const storedBeforeReload = await readSession(mobileApp);
  expect(storedBeforeReload.status).toBe("active");
  expect(storedBeforeReload.answers.length).toBeGreaterThanOrEqual(1);
  expect(storedBeforeReload.answers[0].selectedIndex).not.toBe(storedBeforeReload.answers[0].answerIndex);
  expect(storedBeforeReload.spartanPending.length).toBeGreaterThanOrEqual(1);

  await page.reload({ waitUntil: "domcontentloaded" });
  const restoredMobileApp = page.frameLocator("iframe[title*='esperanto_mobile_pwa']");
  await expect(restoredMobileApp.locator("#quizView, #resultView").first()).toBeVisible();
  const activeView = await restoredMobileApp.locator(".state-view.is-active").first().getAttribute("id");
  expect(["quizView", "resultView"]).toContain(activeView);

  const storedAfterReload = await readSession(restoredMobileApp);
  expect(storedAfterReload.status).toMatch(/active|complete/);

  let dialogSeen = false;
  page.once("dialog", async (dialog) => {
    dialogSeen = true;
    expect(dialog.message()).toContain("進行中のクイズ");
    await dialog.dismiss();
  });
  await restoredMobileApp.locator("#homeNav").click();
  await restoredMobileApp.locator("#startButton").scrollIntoViewIfNeeded();
  await restoredMobileApp.locator("#startButton").click();
  await expect(restoredMobileApp.locator("#quizView")).toHaveClass(/is-active/);
  const protectedSession = await readSession(restoredMobileApp);
  expect(protectedSession.id).toBe(storedAfterReload.id);
  expect(dialogSeen).toBe(true);

  expect(errors).toEqual([]);
});

test("unified result auto-saves to the local fixture and history stays readable", async ({ page }, testInfo) => {
  test.setTimeout(60000);
  const appUrl = localAppUrl(true);
  const errors = [];
  page.on("console", (message) => {
    if (message.type() === "error") {
      errors.push(message.text());
    }
  });
  page.on("pageerror", (error) => errors.push(error.message));

  await page.goto(appUrl, { waitUntil: "domcontentloaded" });
  const mobileApp = page.frameLocator("iframe[title*='esperanto_mobile_pwa']");
  await expect(mobileApp.locator("#startButton")).toBeEnabled({ timeout: 15000 });
  await mobileApp.locator("#homeNav").click();
  await expect(mobileApp.locator("#setupView")).toHaveClass(/is-active/);
  // This marker belongs only to the in-memory fixture, never to a deployed app.
  await expectLocalFixture(page);
  const userName = `local-score-${Date.now()}-${testInfo.workerIndex}`;
  await mobileApp.locator("#userName").fill(userName);
  await mobileApp.locator("#spartanMode").uncheck();
  await mobileApp.locator("#startButton").scrollIntoViewIfNeeded();
  await mobileApp.locator("#startButton").click();
  await expect(mobileApp.locator("#quizView")).toHaveClass(/is-active/);

  await answerRemainingCorrectly(page, mobileApp);
  await expect(mobileApp.locator("#resultView")).toHaveClass(/is-active/);
  await expect(mobileApp.locator("#accuracyMetric")).toHaveText("100%");
  await expect(mobileApp.locator("#syncScoreButton")).toHaveText("学習記録を保存済み", { timeout: 15000 });
  await expect(mobileApp.locator("#syncScoreButton")).toBeDisabled();
  await expect(mobileApp.locator("#syncScoreStatus")).toContainText("累積得点に加算済み");
  const savedSession = await readSession(mobileApp);
  expect(savedSession.scoreSyncStatus).toBe("saved");
  expect(savedSession.scoreSaveId).not.toBe("");
  await expect.poll(() => mobileApp.locator("body").evaluate((_body, saveId) => {
    const key = `esperanto-choice-mobile:outbox:v2:${encodeURIComponent(saveId)}`;
    const pendingKeys = Object.keys(localStorage).filter((entryKey) => entryKey.startsWith("esperanto-choice-mobile:outbox:v2:")
      && JSON.parse(localStorage.getItem(entryKey))?.payload);
    return { legacy: localStorage.getItem("esperanto-choice-mobile:outbox:v1"), receipt: JSON.parse(localStorage.getItem(key)), pendingKeys };
  }, savedSession.scoreSaveId)).toEqual({
    legacy: null,
    receipt: { type: "saved_score_receipt", saveId: savedSession.scoreSaveId },
    pendingKeys: [],
  });
  await expect(mobileApp.locator("#reviewList .review-item").first()).toBeVisible();

  const resultMetrics = await mobileApp.locator("body").evaluate(() => {
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

  await mobileApp.locator("#historyNav").click();
  await expect(mobileApp.locator("#historyView")).toHaveClass(/is-active/);
  await expect(mobileApp.locator("#cloudRankingTitle")).toBeVisible();
  await expect(mobileApp.locator("#rankingStatus")).toContainText("ランキングを表示しました", { timeout: 15000 });
  await expect(mobileApp.locator("#historyList .history-item").first()).toContainText("単語");
  await expect(mobileApp.locator("#historyList .history-sync-status").first()).toContainText("保存済み");
  await expect(mobileApp.locator("#progressContent .progress-totals strong").first()).toHaveText(`${savedSession.finalPoints.toFixed(1)}点`, { timeout: 15000 });
  await expect(mobileApp.locator("#rankingPublic")).toBeChecked();
  await mobileApp.locator("#rankingPublic").click();
  await expect(mobileApp.locator("#rankingPublic")).toBeEnabled({ timeout: 15000 });
  await expect(mobileApp.locator("#rankingPublic")).not.toBeChecked();
  for (const tab of ["overall", "today", "month", "hof"]) {
    await mobileApp.locator(`[data-ranking-tab="${tab}"]`).click();
    await expect(mobileApp.locator("#rankingStatus")).toContainText("ランキングを表示しました", { timeout: 15000 });
    await expect(mobileApp.locator("#rankingList")).not.toContainText(userName);
  }
  // Ranking visibility is independent of the account's saved progress.
  await expect(mobileApp.locator("#progressContent .progress-totals strong").first()).toHaveText(`${savedSession.finalPoints.toFixed(1)}点`);
  await page.reload({ waitUntil: "domcontentloaded" });
  await expectLocalFixture(page);
  await expect(mobileApp.locator("#resultView")).toHaveClass(/is-active/, { timeout: 15000 });
  await expect(mobileApp.locator("#syncScoreButton")).toHaveText("学習記録を保存済み");
  await mobileApp.locator("#historyNav").click();
  await expect(mobileApp.locator("#rankingPublic")).toBeEnabled({ timeout: 15000 });
  await expect(mobileApp.locator("#rankingPublic")).not.toBeChecked();
  await expect(mobileApp.locator("#progressContent .progress-totals strong").first()).toHaveText(`${savedSession.finalPoints.toFixed(1)}点`);

  // A saved quiz keeps its own account when retried after viewing another name.
  await mobileApp.locator("#historyUserName").fill("Review-A");
  await mobileApp.locator("#historyUserButton").click();
  await expect(mobileApp.locator("#progressContent .progress-totals strong").first()).toHaveText("200.0点", { timeout: 15000 });
  await expect(mobileApp.locator("#rankingPublic")).toBeChecked();
  await mobileApp.locator("#quizNav").click();
  await mobileApp.locator("#retryButton").click();
  await expect(mobileApp.locator("#quizView")).toHaveClass(/is-active/);
  expect((await readSession(mobileApp)).settings.userName).toBe(userName);
  await mobileApp.locator("#historyNav").click();
  await expect(mobileApp.locator("#historyUserName")).toHaveValue(userName);
  await expect(mobileApp.locator("#rankingPublic")).toBeEnabled({ timeout: 15000 });
  await expect(mobileApp.locator("#rankingPublic")).not.toBeChecked();
  await expect(mobileApp.locator("#progressContent .progress-totals strong").first()).toHaveText(`${savedSession.finalPoints.toFixed(1)}点`);

  await mobileApp.locator("#diagnosticsNav").click();
  await expect(mobileApp.locator("#diagnosticsView")).toHaveClass(/is-active/);
  await expect(mobileApp.locator("#diagnosticsList")).toContainText("Streamlit Cloud組み込み");
  await expect(mobileApp.locator("#diagnosticsList")).toContainText("クイズデータ");
  await expect(mobileApp.locator("#diagnosticsList")).toContainText("スコア保存");
  await expect(mobileApp.locator("#diagnosticsList")).toContainText("Service Worker");
  await expect(mobileApp.locator("#audioDiagSentenceButton")).toBeEnabled();
  const diagnosticAudioResponsePromise = page.waitForResponse(
    (response) => /\/component\/mobile_streamlit_bridge\.esperanto_mobile_pwa\/sentence-audio\/.+\.wav$/.test(response.url()),
    { timeout: 5000 },
  );
  await mobileApp.locator("#audioDiagSentenceButton").click();
  const diagnosticAudioResponse = await diagnosticAudioResponsePromise;
  expect([200, 206]).toContain(diagnosticAudioResponse.status());
  await expect(mobileApp.locator("#audioDiagSentenceStatus")).toContainText("再生できました");
  expect(errors).toEqual([]);
});

test("saved results survive receipt storage failure and reload without another score request", async ({ page }, testInfo) => {
  test.setTimeout(60000);
  await page.addInitScript(() => {
    const originalSetItem = Storage.prototype.setItem;
    Storage.prototype.setItem = function (key, value) {
      if (key.startsWith("esperanto-choice-mobile:outbox:v2:")
          && JSON.parse(value)?.type === "saved_score_receipt") {
        throw new DOMException("Fixture receipt write failure", "QuotaExceededError");
      }
      return originalSetItem.call(this, key, value);
    };
    if (window === window.top) {
      window.fixtureScoreRequests = [];
      window.addEventListener("message", (event) => {
        if (event.data?.type === "streamlit:setComponentValue" && event.data?.value?.type === "save_score") {
          window.fixtureScoreRequests.push(event.data.value.saveId);
        }
      });
    }
  });
  await page.goto(localAppUrl(true), { waitUntil: "domcontentloaded" });
  await expectLocalFixture(page);
  const app = page.frameLocator("iframe[title*='esperanto_mobile_pwa']");
  await expect(app.locator("#startButton")).toBeEnabled({ timeout: 15000 });
  await app.locator("#userName").fill(`receipt-failure-${Date.now()}-${testInfo.workerIndex}`);
  await app.locator("#spartanMode").uncheck();
  await app.locator("#audioMode").selectOption("off");
  await app.locator("#startButton").click();
  await answerRemainingCorrectly(page, app);
  await expect(app.locator("#syncScoreButton")).toHaveText("学習記録を保存済み", { timeout: 15000 });
  const savedSession = await readSession(app);
  expect(savedSession.scoreSyncStatus).toBe("saved");
  expect(await page.evaluate(() => window.fixtureScoreRequests)).toEqual([savedSession.scoreSaveId]);
  // The fault leaves the pending disk entry intact, so the next load must use
  // the durably saved session/history as proof of the server acknowledgement.
  const storedEntry = await app.locator("body").evaluate((_body, saveId) => (
    JSON.parse(localStorage.getItem(`esperanto-choice-mobile:outbox:v2:${encodeURIComponent(saveId)}`))
  ), savedSession.scoreSaveId);
  expect(storedEntry.payload.saveId).toBe(savedSession.scoreSaveId);

  await page.reload({ waitUntil: "domcontentloaded" });
  await expectLocalFixture(page);
  await expect(app.locator("#resultView")).toHaveClass(/is-active/, { timeout: 15000 });
  await expect(app.locator("#syncScoreButton")).toHaveText("学習記録を保存済み");
  await app.locator("#historyNav").click();
  await expect(app.locator("#progressContent .progress-totals strong").first()).toHaveText(`${savedSession.finalPoints.toFixed(1)}点`, { timeout: 15000 });
  await expect(app.locator("#historyList .history-sync-status").first()).toContainText("保存済み");
  expect(await page.evaluate(() => window.fixtureScoreRequests)).toEqual([]);
});

test("fixture accounts show their own field totals while private accounts stay out of rankings", async ({ page }) => {
  await page.goto(localAppUrl(true), { waitUntil: "domcontentloaded" });
  await expectLocalFixture(page);
  const app = page.frameLocator("iframe[title*='esperanto_mobile_pwa']");
  await expect(app.locator("#startButton")).toBeEnabled({ timeout: 15000 });
  await app.locator("#historyNav").click();
  await app.locator("#historyUserName").fill("Review-A");
  await app.locator("#historyUserButton").click();
  await expect(app.locator("#progressContent .progress-totals strong")).toHaveText(["200.0点", "150.0点", "50.0点"], { timeout: 15000 });
  await expect(app.locator("#progressContent")).toContainText("名詞");
  await expect(app.locator("#progressContent")).toContainText("動詞");
  await expect(app.locator("#progressContent")).toContainText("travel");
  await expect(app.locator("#rankingPublic")).toBeChecked();

  await app.locator("#historyUserName").fill("Review-B");
  await app.locator("#historyUserButton").click();
  await expect(app.locator("#progressContent .progress-totals strong")).toHaveText(["1200000.0点", "1000000.0点", "200000.0点"], { timeout: 15000 });
  await expect(app.locator("#rankingPublic")).toBeEnabled();
  await expect(app.locator("#rankingPublic")).not.toBeChecked();
  for (const tab of ["overall", "today", "month", "hof"]) {
    await app.locator(`[data-ranking-tab="${tab}"]`).click();
    await expect(app.locator("#rankingStatus")).toContainText("ランキングを表示しました", { timeout: 15000 });
    await expect(app.locator("#rankingList")).not.toContainText("Review-B");
  }
  await expect(app.locator("input[type='password']")).toHaveCount(0);
});

test("Streamlit mobile review can replay the Esperanto correct answer", async ({ page }) => {
  const appUrl = localAppUrl();
  const errors = [];
  page.on("console", (message) => {
    if (message.type() === "error") {
      errors.push(message.text());
    }
  });
  page.on("pageerror", (error) => errors.push(error.message));

  await page.goto(appUrl, { waitUntil: "domcontentloaded" });
  const mobileApp = page.frameLocator("iframe[title*='esperanto_mobile_pwa']");
  await expect(mobileApp.locator("#startButton")).toBeEnabled({ timeout: 15000 });
  await mobileApp.locator("#homeNav").click();
  await mobileApp.locator("#spartanMode").uncheck();
  await mobileApp.locator("#startButton").scrollIntoViewIfNeeded();
  await mobileApp.locator("#startButton").click();
  await expect(mobileApp.locator("#quizView")).toHaveClass(/is-active/);

  const startedSession = await readSession(mobileApp);
  const answerIndex = startedSession.questions[startedSession.qIndex].answerIndex;
  const wrongIndex = (answerIndex + 1) % startedSession.questions[startedSession.qIndex].options.length;
  await mobileApp.locator(`.choice-button[data-index="${wrongIndex}"]`).click();
  await expect(mobileApp.locator("#feedbackPanel")).toBeVisible();
  await mobileApp.locator("#nextButton").click();

  await answerRemainingCorrectly(page, mobileApp);
  await expect(mobileApp.locator("#resultView")).toHaveClass(/is-active/);
  await expect(mobileApp.locator(".review-audio-button").first()).toBeVisible();

  const audioUrlPattern = /\/component\/mobile_streamlit_bridge\.esperanto_mobile_pwa\/audio\/.+\.wav$/;
  const audioResponsePromise = page.waitForResponse(
    (response) => audioUrlPattern.test(response.url()),
    { timeout: 5000 },
  );
  await mobileApp.locator(".review-audio-button").first().click();
  const audioResponse = await audioResponsePromise;
  expect([200, 206]).toContain(audioResponse.status());
  expect(audioResponse.headers()["content-type"] || "").toMatch(/audio|octet-stream/);

  expect(errors).toEqual([]);
});

test("Streamlit mobile sentence prompt audio is served only for Esperanto prompts", async ({ page }) => {
  const appUrl = localAppUrl();
  const errors = [];
  page.on("console", (message) => {
    if (message.type() === "error") {
      errors.push(message.text());
    }
  });
  page.on("pageerror", (error) => errors.push(error.message));

  await page.goto(appUrl, { waitUntil: "domcontentloaded" });
  const mobileApp = page.frameLocator("iframe[title*='esperanto_mobile_pwa']");
  await expect(mobileApp.locator("#startButton")).toBeEnabled({ timeout: 15000 });
  await mobileApp.locator("#homeNav").click();
  await mobileApp.locator("#modeSentence").click();
  await expect(mobileApp.locator("#modeSentence")).toHaveAttribute("aria-selected", "true");
  await mobileApp.locator("#audioMode").selectOption("all");
  await mobileApp.locator("#spartanMode").uncheck();
  const sentenceAudioUrlPattern = /\/component\/mobile_streamlit_bridge\.esperanto_mobile_pwa\/sentence-audio\/.+\.wav$/;
  const promptAudioResponsePromise = page.waitForResponse(
    (response) => sentenceAudioUrlPattern.test(response.url()),
    { timeout: 5000 },
  );
  await mobileApp.locator("#startButton").scrollIntoViewIfNeeded();
  await mobileApp.locator("#startButton").click();
  await expect(mobileApp.locator("#quizView")).toHaveClass(/is-active/);
  await expect(mobileApp.locator("#promptAudioButton")).toBeVisible();
  await expect(mobileApp.locator(".choice-audio-button")).toHaveCount(0);

  const promptAudioResponse = await promptAudioResponsePromise;
  expect([200, 206]).toContain(promptAudioResponse.status());
  expect(promptAudioResponse.headers()["content-type"] || "").toMatch(/audio|octet-stream/);

  const session = await readSession(mobileApp);
  const answerIndex = session.questions[session.qIndex].answerIndex;
  const nextPromptAudioResponsePromise = page.waitForResponse(
    (response) => sentenceAudioUrlPattern.test(response.url()),
    { timeout: 5000 },
  );
  await mobileApp.locator(`.choice-button[data-index="${answerIndex}"]`).click();
  const nextPromptAudioResponse = await nextPromptAudioResponsePromise;
  expect([200, 206]).toContain(nextPromptAudioResponse.status());

  expect(errors).toEqual([]);
});

test("Streamlit mobile sentence entry applies the bridge default mode", async ({ page }) => {
  const appUrl = new URL(localAppUrl());
  appUrl.searchParams.set("quiz", "sentence");

  await page.goto(appUrl.toString(), { waitUntil: "domcontentloaded" });
  const mobileApp = page.frameLocator("iframe[title*='esperanto_mobile_pwa']");
  await expect(mobileApp.locator("#startButton")).toBeEnabled({ timeout: 15000 });
  await expect(mobileApp.locator("#modeSentence")).toHaveAttribute("aria-selected", "true");
  await expectUnifiedNavigation(mobileApp, "sentence");
  await expect(mobileApp.locator("#sentenceSettings")).toBeVisible();
});

test("Streamlit mobile sentence choice audio is served only for Esperanto choices", async ({ page }) => {
  const appUrl = localAppUrl();
  const errors = [];
  page.on("console", (message) => {
    if (message.type() === "error") {
      errors.push(message.text());
    }
  });
  page.on("pageerror", (error) => errors.push(error.message));

  await page.goto(appUrl, { waitUntil: "domcontentloaded" });
  const mobileApp = page.frameLocator("iframe[title*='esperanto_mobile_pwa']");
  await expect(mobileApp.locator("#startButton")).toBeEnabled({ timeout: 15000 });
  await mobileApp.locator("#homeNav").click();
  await mobileApp.locator("#modeSentence").click();
  await expect(mobileApp.locator("#modeSentence")).toHaveAttribute("aria-selected", "true");
  await mobileApp.locator("#directionSelect").selectOption("ja_to_eo");
  await mobileApp.locator("#audioMode").selectOption("all");
  await mobileApp.locator("#spartanMode").uncheck();
  const earlyAudioRequests = [];
  const sentenceAudioUrlPattern = /\/component\/mobile_streamlit_bridge\.esperanto_mobile_pwa\/sentence-audio\/.+\.wav$/;
  page.on("request", (request) => {
    if (sentenceAudioUrlPattern.test(request.url())) {
      earlyAudioRequests.push(request.url());
    }
  });
  await mobileApp.locator("#startButton").scrollIntoViewIfNeeded();
  await mobileApp.locator("#startButton").click();
  await expect(mobileApp.locator("#quizView")).toHaveClass(/is-active/);
  await expect(mobileApp.locator("#promptAudioButton")).toBeHidden();
  await expect(mobileApp.locator(".choice-audio-button").first()).toBeVisible();
  await page.waitForTimeout(500);
  expect(earlyAudioRequests).toHaveLength(0);

  const choiceAudioResponsePromise = page.waitForResponse(
    (response) => sentenceAudioUrlPattern.test(response.url()),
    { timeout: 5000 },
  );
  await mobileApp.locator(".choice-audio-button").first().click();
  const choiceAudioResponse = await choiceAudioResponsePromise;
  expect([200, 206]).toContain(choiceAudioResponse.status());
  expect(choiceAudioResponse.headers()["content-type"] || "").toMatch(/audio|octet-stream/);

  expect(errors).toEqual([]);
});


test.describe("unified Streamlit entry on desktop", () => {
  test.use({
    viewport: { width: 1440, height: 1000 }, isMobile: false, hasTouch: false, deviceScaleFactor: 1,
    userAgent: "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0.0.0 Safari/537.36",
  });

  test("an old classic URL opens the unified sentence quiz", async ({ page }) => {
    const url = new URL(localAppUrl());
    url.searchParams.set("classic", "1");
    url.searchParams.set("quiz", "sentence");
    await page.goto(url.toString(), { waitUntil: "domcontentloaded" });
    await expect(page.locator("iframe[title*='esperanto_mobile_pwa']")).toHaveCount(1);
    const app = page.frameLocator("iframe[title*='esperanto_mobile_pwa']");
    await expect(app.locator("#setupView")).toHaveClass(/is-active/, { timeout: 15000 });
    await expect(app.locator("#modeSentence")).toHaveAttribute("aria-selected", "true");
    await expectUnifiedNavigation(app, "sentence");
    await expectSetupHeightStable(page, app);
    await app.locator("#audioMode").selectOption("off");
    await app.locator("#startButton").click();
    await expect(app.locator("#quizView")).toHaveClass(/is-active/);
    await expect(app.locator(".choice-button")).toHaveCount(4);
    const session = await readSession(app);
    expect(session.settings.mode).toBe("sentence");
    expect(session.source).toBe("sentence_ja");
    const geometry = await app.locator("body").evaluate(() => ({ width: innerWidth, scrollWidth: document.documentElement.scrollWidth }));
    expect(geometry.scrollWidth).toBeLessThanOrEqual(geometry.width);
  });
});

for (const [lang, mode, label, script] of [["zh", "vocab", "单词", /[\u4e00-\u9fff]/], ["ko", "sentence", "예문", /[가-힣]/]]) {
  test(`local fixture bridge honors ${lang} language and ${mode} entry`, async ({ page }) => {
    const url = new URL(localAppUrl(true));
    url.searchParams.set("lang", lang);
    url.searchParams.set("quiz", mode);
    await page.goto(url.toString(), { waitUntil: "domcontentloaded" });
    await expectLocalFixture(page);
    const app = page.frameLocator("iframe[title*='esperanto_mobile_pwa']");
    await expect(app.locator(`#mode${mode === "vocab" ? "Vocab" : "Sentence"}`)).toHaveText(label, { timeout: 15000 });
    await expectUnifiedNavigation(app, mode);
    await app.locator("#audioMode").selectOption("off");
    await app.locator("#startButton").click();
    await expect(app.locator("#quizView")).toHaveClass(/is-active/);
    const session = await readSession(app);
    expect(session.targetLang).toBe(lang);
    expect(session.settings.mode).toBe(mode);
    expect(session.source).toBe(`${mode}_${lang}`);
    expect(session.questions[0].promptJa).toMatch(script);
    expect(session.questions[0].options.every((option) => script.test(option.ja))).toBe(true);
  });
}
