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

function localCloudShellUrl(appUrl) {
  const url = new URL("/tests/fixtures/cloud_shell.html", process.env.MOBILE_APP_URL || "http://127.0.0.1:8765/mobile_app/");
  if (!["127.0.0.1", "localhost", "[::1]"].includes(url.hostname)) {
    throw new Error("The Cloud shell regression must use the local static fixture server.");
  }
  if (url.origin === new URL(appUrl).origin) throw new Error("The Cloud shell must have a different origin from Streamlit.");
  url.searchParams.set("app", appUrl);
  return url.href;
}

async function pointerReachableBox(page, target) {
  const box = await target.boundingBox();
  const viewport = page.viewportSize();
  if (!box || box.y < 0 || box.y + box.height > viewport.height || box.x < 0 || box.x + box.width > viewport.width) return null;
  const point = { x: box.x + box.width / 2, y: box.y + box.height / 2 };
  const receivesPointer = await target.evaluate((element) => {
    const rect = element.getBoundingClientRect();
    const hit = element.ownerDocument.elementFromPoint(rect.left + rect.width / 2, rect.top + rect.height / 2);
    return hit === element || element.contains(hit);
  });
  if (!receivesPointer) return null;
  const handle = await target.elementHandle();
  let owner = await handle.ownerFrame();
  await handle.dispose();
  // A child's bounding box can lie inside the top viewport but still be clipped
  // by Streamlit's scrolling parent or the Cloud iframe. Check every ancestor.
  while (owner?.parentFrame()) {
    const frameElement = await owner.frameElement();
    const frameBox = await frameElement.boundingBox();
    if (!frameBox) { await frameElement.dispose(); return null; }
    const hitFrame = await frameElement.evaluate((element, offset) => {
      const rect = element.getBoundingClientRect();
      return element.ownerDocument.elementFromPoint(rect.left + offset.x, rect.top + offset.y) === element;
    }, { x: point.x - frameBox.x, y: point.y - frameBox.y });
    await frameElement.dispose();
    if (!hitFrame) return null;
    owner = owner.parentFrame();
  }
  return { ...box, point };
}

async function wheelToTarget(page, iframe, target, description) {
  await expect(target).toBeAttached();
  for (let step = 0; step < 65; step += 1) {
    const reachable = await pointerReachableBox(page, target);
    if (reachable) return reachable;
    const box = await target.boundingBox();
    const frameBox = await iframe.boundingBox();
    const viewport = page.viewportSize();
    const direction = box && box.y + box.height / 2 < viewport.height / 2 ? -1 : 1;
    const x = Math.max(20, Math.min(viewport.width - 20, frameBox.x + frameBox.width / 2));
    await page.mouse.move(x, viewport.height * 0.55);
    // Only genuine wheel input moves the page. No locator auto-scroll, scrollTo,
    // scrollIntoView, or scrollTop assignment may bypass a disabled iframe scroll.
    await page.mouse.wheel(0, direction * 320);
    await page.waitForTimeout(150);
  }
  const box = await target.boundingBox();
  expect(await pointerReachableBox(page, target), `${description} must be reachable by wheel; final box ${JSON.stringify(box)}`).not.toBeNull();
}

async function expectHistoryHeightStable(page, iframe) {
  await page.waitForTimeout(400);
  const heights = [];
  for (let sample = 0; sample < 6; sample += 1) {
    heights.push(await iframe.evaluate((element) => element.getBoundingClientRect().height));
    if (sample < 5) await page.waitForTimeout(400);
  }
  expect(Math.min(...heights)).toBeGreaterThanOrEqual(640);
  expect(Math.max(...heights) - Math.min(...heights), `History iframe heights: ${heights.join(", ")}`).toBeLessThanOrEqual(4);
}

async function checkLongHistoryScrolling(page, { nested = false } = {}) {
  const appUrl = localAppUrl(true);
  await page.goto(nested ? localCloudShellUrl(appUrl) : appUrl, { waitUntil: "domcontentloaded" });
  const host = nested ? page.frameLocator("#cloudApp") : page;
  if (nested) await expect(page.locator("#cloudApp")).toHaveAttribute("scrolling", "no");
  await expectLocalFixture(host);
  const iframe = host.locator("iframe[title*='esperanto_mobile_pwa']");
  const app = host.frameLocator("iframe[title*='esperanto_mobile_pwa']");
  await expect(app.locator("#startButton")).toBeEnabled({ timeout: 15000 });
  // Seed the resolved component's own storage, then exercise the real reload
  // path. A URL-gated init script did not populate these iframe records in CI.
  const seededCount = await app.locator("body").evaluate(() => {
    const key = "esperanto-choice-mobile:history:v2";
    localStorage.setItem(key, JSON.stringify(Array.from({ length: 12 }, (_, index) => ({
      id: `long-history-${index}`, userName: "Review-Long", mode: "vocab", direction: "eo_to_ja",
      correct: 4, total: 4, accuracy: 1, points: 1000 + index,
      completedAt: "2026-09-06T00:00:00Z", scoreSyncStatus: "local",
    }))));
    return JSON.parse(localStorage.getItem(key)).length;
  });
  expect(seededCount).toBe(12);
  await page.reload({ waitUntil: "domcontentloaded" });
  await expectLocalFixture(host);
  await expect(app.locator("#startButton")).toBeEnabled({ timeout: 15000 });
  expect(await app.locator("body").evaluate(() => JSON.parse(localStorage.getItem("esperanto-choice-mobile:history:v2"))?.length)).toBe(12);
  // Match deployed Streamlit's iframe constraint even if a local version defaults differently.
  await iframe.evaluate((element) => element.setAttribute("scrolling", "no"));
  await app.locator("#userName").fill("Review-Long");
  await app.locator("#historyNav").click();
  await expect(app.locator("#progressContent .progress-totals strong")).toHaveText(["7040.0点", "200.0点", "6840.0点"], { timeout: 15000 });
  await expect(app.locator("#rankingStatus")).toContainText("ランキングを表示しました", { timeout: 15000 });
  await expect(app.locator("#progressContent details")).toHaveCount(18);
  await expect(app.locator("#historyList .history-item")).toHaveCount(12);
  const finalCategory = app.locator("#progressContent details").last();
  const summary = finalCategory.locator("summary");
  await expect(summary).toHaveText("Time & Weather40.0点");

  const categoryBox = await wheelToTarget(page, iframe, summary, "Final sentence category");
  const collapsedHeight = await finalCategory.evaluate((element) => element.getBoundingClientRect().height);
  await page.mouse.click(categoryBox.point.x, categoryBox.point.y);
  await expect(finalCategory).toHaveAttribute("open", "");
  await expect.poll(() => finalCategory.evaluate((element) => element.getBoundingClientRect().height)).toBeGreaterThan(collapsedHeight + 100);
  const weather = finalCategory.locator(":scope > .progress-category-row").last();
  await expect(weather).toHaveText("Weather10.0点");
  await wheelToTarget(page, iframe, weather, "Expanded final subtopic");
  await expectHistoryHeightStable(page, iframe);

  await wheelToTarget(page, iframe, app.locator("#rankingPublic"), "Ranking visibility checkbox");
  await expect(app.locator("#rankingPublic")).toBeEnabled();
  await expect(app.locator("#rankingPublic")).not.toBeChecked();
  await wheelToTarget(page, iframe, app.locator("#cloudRankingTitle"), "Rankings below the privacy setting");
  const lastHistory = app.locator("#historyList .history-item").last();
  await expect(lastHistory.locator("strong")).toHaveText("単語 1011.0点");
  await wheelToTarget(page, iframe, lastHistory, "Last device history record below progress and rankings");
  await expect(iframe).toHaveAttribute("scrolling", "no");

  // Exercise upward scrolling and shrinking details too, then confirm the end
  // remains reachable without stale height feedback or a navigation overlay.
  const expandedSummaryBox = await wheelToTarget(page, iframe, summary, "Expanded category heading on return");
  await page.mouse.click(expandedSummaryBox.point.x, expandedSummaryBox.point.y);
  await expect(finalCategory).not.toHaveAttribute("open", "");
  await expectHistoryHeightStable(page, iframe);
  await wheelToTarget(page, iframe, lastHistory, "History end after collapsing details");
  await wheelToTarget(page, iframe, app.locator("#koAppLink"), "Language links at the page footer");
  const diagnosticsNav = await pointerReachableBox(page, app.locator("#diagnosticsNav"));
  expect(diagnosticsNav, "Fixed navigation must remain usable at the page end").not.toBeNull();
  await page.mouse.click(diagnosticsNav.point.x, diagnosticsNav.point.y);
  await expect(app.locator("#diagnosticsView")).toHaveClass(/is-active/);
  await expect.poll(() => pointerReachableBox(page, app.locator("#diagnosticsRefreshButton"))).not.toBeNull();
  const historyNav = await pointerReachableBox(page, app.locator("#historyNav"));
  expect(historyNav).not.toBeNull();
  await page.mouse.click(historyNav.point.x, historyNav.point.y);
  await expect(app.locator("#historyView")).toHaveClass(/is-active/);
  await expect.poll(() => pointerReachableBox(page, app.locator("#historyUserName"))).not.toBeNull();
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

for (const nested of [false, true]) {
  test(`long history remains wheel-scrollable on mobile ${nested ? "inside the Cloud shell" : "with iframe scrolling disabled"}`, async ({ page }) => {
    test.setTimeout(90000);
    await checkLongHistoryScrolling(page, { nested });
  });
}

test("navigation stays disabled until startup data is ready and then opens history", async ({ page }) => {
  test.setTimeout(45000);
  let releaseData;
  let dataBlocked = false;
  const dataGate = new Promise((resolve) => { releaseData = resolve; });
  await page.route("**/data/vocab.json", async (route) => {
    dataBlocked = true;
    await dataGate;
    await route.continue();
  });
  try {
    await page.goto(localAppUrl(true), { waitUntil: "domcontentloaded" });
    await expectLocalFixture(page);
    const app = page.frameLocator("iframe[title*='esperanto_mobile_pwa']");
    await expect.poll(() => dataBlocked, { timeout: 15000 }).toBe(true);
    await expect(app.locator("#app")).toHaveClass(/view-loading/);
    for (const id of ["homeNav", "quizNav", "historyNav", "diagnosticsNav"]) {
      await expect(app.locator(`#${id}`)).toBeDisabled();
    }
    releaseData();
    await expect(app.locator("#setupView")).toHaveClass(/is-active/, { timeout: 15000 });
    for (const id of ["homeNav", "quizNav", "historyNav", "diagnosticsNav"]) {
      await expect(app.locator(`#${id}`)).toBeEnabled();
    }
    await app.locator("#historyNav").click();
    await expect(app.locator("#historyView")).toHaveClass(/is-active/);
    await expect(app.locator("#historyUserName")).toBeVisible();
  } finally {
    releaseData();
  }
});

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
  // Initial iframe HTML can appear visible before its CSS and app initialize.
  // Wait for the restored active view, not the uninitialized section's geometry.
  await expect(restoredMobileApp.locator(".state-view.is-active")).toHaveAttribute("id", "quizView", { timeout: 15000 });
  await expect(restoredMobileApp.locator("#feedbackPanel")).toBeVisible();

  const storedAfterReload = await readSession(restoredMobileApp);
  expect(storedAfterReload.status).toBe("active");
  expect(storedAfterReload.id).toBe(storedBeforeReload.id);
  expect(storedAfterReload.answers).toEqual(storedBeforeReload.answers);
  expect(storedAfterReload.spartanPending).toEqual(storedBeforeReload.spartanPending);

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
  // The HTML start button is enabled even while its setup view is hidden.
  // Wait for initialization before navigating, or init can still select setup.
  await expect(app.locator("#setupView")).toHaveClass(/is-active/, { timeout: 15000 });
  await app.locator("#historyNav").click();
  await expect(app.locator("#historyView")).toHaveClass(/is-active/);
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

  test("long history remains wheel-scrollable on desktop inside the Cloud shell", async ({ page }) => {
    test.setTimeout(90000);
    await checkLongHistoryScrolling(page, { nested: true });
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
