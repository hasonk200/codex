const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const { createServer } = require('node:http');
const { readFileSync, existsSync } = require('node:fs');
const { join, resolve, extname, sep } = require('node:path');
const { chromium, webkit } = require('playwright');
const harness = require('./app-harness.cjs');
const { randomUUID } = require('node:crypto');

let server, browser, origin;
const html = harness.instrument(readFileSync(join(__dirname, '../index.html'), 'utf8'));
const engine = process.env.TEST_BROWSER || 'chromium';

before(async () => {
  server = createServer(async (request, response) => {
    const root = resolve(__dirname, '..');
    if (await harness.handle(request, response, root)) return;
    const pathname = new URL(request.url, 'http://localhost').pathname;
    if (pathname.startsWith('/assets/')) {
      const path = resolve(root, `.${pathname}`);
      if (!path.startsWith(`${root}${sep}assets${sep}`) || !existsSync(path)) {
        response.writeHead(404); response.end(); return;
      }
      response.writeHead(200, { 'Content-Type': extname(path) === '.woff2' ? 'font/woff2' : 'text/css; charset=utf-8' });
      response.end(readFileSync(path)); return;
    }
    response.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
    response.end(html);
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  origin = `http://127.0.0.1:${server.address().port}`;
  const executablePath = process.env.CHROMIUM_PATH || (existsSync('/usr/bin/chromium') ? '/usr/bin/chromium' : undefined);
  browser = await (engine === 'webkit' ? webkit : chromium).launch(
    engine === 'webkit' ? {} : { executablePath, args: ['--no-sandbox'] }
  );
});

after(async () => {
  await browser?.close();
  await new Promise(resolve => server?.close(resolve));
});

async function openPage(t, viewport = { width: 390, height: 844 }) {
  const context = await browser.newContext({ viewport, isMobile: true, hasTouch: true, locale: 'zh-TW' });
  t.after(() => context.close());
  // All writes use the app's isolated, local-only fixture database.
  await context.addInitScript(() => { Date.now = () => Date.parse('2026-11-04T17:00:00Z'); });
  const page = await context.newPage();
  const errors = [];
  page.on('pageerror', error => errors.push(error.message));
  t.after(() => assert.deepEqual(errors, []));
  await page.goto(`${origin}/?fixture=1&scene=planning`);
  await page.getByRole('button', { name: '我的時間', exact: true }).click();
  return page;
}

async function openSleep(page, date = '2026-11-01', plan = false) {
  await page.getByLabel('睡眠日期', { exact: true }).fill(date);
  await page.getByRole('button', { name: plan ? '安排睡眠' : '記錄睡眠', exact: true }).click();
  return page.getByRole('dialog');
}

async function saveSleep(page, plan = false) {
  await page.getByRole('button', { name: plan ? '儲存睡眠計畫' : '儲存睡眠紀錄', exact: true }).click();
  await page.getByRole('dialog').waitFor({ state: 'hidden' });
}

async function sleepRevisions(page) {
  return page.evaluate(async () => {
    const database = (await indexedDB.databases()).find(item => item.name.includes('fixture'));
    const db = await new Promise(resolve => { const request = indexedDB.open(database.name); request.onsuccess = () => resolve(request.result); });
    const revisions = await new Promise(resolve => { const request = db.transaction('revisions').objectStore('revisions').getAll(); request.onsuccess = () => resolve(request.result); });
    db.close();
    return revisions.filter(item => item.entityType === 'sleep');
  });
}

async function assertNoOverflow(page) {
  const metrics = await page.evaluate(() => ({
    width: innerWidth, document: document.documentElement.scrollWidth,
    controls: [...document.querySelectorAll('input, select, textarea, .modal, .modal-body')]
      .filter(element => element.getClientRects().length)
      .map(element => ({ name: element.getAttribute('aria-label') || element.className,
        right: element.getBoundingClientRect().right, left: element.getBoundingClientRect().left,
        client: element.clientWidth, scroll: element.scrollWidth }))
  }));
  assert.ok(metrics.document <= metrics.width + 1, JSON.stringify(metrics));
  for (const control of metrics.controls) {
    assert.ok(control.left >= -1 && control.right <= metrics.width + 1, JSON.stringify(control));
    if (control.name === 'modal-body') assert.ok(control.scroll <= control.client + 1, JSON.stringify(control));
  }
}

test('overnight sleep uses tomorrow and persists an eight-hour actual record', async t => {
  const page = await openPage(t);
  const dialog = await openSleep(page);
  assert.equal(await dialog.locator('select:visible').count(), 0);
  assert.equal(await dialog.getByLabel('預計入睡時間', { exact: true }).isVisible(), false);
  await dialog.getByLabel('入睡時間', { exact: true }).fill('23:00');
  await dialog.getByLabel('起床時間', { exact: true }).fill('07:00');
  assert.equal(await dialog.getByLabel('起床日期', { exact: true }).inputValue(), '2026-11-02');
  assert.match(await dialog.locator('.sleep-duration').first().innerText(), /8 小時/);
  await dialog.locator('#sleep-note').fill('半夜醒來一次');
  await saveSleep(page);
  const [revision] = await sleepRevisions(page);
  assert.equal(revision.payload.actualEndMs - revision.payload.actualStartMs, 8 * 3600000);
  assert.equal(revision.payload.plannedStartMs, null);
  assert.equal(revision.payload.note, '半夜醒來一次');
  await page.reload();
  await page.getByRole('button', { name: '我的時間', exact: true }).click();
  await page.getByLabel('睡眠日期', { exact: true }).fill('2026-11-02');
  assert.match(await page.locator('.sleep-list').innerText(), /8 小時/);
});

test('naps stay on the same date; an explicit date can record longer sleep', async t => {
  const page = await openPage(t);
  const dialog = await openSleep(page);
  await dialog.getByLabel('入睡時間', { exact: true }).fill('13:00');
  await dialog.getByLabel('起床時間', { exact: true }).fill('13:30');
  assert.equal(await dialog.getByLabel('起床日期', { exact: true }).inputValue(), '2026-11-01');
  assert.match(await dialog.locator('.sleep-duration').first().innerText(), /30 分鐘/);
  await dialog.getByLabel('起床日期', { exact: true }).fill('2026-11-02');
  await dialog.getByLabel('入睡時間', { exact: true }).fill('12:30');
  assert.equal(await dialog.getByLabel('起床日期', { exact: true }).inputValue(), '2026-11-02');
  await saveSleep(page);
  const [revision] = await sleepRevisions(page);
  assert.equal(revision.payload.actualEndMs - revision.payload.actualStartMs, 25 * 3600000);
});

test('ongoing sleep can omit wake time and rejects a second ongoing record', async t => {
  const page = await openPage(t);
  await openSleep(page, '2026-11-04');
  await page.getByLabel('入睡時間', { exact: true }).fill('11:00');
  await saveSleep(page);
  assert.equal((await sleepRevisions(page))[0].payload.actualEndMs, null);
  assert.ok(await page.getByRole('button', { name: '現在起床', exact: true }).isVisible());
  await openSleep(page, '2026-11-04');
  await page.getByLabel('入睡時間', { exact: true }).fill('11:30');
  await page.getByRole('button', { name: '儲存睡眠紀錄', exact: true }).click();
  assert.match(await page.getByRole('dialog').getByRole('alert').innerText(), /已有進行中的睡眠/);
  await page.getByRole('button', { name: '取消', exact: true }).click();
  await page.getByRole('button', { name: '現在起床', exact: true }).click();
  await page.getByRole('button', { name: '現在起床', exact: true }).waitFor({ state: 'hidden' });
  const revisions = await sleepRevisions(page);
  assert.ok(revisions.some(revision => revision.payload?.actualEndMs === Date.parse('2026-11-04T17:00:00Z')));
});

test('missing, future, and reversed dates produce readable validation messages', async t => {
  const page = await openPage(t);
  const dialog = await openSleep(page, '2026-11-04');
  const save = page.getByRole('button', { name: '儲存睡眠紀錄', exact: true });
  await save.click();
  assert.match(await dialog.getByRole('alert').innerText(), /請填寫入睡時間/);
  await dialog.getByLabel('入睡時間', { exact: true }).fill('23:00');
  await save.click();
  assert.match(await dialog.getByRole('alert').innerText(), /不能在未來/);
  await dialog.getByLabel('入睡日期', { exact: true }).fill('2026-11-01');
  await dialog.getByLabel('起床時間', { exact: true }).fill('07:00');
  await dialog.getByLabel('起床日期', { exact: true }).fill('2026-10-31');
  await save.click();
  assert.match(await dialog.getByRole('alert').innerText(), /起床時間必須晚於入睡時間/);
  assert.equal((await sleepRevisions(page)).length, 0);
});

test('DST choices appear only for repeated times and note edits preserve the recorded instant', async t => {
  const page = await openPage(t);
  const dialog = await openSleep(page);
  await dialog.getByLabel('入睡時間', { exact: true }).fill('01:30');
  const occurrence = dialog.getByLabel('入睡重複時刻', { exact: true });
  assert.ok(await occurrence.isVisible());
  await dialog.getByLabel('起床時間', { exact: true }).fill('02:30');
  await page.getByRole('button', { name: '儲存睡眠紀錄', exact: true }).click();
  assert.match(await dialog.getByRole('alert').innerText(), /這個時間出現兩次/);
  await occurrence.selectOption('later');
  assert.match(await dialog.locator('.sleep-duration').first().innerText(), /1 小時/);
  await saveSleep(page);
  const [saved] = await sleepRevisions(page);
  assert.equal(saved.payload.actualStartMs, Date.parse('2026-11-01T01:30:00-05:00'));
  // Simulate an older record made by the one-tap timer, which includes seconds.
  await page.evaluate(async revision => {
    revision.payload.actualStartMs += 37789;
    const database = (await indexedDB.databases()).find(item => item.name.includes('fixture'));
    const db = await new Promise(resolve => { const request = indexedDB.open(database.name); request.onsuccess = () => resolve(request.result); });
    await new Promise(resolve => { const transaction = db.transaction('revisions', 'readwrite'); transaction.objectStore('revisions').put(revision); transaction.oncomplete = resolve; });
    db.close();
  }, saved);
  await page.reload();
  await page.getByRole('button', { name: '我的時間', exact: true }).click();
  await page.getByLabel('睡眠日期', { exact: true }).fill('2026-11-01');
  await page.locator('.sleep-entry').getByRole('button', { name: '修改', exact: true }).click();
  assert.equal(await page.getByLabel('入睡重複時刻', { exact: true }).inputValue(), 'later');
  await page.locator('#sleep-note').fill('只修改備註');
  await saveSleep(page);
  const updated = (await sleepRevisions(page)).find(revision => revision.parentIds.includes(saved.revisionId));
  assert.equal(updated.payload.actualStartMs, saved.payload.actualStartMs + 37789);
  assert.equal(updated.payload.actualEndMs, saved.payload.actualEndMs);
  assert.equal(updated.payload.note, '只修改備註');
});

test('a nonexistent DST time is explained inline and cannot be saved', async t => {
  const page = await openPage(t);
  const dialog = await openSleep(page, '2026-03-08');
  await dialog.getByLabel('入睡時間', { exact: true }).fill('02:30');
  assert.equal(await dialog.getByLabel('入睡時間', { exact: true }).getAttribute('aria-invalid'), 'true');
  assert.match(await dialog.locator('.recording-time-error').innerText(), /不存在/);
  await page.getByRole('button', { name: '儲存睡眠紀錄', exact: true }).click();
  assert.equal((await sleepRevisions(page)).length, 0);
});

test('plans are saved separately and survive adding actual sleep', async t => {
  const page = await openPage(t);
  const dialog = await openSleep(page, '2026-11-01', true);
  assert.equal(await dialog.getByLabel('預計入睡時間', { exact: true }).inputValue(), '23:00');
  assert.match(await dialog.locator('.sleep-duration').first().innerText(), /8 小時/);
  await dialog.locator('summary').click();
  await dialog.getByLabel('入睡時間', { exact: true }).fill('23:30');
  await dialog.getByLabel('起床時間', { exact: true }).fill('07:15');
  await saveSleep(page, true);
  const [revision] = await sleepRevisions(page);
  await page.locator('.sleep-entry').getByRole('button', { name: '修改', exact: true }).click();
  await page.locator('#sleep-note').fill('修改備註，不改計畫');
  await saveSleep(page);
  const updated = (await sleepRevisions(page)).find(item => item.parentIds.includes(revision.revisionId));
  assert.equal(updated.payload.plannedStartMs, revision.payload.plannedStartMs);
  assert.equal(updated.payload.plannedEndMs, revision.payload.plannedEndMs);
  assert.equal(updated.payload.actualEndMs - updated.payload.actualStartMs, 7.75 * 3600000);
});

async function entityRevisions(page, type) {
  return page.evaluate(async type => {
    const scene = new URLSearchParams(location.search).get('scene');
    const database = (await indexedDB.databases()).find(item => item.name === `dicky-ontime-fixture:${scene}`);
    if (!database) return [];
    const db = await new Promise(resolve => { const request = indexedDB.open(database.name); request.onsuccess = () => resolve(request.result); });
    const revisions = await new Promise(resolve => { const request = db.transaction('revisions').objectStore('revisions').getAll(); request.onsuccess = () => resolve(request.result); });
    db.close(); return revisions.filter(item => item.entityType === type);
  }, type);
}

async function openBackfill(page, key, label, date = '2026-11-04') {
  await page.getByRole('button', { name: '今天', exact: true }).click();
  await page.getByRole('button', { name: '補登／修正紀錄', exact: true }).click();
  const dialog = page.getByRole('dialog');
  assert.equal(await dialog.locator('input[type=time]:visible').count(), 0);
  await dialog.getByLabel('要補哪個時間', { exact: true }).selectOption(key);
  await dialog.getByLabel(`補登${label}日期`, { exact: true }).fill(date);
  assert.equal(await dialog.locator('input[type=time]:visible').count(), 1);
  assert.equal(await dialog.locator('input[type=date]:visible').count(), 1);
  return dialog;
}

async function saveBackfill(page) {
  await page.getByRole('button', { name: '儲存這個時間', exact: true }).click();
  await page.getByRole('dialog').waitFor({ state: 'hidden' });
}

async function backfill(page, key, label, time, date) {
  const dialog = await openBackfill(page, key, label, date);
  await dialog.getByLabel(`補登${label}時間`, { exact: true }).fill(time);
  await saveBackfill(page);
}

test('single-event backfill saves all eight times into the same trip and attendance record', async t => {
  const page = await openPage(t);
  const events = [['leaveHomeMs', '出門', '07:00'], ['boardOutboundMs', '去程搭車', '07:10'],
    ['arriveDestinationMs', '抵達', '07:30'], ['startMs', '上班', '08:00'], ['endMs', '下班', '09:00'],
    ['leaveDestinationMs', '離開工作地點', '09:10'], ['boardReturnMs', '回程搭車', '09:15'], ['arriveHomeMs', '到家', '09:30']];
  for (const [key, label, time] of events) {
    const dialog = await openBackfill(page, key, label);
    assert.equal(await dialog.getByLabel('補登備註', { exact: true }).isVisible(), false);
    await dialog.getByLabel(`補登${label}時間`, { exact: true }).fill(time);
    await assertNoOverflow(page);
    await saveBackfill(page);
  }
  const journeys = await entityRevisions(page, 'journey'), sessions = await entityRevisions(page, 'session');
  assert.equal(new Set(journeys.map(item => item.entityId)).size, 1);
  assert.equal(new Set(sessions.map(item => item.entityId)).size, 1);
  const trip = journeys.find(item => item.payload.arriveHomeMs != null).payload;
  const session = sessions.find(item => item.payload.endMs != null).payload;
  for (const [key, , time] of events) assert.equal((key === 'startMs' || key === 'endMs' ? session : trip)[key], Date.parse(`2026-11-04T${time}:00-05:00`));
  await page.reload();
  await page.getByLabel('今天進度', { exact: true }).waitFor();
  assert.deepEqual(await page.locator('.route-time').allTextContents(), ['07:00', '07:10', '07:30', '08:00', '09:00', '09:15', '09:30']);
});

test('six pages and their editors fit narrow phones; sleep save stays visible', async t => {
  for (const viewport of [{ width: 320, height: 568 }, { width: 390, height: 844 }, { width: 430, height: 932 }]) {
    const page = await openPage(t, viewport);
    for (const name of ['今天', '班表', '用餐安排', '我的時間', '統計', '我的']) {
      await page.getByRole('button', { name, exact: true }).click();
      await assertNoOverflow(page);
    }
    await page.getByRole('button', { name: '我的時間', exact: true }).click();
    const dialog = await openSleep(page);
    await assertNoOverflow(page);
    const saveButton = page.getByRole('button', { name: '儲存睡眠紀錄', exact: true });
    const bounds = await saveButton.boundingBox();
    assert.ok(bounds.y >= 0 && bounds.y + bounds.height <= viewport.height, JSON.stringify(bounds));
    await dialog.locator('summary').click();
    await assertNoOverflow(page);
    const expandedBounds = await saveButton.boundingBox();
    const scroll = await dialog.locator('.modal-body').evaluate(element => { element.scrollTop = element.scrollHeight; return element.scrollTop; });
    assert.ok(scroll >= 0);
    const afterScroll = await saveButton.boundingBox();
    assert.equal(afterScroll.y, expandedBounds.y);
    assert.ok(afterScroll.y + afterScroll.height <= viewport.height);
    await page.getByRole('button', { name: '取消', exact: true }).click();
    for (const [tab, button] of [['班表', '新增班次'], ['班表', '新增工作'], ['班表', '範本'], ['班表', '批次建立'], ['用餐安排', '手動新增'], ['用餐安排', '用餐偏好']]) {
      await page.getByRole('button', { name: tab, exact: true }).click();
      await page.getByRole('button', { name: button, exact: true }).click();
      await page.getByRole('dialog').waitFor();
      await assertNoOverflow(page);
      await page.getByRole('dialog').getByLabel('關閉', { exact: true }).click();
    }
    await page.close();
  }
});

test('dialog traps keyboard focus, restores focus and scroll, and supports light mode', async t => {
  const page = await openPage(t);
  const originalOverflow = await page.evaluate(() => document.body.style.overflow);
  await openSleep(page);
  assert.equal(await page.evaluate(() => document.body.style.overflow), 'hidden');
  await page.keyboard.press('Shift+Tab');
  assert.equal(await page.evaluate(() => document.activeElement.textContent), '儲存睡眠紀錄');
  await page.keyboard.press('Tab');
  assert.equal(await page.evaluate(() => document.activeElement.getAttribute('aria-label')), '關閉');
  await page.keyboard.press('Escape');
  await page.getByRole('dialog').waitFor({ state: 'hidden' });
  assert.equal(await page.evaluate(() => document.body.style.overflow), originalOverflow);
  assert.match(await page.evaluate(() => document.activeElement.textContent), /記錄睡眠/);
  await page.getByRole('button', { name: '我的', exact: true }).click();
  await page.getByLabel('主題', { exact: true }).selectOption('light');
  await page.getByRole('button', { name: '儲存設定', exact: true }).click();
  await page.waitForFunction(() => document.documentElement.dataset.theme === 'light');
  await page.getByRole('button', { name: '我的時間', exact: true }).click();
  await openSleep(page);
  assert.equal(await page.evaluate(() => getComputedStyle(document.documentElement).colorScheme), 'light');
  await assertNoOverflow(page);
});

async function journeyRevisions(page) {
  return page.evaluate(async () => {
    const scene = new URLSearchParams(location.search).get('scene');
    const database = (await indexedDB.databases()).find(item => item.name === `dicky-ontime-fixture:${scene}`);
    const db = await new Promise(resolve => { const request = indexedDB.open(database.name); request.onsuccess = () => resolve(request.result); });
    const revisions = await new Promise(resolve => { const request = db.transaction('revisions').objectStore('revisions').getAll(); request.onsuccess = () => resolve(request.result); });
    db.close();
    return revisions.filter(item => item.entityType === 'journey');
  });
}

async function clickAt(page, name, time) {
  const timestamp = Date.parse(`2026-11-04T${time}:00-05:00`);
  await page.evaluate(now => { Date.now = () => now; }, timestamp);
  await page.getByRole('button', { name, exact: true }).click();
  await page.getByRole('button', { name: '補登／修正紀錄', exact: true }).waitFor();
}

test('transit: the complete commute records both rides and all seven progress times', async t => {
  const page = await openPage(t);
  await page.getByRole('button', { name: '今天', exact: true }).click();
  await clickAt(page, '出門了', '08:00');
  await page.getByRole('button', { name: '搭車了（去程）', exact: true }).waitFor();
  await clickAt(page, '搭車了（去程）', '08:10');
  await page.getByRole('button', { name: '搭車了（去程）', exact: true }).waitFor({ state: 'hidden' });
  assert.match(await page.locator('.pill').innerText(), /搭車中/);
  assert.equal(await page.locator('.hero-caption').innerText(), '你的當地時間');
  await clickAt(page, '到了！', '08:30');
  await page.getByRole('button', { name: '到了！', exact: true }).waitFor({ state: 'hidden' });
  await clickAt(page, '開始上班', '09:00');
  const dialog = page.getByRole('dialog');
  await dialog.getByRole('button', { name: '開始上班', exact: true }).click();
  await dialog.waitFor({ state: 'hidden' });
  await clickAt(page, '收工啦', '17:00');
  await page.getByRole('button', { name: '收工啦', exact: true }).waitFor({ state: 'hidden' });
  await clickAt(page, '搭車了（回程）', '17:10');
  await page.getByRole('button', { name: '搭車了（回程）', exact: true }).waitFor({ state: 'hidden' });
  assert.match(await page.locator('.pill').innerText(), /搭車回家中/);
  const worksite = await page.getByRole('button', { name: /^工作地點停留 / }).getAttribute('title');
  assert.match(worksite, /08:30.*17:10/);
  await clickAt(page, '到家了', '18:00');
  await page.getByRole('button', { name: '到家了', exact: true }).waitFor({ state: 'hidden' });
  assert.deepEqual(await page.locator('.route-label').allTextContents(), ['出門', '搭車（去程）', '抵達', '上班', '下班', '搭車（回程）', '到家']);
  assert.deepEqual(await page.locator('.route-time').allTextContents(), ['08:00', '08:10', '08:30', '09:00', '17:00', '17:10', '18:00']);
  const revisions = await journeyRevisions(page);
  const current = revisions.find(revision => revision.payload.arriveHomeMs !== null);
  assert.equal(current.payload.boardOutboundMs, Date.parse('2026-11-04T08:10:00-05:00'));
  assert.equal(current.payload.boardReturnMs, Date.parse('2026-11-04T17:10:00-05:00'));
  assert.equal(current.payload.leaveDestinationMs, null, 'boarding must not invent an earlier departure time');
  assert.match(await page.locator('.shift-chips').innerText(), /回程搭車\s*50 分鐘/);
  await page.reload();
  await page.getByLabel('今天進度', { exact: true }).waitFor();
  assert.deepEqual(await page.locator('.route-time').allTextContents(), ['08:00', '08:10', '08:30', '09:00', '17:00', '17:10', '18:00']);
});

test('transit: walking can skip boarding and keep unrecorded ride times blank', async t => {
  const page = await openPage(t);
  await page.getByRole('button', { name: '今天', exact: true }).click();
  await clickAt(page, '出門了', '08:00');
  await page.getByRole('button', { name: '到了！', exact: true }).waitFor();
  await clickAt(page, '到了！', '08:30');
  await page.getByRole('button', { name: '離開工作地點', exact: true }).waitFor();
  await clickAt(page, '離開工作地點', '09:00');
  await page.getByRole('button', { name: '到家了', exact: true }).waitFor();
  await clickAt(page, '到家了', '09:30');
  await page.getByRole('button', { name: '到家了', exact: true }).waitFor({ state: 'hidden' });
  const current = (await journeyRevisions(page)).find(revision => revision.payload.arriveHomeMs !== null);
  assert.equal(current.payload.boardOutboundMs, null);
  assert.equal(current.payload.boardReturnMs, null);
  assert.equal(await page.locator('.route-node.done').count(), 3);
  assert.equal((await page.locator('.route-time').allTextContents())[1], '—');
});

test('transit: legacy journeys can record a return ride without rewriting earlier versions', async t => {
  const page = await openPage(t);
  await page.goto(`${origin}/?fixture=1&scene=returning`);
  await page.getByRole('button', { name: '搭車了（回程）', exact: true }).waitFor();
  const [legacy] = await journeyRevisions(page);
  assert.equal(legacy.payload.boardOutboundMs, undefined);
  await clickAt(page, '搭車了（回程）', '17:30');
  await page.getByRole('button', { name: '搭車了（回程）', exact: true }).waitFor({ state: 'hidden' });
  const revisions = await journeyRevisions(page);
  assert.deepEqual(revisions.find(revision => revision.revisionId === legacy.revisionId), legacy);
  const current = revisions.find(revision => revision.parentIds.includes(legacy.revisionId));
  assert.equal(current.payload.leaveDestinationMs, legacy.payload.leaveDestinationMs);
  assert.equal(current.payload.boardReturnMs, Date.parse('2026-11-04T17:30:00-05:00'));
  await clickAt(page, '到家了', '18:00');
  await page.getByRole('button', { name: '到家了', exact: true }).waitFor({ state: 'hidden' });
});

test('transit: single-event corrections validate boarding order and export both boarding times', async t => {
  const page = await openPage(t);
  await backfill(page, 'leaveHomeMs', '出門', '08:00');
  const dialog = await openBackfill(page, 'boardOutboundMs', '去程搭車');
  await dialog.getByLabel('補登去程搭車時間', { exact: true }).fill('07:55');
  await page.getByRole('button', { name: '儲存這個時間', exact: true }).click();
  assert.match(await dialog.getByRole('alert').innerText(), /去程搭車時間不可早於出門時間/);
  assert.equal((await journeyRevisions(page)).length, 1);
  await dialog.getByLabel('補登去程搭車時間', { exact: true }).fill('08:10');
  await saveBackfill(page);
  await backfill(page, 'arriveDestinationMs', '抵達', '08:30');
  await backfill(page, 'boardReturnMs', '回程搭車', '17:15');
  await backfill(page, 'arriveHomeMs', '到家', '18:00');
  await page.getByRole('button', { name: '我的', exact: true }).click();
  const downloadPromise = page.waitForEvent('download');
  await page.getByRole('button', { name: /匯出出行 CSV/ }).click();
  const stream = await (await downloadPromise).createReadStream();
  const chunks = [];
  for await (const chunk of stream) chunks.push(chunk);
  const [header, row] = Buffer.concat(chunks).toString().trim().split('\r\n');
  const columns = header.split(','), values = row.split(',');
  assert.equal(values[columns.indexOf('boardOutboundMs')], String(Date.parse('2026-11-04T08:10:00-05:00')));
  assert.equal(values[columns.indexOf('boardReturnMs')], String(Date.parse('2026-11-04T17:15:00-05:00')));
});

test('transit: seven steps and both boarding controls fit phones and desktop', async t => {
  for (const viewport of [{ width: 320, height: 568 }, { width: 390, height: 844 }, { width: 430, height: 932 }, { width: 1280, height: 900 }]) {
    const page = await openPage(t, viewport);
    await page.getByRole('button', { name: '今天', exact: true }).click();
    await clickAt(page, '出門了', '08:00');
    await page.getByRole('button', { name: '搭車了（去程）', exact: true }).waitFor();
    await assertNoOverflow(page);
    const route = await page.getByLabel('今天進度', { exact: true }).boundingBox();
    assert.ok(route.x >= 0 && route.x + route.width <= viewport.width);
    await page.getByRole('button', { name: '補登／修正紀錄', exact: true }).click();
    const dialog = page.getByRole('dialog');
    await dialog.getByLabel('要補哪個時間', { exact: true }).selectOption('boardOutboundMs');
    assert.ok(await dialog.getByLabel('補登去程搭車時間', { exact: true }).isVisible());
    assert.equal(await dialog.getByLabel('補登回程搭車時間', { exact: true }).count(), 0);
    await assertNoOverflow(page);
    await dialog.getByLabel('要補哪個時間', { exact: true }).selectOption('boardReturnMs');
    assert.ok(await dialog.getByLabel('補登回程搭車時間', { exact: true }).isVisible());
    assert.equal(await dialog.getByLabel('補登去程搭車時間', { exact: true }).count(), 0);
    const save = await dialog.getByRole('button', { name: '儲存這個時間', exact: true }).boundingBox();
    assert.ok(save.y >= 0 && save.y + save.height <= viewport.height);
    await assertNoOverflow(page);
    await page.close();
  }
});

test('design: every page fits narrow phones and desktop in dark and light themes', async t => {
  const tabs = ['今天', '班表', '用餐安排', '我的時間', '統計', '我的'];
  for (const viewport of [{ width: 320, height: 568 }, { width: 390, height: 844 }, { width: 430, height: 932 }, { width: 1280, height: 900 }]) {
    const page = await openPage(t, viewport);
    const assetFailures = [];
    page.on('response', response => { if (response.url().includes('/assets/') && !response.ok()) assetFailures.push(response.url()); });
    for (const theme of ['dark', 'light']) {
      if (theme === 'light') {
        await page.getByRole('button', { name: '我的', exact: true }).click();
        await page.getByLabel('主題', { exact: true }).selectOption('light');
        await page.getByRole('button', { name: '儲存設定', exact: true }).click();
        await page.waitForFunction(() => document.documentElement.dataset.theme === 'light');
      }
      for (const tab of tabs) {
        await page.getByRole('button', { name: tab, exact: true }).click();
        await page.evaluate(() => document.fonts.ready);
        await assertNoOverflow(page);
        const typography = await page.evaluate(() => ({
          family: getComputedStyle(document.body).fontFamily,
          chinese: document.fonts.check('500 15px "Noto Sans TC"', '班表睡眠搭車'),
          latin: document.fonts.check('600 24px "Inter"', 'ONTIME 09:30'),
          failed: [...document.fonts].filter(font => font.status === 'error').length
        }));
        assert.match(typography.family, /Inter.*Noto Sans TC/);
        assert.ok(typography.chinese && typography.latin, JSON.stringify(typography));
        assert.equal(typography.failed, 0);
      }
    }
    assert.deepEqual(assetFailures, []);
    await page.close();
  }
});

test('design: schedule views and the month chart remain usable on a small phone', async t => {
  const page = await openPage(t, { width: 320, height: 568 });
  await page.getByRole('button', { name: '班表', exact: true }).click();
  for (const view of ['月曆', '週時間軸', '清單']) {
    await page.getByRole('button', { name: view, exact: true }).click();
    await assertNoOverflow(page);
  }
  await page.getByRole('button', { name: '統計', exact: true }).click();
  await page.getByRole('button', { name: '本月', exact: true }).click();
  await assertNoOverflow(page);
  const chart = await page.locator('.stats-chart').evaluate(element => ({
    client: element.clientWidth, scroll: element.scrollWidth,
    rowPositions: [...element.children].map(day => day.getBoundingClientRect().bottom)
  }));
  assert.ok(chart.scroll > chart.client, 'month chart should scroll within its card');
  assert.ok(chart.rowPositions.every(bottom => Math.abs(bottom - chart.rowPositions[0]) < 1), 'days must stay in one horizontal row');
});

test('design: accent choices affect controls and text keeps readable contrast in both themes', async t => {
  const page = await openPage(t);
  await page.getByRole('button', { name: '我的', exact: true }).click();
  const backgrounds = new Set();
  for (const theme of ['dark', 'light']) {
    for (const accent of ['lime', 'ice', 'amber']) {
      await page.getByLabel('主題', { exact: true }).selectOption(theme);
      await page.getByLabel('主色', { exact: true }).selectOption(accent);
      const save = page.getByRole('button', { name: '儲存設定', exact: true });
      if (await save.count()) await save.click();
      await page.waitForFunction(({ theme, accent }) => document.documentElement.dataset.theme === theme && document.documentElement.dataset.accent === accent, { theme, accent });
      const colors = await page.evaluate(() => {
        const style = getComputedStyle(document.documentElement);
        const luminance = token => {
          const value = style.getPropertyValue(token).trim().slice(1);
          const rgb = [0, 2, 4].map(offset => parseInt(value.slice(offset, offset + 2), 16) / 255)
            .map(channel => channel <= .04045 ? channel / 12.92 : ((channel + .055) / 1.055) ** 2.4);
          return rgb[0] * .2126 + rgb[1] * .7152 + rgb[2] * .0722;
        };
        const panel = luminance('--panel');
        return { sun: style.getPropertyValue('--sun').trim(), contrast: ['--text', '--dim', '--faint', '--accent-ink'].map(token => {
          const foreground = luminance(token);
          return (Math.max(foreground, panel) + .05) / (Math.min(foreground, panel) + .05);
        }) };
      });
      backgrounds.add(colors.sun);
      assert.ok(colors.contrast.every(ratio => ratio >= 4.5), JSON.stringify({ theme, accent, colors }));
    }
  }
  assert.equal(backgrounds.size, 3);
});

async function replaceRevision(page, revision) {
  await page.evaluate(async revision => {
    const scene = new URLSearchParams(location.search).get('scene');
    const db = await new Promise(resolve => { const request = indexedDB.open(`dicky-ontime-fixture:${scene}`); request.onsuccess = () => resolve(request.result); });
    await new Promise(resolve => { const transaction = db.transaction('revisions', 'readwrite'); transaction.objectStore('revisions').put(revision); transaction.oncomplete = resolve; });
    db.close();
  }, revision);
  await page.reload();
}

test('single-event clock-out preserves seconds, breaks, income, pay and note; missing clock-in is explicit', async t => {
  const page = await openPage(t);
  let dialog = await openBackfill(page, 'endMs', '下班');
  assert.ok(await dialog.getByRole('button', { name: '儲存這個時間', exact: true }).isDisabled());
  await dialog.getByRole('button', { name: '先補登上班', exact: true }).click();
  await dialog.getByLabel('補登上班時間', { exact: true }).fill('08:00');
  await saveBackfill(page);
  const [original] = await entityRevisions(page, 'session');
  original.payload.startMs += 37789;
  original.payload.breaks = [{ startMs: Date.parse('2026-11-04T08:20:00-05:00'), endMs: Date.parse('2026-11-04T08:30:00-05:00'), paid: true }];
  original.payload.actualIncomeCents = 2549;
  original.payload.paySnapshotCents = 1000;
  original.payload.note = '原來的備註';
  await replaceRevision(page, original);
  await backfill(page, 'endMs', '下班', '09:00');
  const revisions = await entityRevisions(page, 'session');
  assert.deepEqual(revisions.find(item => item.revisionId === original.revisionId), original);
  const updated = revisions.find(item => item.parentIds.includes(original.revisionId));
  for (const key of ['startMs', 'breaks', 'actualIncomeCents', 'paySnapshotCents', 'note', 'shiftId', 'createdAtMs']) assert.deepEqual(updated.payload[key], original.payload[key], key);
  assert.equal(updated.payload.endMs, Date.parse('2026-11-04T09:00:00-05:00'));
});

test('single-event backfill joins overnight trips and requires a choice for two trips on the same date', async t => {
  const page = await openPage(t);
  await backfill(page, 'leaveHomeMs', '出門', '23:00', '2026-11-03');
  await backfill(page, 'arriveDestinationMs', '抵達', '00:30', '2026-11-04');
  await backfill(page, 'arriveHomeMs', '到家', '03:00', '2026-11-04');
  assert.equal(new Set((await journeyRevisions(page)).map(item => item.entityId)).size, 1);
  let dialog = await openBackfill(page, 'leaveHomeMs', '出門');
  await dialog.getByText('更多選項（選填）', { exact: true }).click();
  await dialog.getByLabel('使用其他紀錄', { exact: true }).selectOption('new');
  await dialog.getByLabel('補登出門時間', { exact: true }).fill('07:00');
  await saveBackfill(page);
  const journeys = await journeyRevisions(page);
  const second = journeys.find(item => item.parentIds.length === 0 && item.payload.leaveHomeMs === Date.parse('2026-11-04T07:00:00-05:00'));
  dialog = await openBackfill(page, 'boardOutboundMs', '去程搭車');
  assert.ok(await dialog.getByLabel('選擇當天紀錄', { exact: true }).isVisible());
  assert.ok(await dialog.getByRole('button', { name: '儲存這個時間', exact: true }).isDisabled());
  await dialog.getByLabel('選擇當天紀錄', { exact: true }).selectOption(second.entityId);
  await dialog.getByLabel('補登去程搭車時間', { exact: true }).fill('07:15');
  await saveBackfill(page);
  const updated = (await journeyRevisions(page)).find(item => item.parentIds.includes(second.revisionId));
  assert.equal(updated.payload.boardOutboundMs, Date.parse('2026-11-04T07:15:00-05:00'));
  assert.equal(updated.payload.arriveDestinationMs, null);
});

test('meal preferences edit one meal at a time and keep hidden preferences and unsaved drafts', async t => {
  const page = await openPage(t);
  const settings = (await entityRevisions(page, 'settings'))[0];
  await page.getByRole('button', { name: '用餐安排', exact: true }).click();
  await page.getByRole('button', { name: '用餐偏好', exact: true }).click();
  let dialog = page.getByRole('dialog');
  assert.equal(await dialog.locator('input[type=time]:visible').count(), 1);
  await dialog.getByLabel('偏好開始', { exact: true }).fill('08:15');
  await dialog.getByLabel('要設定哪一餐', { exact: true }).selectOption('lunch');
  await dialog.getByLabel('偏好開始', { exact: true }).fill('12:45');
  await dialog.getByLabel('要設定哪一餐', { exact: true }).selectOption('breakfast');
  assert.equal(await dialog.getByLabel('偏好開始', { exact: true }).inputValue(), '08:15');
  await dialog.getByLabel('安排早餐', { exact: true }).uncheck();
  assert.equal(await dialog.locator('input[type=time]:visible').count(), 0);
  await dialog.getByRole('button', { name: '儲存偏好', exact: true }).click();
  await dialog.waitFor({ state: 'hidden' });
  const updated = (await entityRevisions(page, 'settings')).find(item => item.parentIds.includes(settings.revisionId));
  const preferences = updated.payload.mealPreferences;
  assert.equal(preferences.find(item => item.kind === 'breakfast').preferredStart, '08:15');
  assert.equal(preferences.find(item => item.kind === 'breakfast').enabled, false);
  assert.equal(preferences.find(item => item.kind === 'lunch').preferredStart, '12:45');
  for (const kind of ['dinner', 'snack']) assert.deepEqual(preferences.find(item => item.kind === kind), settings.payload.mealPreferences.find(item => item.kind === kind));
});

test('irrelevant job settings are hidden and preserve saved rate and commute values', async t => {
  const page = await openPage(t), [original] = await entityRevisions(page, 'job');
  await page.getByRole('button', { name: '班表', exact: true }).click();
  await page.getByRole('button', { name: '工作設定', exact: true }).click();
  const dialog = page.getByRole('dialog');
  await dialog.getByLabel('計薪方式', { exact: true }).selectOption('none');
  assert.equal(await dialog.getByLabel('時薪（CAD）', { exact: true }).count(), 0);
  await dialog.getByText('通勤設定', { exact: true }).click();
  await dialog.getByLabel('這份工作不需要通勤', { exact: true }).check();
  assert.equal(await dialog.getByLabel('去程分鐘', { exact: true }).count(), 0);
  await dialog.getByRole('button', { name: '儲存工作', exact: true }).click();
  const updated = (await entityRevisions(page, 'job')).find(item => item.parentIds.includes(original.revisionId));
  for (const key of ['hourlyRateCents', 'commuteOutMinutes', 'commuteBackMinutes', 'arriveEarlyMinutes', 'color', 'location']) assert.equal(updated.payload[key], original.payload[key], key);
  assert.equal(updated.payload.payMode, 'none'); assert.equal(updated.payload.noCommute, true);
  await dialog.waitFor({ state: 'hidden' });
  assert.match(await page.getByText(/不計薪.*不需通勤/).innerText(), /不計薪/);
});

test('a new shift has no invented lunch break and editing keeps all hidden historical settings', async t => {
  const page = await openPage(t);
  await page.getByRole('button', { name: '班表', exact: true }).click();
  await page.getByRole('button', { name: '新增班次', exact: true }).click();
  const dialog = page.getByRole('dialog');
  assert.equal(await dialog.getByLabel('休息開始', { exact: true }).isVisible(), false);
  await dialog.getByLabel('日期', { exact: true }).fill('2026-11-05');
  await dialog.getByRole('button', { name: '儲存班次', exact: true }).click();
  await dialog.waitFor({ state: 'hidden' });
  const revisions = await entityRevisions(page, 'shift');
  const created = revisions.find(item => item.payload.startMs === Date.parse('2026-11-05T09:00:00-05:00'));
  assert.deepEqual(created.payload.plannedBreaks, []);
  created.payload.startMs += 3789;
  created.payload.note = '舊班次備註'; created.payload.paySnapshotCents = 900;
  created.payload.plannedBreaks = [{ startMs: Date.parse('2026-11-05T12:00:00-05:00'), endMs: Date.parse('2026-11-05T12:30:00-05:00'), paid: true },
    { startMs: Date.parse('2026-11-05T14:00:00-05:00'), endMs: Date.parse('2026-11-05T14:10:00-05:00'), paid: false }];
  await replaceRevision(page, created);
  await page.getByRole('button', { name: '班表', exact: true }).click();
  await page.locator('.schedule-week-strip .day-pill').filter({ has: page.locator('.day-pill-date', { hasText: '05' }) }).click();
  await page.getByRole('button', { name: '清單', exact: true }).click();
  const item = page.locator('tbody tr').filter({ hasText: '2026-11-05' });
  await item.getByRole('button', { name: '編輯', exact: true }).click();
  await page.getByRole('dialog').getByLabel('結束', { exact: true }).fill('17:30');
  await page.getByRole('dialog').getByRole('button', { name: '儲存班次', exact: true }).click();
  await page.getByRole('dialog').waitFor({ state: 'hidden' });
  const updated = (await entityRevisions(page, 'shift')).find(item => item.parentIds.includes(created.revisionId));
  for (const key of ['startMs', 'plannedBreaks', 'paySnapshotCents', 'commuteSnapshot', 'location', 'note', 'batchId', 'createdAtMs']) assert.deepEqual(updated.payload[key], created.payload[key], key);
});

test('manual meals reveal optional notes on request and save overnight dates correctly', async t => {
  const page = await openPage(t);
  await page.getByRole('button', { name: '用餐安排', exact: true }).click();
  await page.getByRole('button', { name: '手動新增', exact: true }).click();
  const dialog = page.getByRole('dialog');
  assert.equal(await dialog.getByLabel('吃什麼', { exact: true }).isVisible(), false);
  await dialog.getByLabel('用餐開始日期', { exact: true }).fill('2026-11-02');
  await dialog.getByLabel('用餐開始時間', { exact: true }).fill('23:50');
  await dialog.getByLabel('用餐結束時間', { exact: true }).fill('00:15');
  assert.equal(await dialog.getByLabel('用餐結束日期', { exact: true }).inputValue(), '2026-11-03');
  await dialog.getByText('餐點、地點與備註（選填）', { exact: true }).click();
  await dialog.getByLabel('吃什麼', { exact: true }).fill('夜宵');
  await dialog.getByLabel('備註', { exact: true }).fill('補登這餐');
  await dialog.getByRole('button', { name: '確認並加入時間軸', exact: true }).click();
  await dialog.waitFor({ state: 'hidden' });
  const [meal] = await entityRevisions(page, 'meal');
  assert.equal(meal.payload.endMs - meal.payload.startMs, 25 * 60000);
  assert.equal(meal.payload.food, '夜宵'); assert.equal(meal.payload.note, '補登這餐');
});

test('single-event correction of a legacy trip preserves links, notes and prior revisions', async t => {
  const page = await openPage(t);
  await page.goto(`${origin}/?fixture=1&scene=returning`);
  await page.getByRole('button', { name: '補登／修正紀錄', exact: true }).waitFor();
  const [legacy] = await journeyRevisions(page);
  await backfill(page, 'boardReturnMs', '回程搭車', '17:30');
  const revisions = await journeyRevisions(page);
  assert.deepEqual(revisions.find(item => item.revisionId === legacy.revisionId), legacy);
  const updated = revisions.find(item => item.parentIds.includes(legacy.revisionId));
  for (const key of ['leaveHomeMs', 'boardOutboundMs', 'arriveDestinationMs', 'leaveDestinationMs', 'arriveHomeMs', 'jobId', 'shiftIds', 'sessionIds', 'origin', 'destination', 'note']) assert.deepEqual(updated.payload[key], legacy.payload[key], key);
  assert.equal(updated.payload.boardReturnMs, Date.parse('2026-11-04T17:30:00-05:00'));
});

test('meals during work and outside the preferred window save without changing attendance or pay', async t => {
  const page = await openPage(t);
  await page.goto(`${origin}/?fixture=1&scene=working`);
  await waitForValue(async () => (await entityRevisions(page, 'session')).length, 1);
  await page.getByRole('button', { name: '用餐安排', exact: true }).click();
  const before = await entityRevisions(page, 'session');
  await page.getByRole('button', { name: '手動新增', exact: true }).click();
  const dialog = page.getByRole('dialog');
  await dialog.getByLabel('餐別', { exact: true }).selectOption('lunch');
  await dialog.getByLabel('用餐開始時間', { exact: true }).fill('10:00');
  await dialog.getByLabel('用餐結束時間', { exact: true }).fill('10:20');
  assert.equal(await dialog.getByLabel('接受這餐超出偏好時段', { exact: true }).count(), 0);
  await dialog.getByText('餐點、地點與備註（選填）', { exact: true }).click();
  await dialog.getByLabel('吃什麼', { exact: true }).fill('上班午餐');
  await dialog.getByLabel('地點', { exact: true }).fill('工作地點');
  await dialog.getByRole('button', { name: '確認並加入時間軸', exact: true }).click();
  await dialog.waitFor({ state: 'hidden' });
  const [saved] = (await entityRevisions(page, 'meal')).filter(item => item.payload.food === '上班午餐');
  assert.equal(saved.payload.kind, 'lunch');
  assert.equal(saved.payload.outsidePreferenceAccepted, true);
  assert.deepEqual(await entityRevisions(page, 'session'), before);
  assert.equal(await page.getByText(/班表／通勤變更影響到這餐/).count(), 0);
  const budget = await page.evaluate(async () => {
    const repo = new __ontimeTest.Repository('fixture:working', { localOnly: true });
    const { data } = await repo.loadAppData();
    const meal = data.meals.find(item => item.food === '上班午餐');
    const withMeal = __ontimeTest.budget(data, '2026-11-04', { nowMs: Date.now() });
    const withoutMeal = __ontimeTest.budget({ ...data, meals: data.meals.filter(item => item.id !== meal.id) }, '2026-11-04', { nowMs: Date.now() });
    await repo.close(); return { withMeal, withoutMeal };
  });
  assert.equal(budget.withMeal.workOccupiedMs, budget.withoutMeal.workOccupiedMs);
  assert.equal(budget.withMeal.unplannedMs, budget.withoutMeal.unplannedMs, 'eating during work must not subtract that time twice');
});

test('template forms keep optional breaks collapsed and store overnight schedules without inventing lunch', async t => {
  const page = await openPage(t);
  await page.getByRole('button', { name: '班表', exact: true }).click();
  await page.getByRole('button', { name: '範本', exact: true }).click();
  const dialog = page.getByRole('dialog');
  await dialog.getByRole('button', { name: '新增範本', exact: true }).click();
  assert.equal(await dialog.getByLabel('休息開始', { exact: true }).isVisible(), false);
  await dialog.getByLabel('範本名稱（選填）', { exact: true }).fill('夜班');
  await dialog.getByLabel('開始', { exact: true }).fill('23:00');
  await dialog.getByLabel('結束', { exact: true }).fill('07:00');
  await assertNoOverflow(page);
  await dialog.getByRole('button', { name: '建立範本', exact: true }).click();
  await dialog.getByText('夜班', { exact: true }).waitFor();
  const [template] = await entityRevisions(page, 'template');
  assert.equal(template.payload.endDayOffset, 1);
  assert.deepEqual(template.payload.breaks, []);
});

test('single-event date edits retain the time already entered and persist it on the chosen date', async t => {
  const page = await openPage(t);
  const dialog = await openBackfill(page, 'leaveHomeMs', '出門');
  await dialog.getByLabel('補登出門時間', { exact: true }).fill('08:00');
  await dialog.getByLabel('補登出門日期', { exact: true }).fill('2026-11-03');
  assert.equal(await dialog.getByLabel('補登出門時間', { exact: true }).inputValue(), '08:00');
  await saveBackfill(page);
  const [trip] = await journeyRevisions(page);
  assert.equal(trip.payload.leaveHomeMs, Date.parse('2026-11-03T08:00:00-05:00'));
});

async function openManualMeal(page, start, end, kind = 'snack') {
  await page.getByRole('button', { name: '用餐安排', exact: true }).click();
  await page.getByRole('button', { name: '手動新增', exact: true }).click();
  const dialog = page.getByRole('dialog');
  await dialog.getByLabel('餐別', { exact: true }).selectOption(kind);
  await dialog.getByLabel('用餐開始時間', { exact: true }).fill(start);
  await dialog.getByLabel('用餐結束時間', { exact: true }).fill(end);
  return dialog;
}
async function saveMeal(page) {
  await page.getByRole('dialog').getByRole('button', { name: '確認並加入時間軸', exact: true }).click();
  await page.getByRole('dialog').waitFor({ state: 'hidden' });
}

test('meals in actual transit save and editing them keeps food and notes', async t => {
  const page = await openPage(t);
  await page.getByRole('button', { name: '今天', exact: true }).click();
  await clickAt(page, '出門了', '08:00');
  await page.getByRole('button', { name: '到了！', exact: true }).waitFor();
  await clickAt(page, '到了！', '08:30');
  await page.getByRole('button', { name: '到了！', exact: true }).waitFor({ state: 'hidden' });
  const originalTrip = await journeyRevisions(page);
  const dialog = await openManualMeal(page, '08:10', '08:20', 'breakfast');
  await dialog.getByText('餐點、地點與備註（選填）', { exact: true }).click();
  await dialog.getByLabel('吃什麼', { exact: true }).fill('搭車早餐');
  await dialog.getByLabel('備註', { exact: true }).fill('在車上吃');
  await saveMeal(page);
  const [meal] = await entityRevisions(page, 'meal');
  await page.getByText('搭車早餐', { exact: true }).waitFor();
  await page.getByRole('button', { name: '編輯', exact: true }).click();
  await page.getByRole('dialog').getByLabel('用餐結束時間', { exact: true }).fill('08:25');
  await page.getByRole('dialog').getByRole('button', { name: '儲存變更', exact: true }).click();
  await page.getByRole('dialog').waitFor({ state: 'hidden' });
  const updated = (await entityRevisions(page, 'meal')).find(item => item.parentIds.includes(meal.revisionId));
  assert.equal(updated.payload.food, '搭車早餐'); assert.equal(updated.payload.note, '在車上吃');
  assert.deepEqual(await journeyRevisions(page), originalTrip);
});

test('meal suggestions include lunch during a shift and both individual and bulk confirmation work', async t => {
  const page = await openPage(t);
  await page.getByRole('button', { name: '用餐安排', exact: true }).click();
  await page.getByRole('button', { name: '產生建議', exact: true }).first().click();
  const draftCard = page.locator('.card').filter({ has: page.getByRole('heading', { name: '建議草稿', exact: true }) });
  const lunch = draftCard.locator('.list-item').filter({ hasText: '午餐' });
  await lunch.waitFor();
  assert.match(await lunch.innerText(), /12:00/);
  await lunch.locator('.row-actions .button.primary').click();
  await lunch.waitFor({ state: 'hidden' });
  assert.ok((await entityRevisions(page, 'meal')).some(item => item.payload.kind === 'lunch'));
  await draftCard.getByRole('button', { name: '確認可行全部', exact: true }).click();
  await draftCard.getByText('等待安排', { exact: true }).waitFor();
  assert.ok((await entityRevisions(page, 'meal')).some(item => item.payload.kind === 'dinner'));
});

test('meal suggestions prefer a real break without subtracting another job from the work interval', async t => {
  const page = await openPage(t);
  const result = await page.evaluate(() => {
    const at = time => Date.parse(`2026-11-04T${time}:00-05:00`);
    const input = { date: '2026-11-04', timeZone: 'America/Toronto', nowMs: at('11:00'),
      preferences: [{ kind: 'lunch', enabled: true, windowStart: '12:00', windowEnd: '14:00', preferredStart: '12:00', durationMinutes: 30 }],
      workingIntervals: [{ startMs: at('09:00'), endMs: at('12:30') }, { startMs: at('13:00'), endMs: at('17:00') }],
      restIntervals: [{ startMs: at('12:30'), endMs: at('13:00') }], commuteIntervals: [], worksiteStayIntervals: [], confirmedMeals: [] };
    const withBreak = __ontimeTest.suggestMeals(input).suggestions[0];
    const secondJob = __ontimeTest.suggestMeals({ ...input, workingIntervals: [{ startMs: at('09:00'), endMs: at('17:00') }] }).suggestions[0];
    return { withBreak, secondJob, expectedBreak: at('12:30'), expectedPreferred: at('12:00') };
  });
  assert.equal(result.withBreak.startMs, result.expectedBreak);
  assert.equal(result.secondJob.startMs, result.expectedPreferred);
  assert.equal(result.secondJob.reason, '上班期間用餐');
});

test('duplicate meals and invalid duration still show a readable error', async t => {
  const page = await openPage(t);
  await openManualMeal(page, '13:00', '13:20'); await saveMeal(page);
  const dialog = await openManualMeal(page, '13:10', '13:30');
  const save = dialog.getByRole('button', { name: '確認並加入時間軸', exact: true });
  await save.click(); assert.match(await dialog.getByRole('alert').innerText(), /與其他餐次重疊/);
  await dialog.getByLabel('用餐開始時間', { exact: true }).fill('14:00');
  await dialog.getByLabel('用餐結束日期', { exact: true }).fill('2026-11-04');
  await dialog.getByLabel('用餐結束時間', { exact: true }).fill('13:50');
  await save.click(); assert.match(await dialog.getByRole('alert').innerText(), /結束必須晚於/);
  assert.equal((await entityRevisions(page, 'meal')).length, 1);
});

async function openSyncPage(t) {
  const uid = `regression-${randomUUID()}`;
  const context = await browser.newContext({ viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true, locale: 'zh-TW' });
  t.after(() => context.close());
  const page = await context.newPage(), errors = [];
  page.on('pageerror', error => errors.push(error.message));
  t.after(() => assert.deepEqual(errors, []));
  await page.goto(`${origin}/?sync_test=${uid}`);
  await waitForValue(() => page.evaluate(async uid => (await indexedDB.databases()).some(database => database.name === `dicky-ontime-${uid}`), uid), true);
  await page.getByRole('button', { name: '班表', exact: true }).click();
  await page.getByRole('button', { name: '新增工作', exact: true }).click();
  await page.getByRole('dialog').getByLabel('工作名稱', { exact: true }).fill('離線測試工作');
  await page.getByRole('dialog').getByRole('button', { name: '儲存工作', exact: true }).click();
  await page.getByRole('dialog').waitFor({ state: 'hidden' });
  await waitForPending(page, uid, 0);
  await page.waitForFunction(() => Boolean(navigator.serviceWorker.controller));
  return { page, uid };
}
async function pendingSnapshot(page, uid) {
  return page.evaluate(async uid => {
    const repository = new __ontimeTest.Repository(uid);
    const result = { pending: await repository.getAllOutbox(), data: (await repository.loadAppData()).data, revisions: await repository.getAllRevisions() };
    await repository.close(); return result;
  }, uid);
}
async function waitForValue(read, expected, timeoutMs = 15000) {
  const deadline = Date.now() + timeoutMs;
  while (true) {
    const value = await read();
    if (value === expected) return;
    assert.ok(Date.now() < deadline, `Timed out waiting for ${expected}; last value: ${value}`);
    await new Promise(resolve => setTimeout(resolve, 50));
  }
}
async function waitForPending(page, uid, count) {
  await waitForValue(async () => (await pendingSnapshot(page, uid)).pending.length, count);
}

// Playwright's Linux WebKit offline switch rejects navigations before service workers.
// For that engine, interrupt HTTP service and block external requests instead; Chromium
// exercises the actual browser offline switch, including service-worker fetch failures.
function installDisconnectControls() {
  const disconnected = () => sessionStorage.getItem('ontime-test-disconnected') === '1';
  Object.defineProperty(navigator, 'onLine', { configurable: true, get: () => !disconnected() });
  const originalFetch = window.fetch.bind(window);
  window.fetch = (input, options) => {
    const url = new URL(input instanceof Request ? input.url : input, location.href);
    if (disconnected() && url.origin !== location.origin) return Promise.reject(new TypeError('Test network unavailable'));
    return originalFetch(input, options);
  };
}
async function setDisconnected(page, uid, disconnected) {
  if (engine !== 'webkit') { await page.context().setOffline(disconnected); return; }
  if (disconnected) {
    harness.disconnected.add(uid);
    page.context().once('close', () => harness.disconnected.delete(uid));
    await page.context().route('**/*', route => new URL(route.request().url()).origin === origin ? route.continue() : route.abort());
    await page.context().addInitScript(installDisconnectControls);
    await page.evaluate(installDisconnectControls);
  } else { harness.disconnected.delete(uid); await page.context().unrouteAll({ behavior: 'wait' }); }
  await page.evaluate(value => {
    sessionStorage.setItem('ontime-test-disconnected', value ? '1' : '0');
    window.dispatchEvent(new Event(value ? 'offline' : 'online'));
  }, disconnected);
}

test('offline saves survive reopening and upload automatically on reconnect without duplicate cloud revisions', async t => {
  const { page, uid } = await openSyncPage(t);
  assert.ok([...harness.cloud(uid).values()].some(item => item.entityType === 'job'));
  await setDisconnected(page, uid, true);
  await page.waitForFunction(() => !navigator.onLine);
  const dialog = await openManualMeal(page, '12:00', '12:20', 'lunch');
  await dialog.getByText('餐點、地點與備註（選填）', { exact: true }).click();
  await dialog.getByLabel('吃什麼', { exact: true }).fill('離線午餐');
  await dialog.getByLabel('備註', { exact: true }).fill('斷網時記錄');
  await saveMeal(page);
  await page.getByText('已存到手機，恢復網絡後會自動同步。', { exact: true }).waitFor();
  const stored = await pendingSnapshot(page, uid);
  assert.equal(stored.pending.length, 1);
  const saved = stored.pending[0];
  assert.equal(saved.payload.food, '離線午餐');
  assert.equal(harness.cloud(uid).has(saved.revisionId), false);
  await page.reload();
  await page.getByRole('button', { name: '用餐安排', exact: true }).click();
  await page.getByText('離線午餐', { exact: true }).waitFor();
  assert.equal((await pendingSnapshot(page, uid)).pending.length, 1);
  await setDisconnected(page, uid, false);
  await waitForPending(page, uid, 0);
  const cloudMeal = harness.cloud(uid).get(saved.revisionId);
  assert.equal(cloudMeal.payload.food, '離線午餐');
  assert.equal(cloudMeal.payload.note, '斷網時記錄');
  assert.equal([...harness.cloud(uid).values()].filter(item => item.entityType === 'meal').length, 1);
  await page.evaluate(() => window.dispatchEvent(new Event('online')));
  await waitForPending(page, uid, 0);
  assert.equal([...harness.cloud(uid).values()].filter(item => item.entityType === 'meal').length, 1);
});

test('a failed cloud upload keeps the local revision and retries automatically', async t => {
  const { page, uid } = await openSyncPage(t);
  harness.failUploads.add(uid);
  await openManualMeal(page, '13:00', '13:20'); await saveMeal(page);
  await waitForValue(async () => (await pendingSnapshot(page, uid)).pending.some(item => item.attempts > 0), true);
  const pending = await pendingSnapshot(page, uid);
  assert.equal(pending.data.meals.length, 1);
  assert.equal(pending.pending.length, 1);
  const revision = pending.revisions.find(item => item.entityType === 'meal');
  await waitForPending(page, uid, 0);
  assert.deepEqual(harness.cloud(uid).get(revision.revisionId), revision);
  assert.equal([...harness.cloud(uid).values()].filter(item => item.entityType === 'meal').length, 1);
});

test('an app update waits while the user is editing a meal and does not discard the draft', async t => {
  const page = await openPage(t);
  await page.waitForFunction(() => Boolean(navigator.serviceWorker.controller));
  const dialog = await openManualMeal(page, '12:00', '12:20');
  await dialog.getByText('餐點、地點與備註（選填）', { exact: true }).click();
  await dialog.getByLabel('吃什麼', { exact: true }).fill('尚未儲存的午餐');
  harness.setWorkerVariant('update-test'); t.after(() => harness.setWorkerVariant('v1'));
  await page.evaluate(async () => { const worker = await navigator.serviceWorker.getRegistration(); await worker.update(); });
  const update = page.getByRole('button', { name: /編輯完成後更新/ });
  await update.waitFor(); assert.ok(await update.isDisabled());
  assert.equal(await dialog.getByLabel('吃什麼', { exact: true }).inputValue(), '尚未儲存的午餐');
  await page.getByRole('button', { name: '取消', exact: true }).click();
  assert.ok(await page.getByRole('button', { name: '更新', exact: true }).isEnabled());
});

test('the real Firebase auth client restores a cached login while fully offline and can save locally', async t => {
  const page = await openPage(t), uid = `cached-auth-${randomUUID()}`;
  await page.waitForFunction(() => Boolean(navigator.serviceWorker.controller));
  await page.evaluate(async uid => {
    const fixture = new __ontimeTest.Repository('fixture:planning', { localOnly: true });
    const { data } = await fixture.loadAppData(); await fixture.close();
    const repository = new __ontimeTest.Repository(uid);
    await repository.saveEntityRevision({ entityType: 'job', entityId: data.jobs[0].id, payload: { ...data.jobs[0], name: 'cached-work' }, baseParentIds: [] });
    await repository.close();
    const db = await new Promise((resolve, reject) => {
      const request = indexedDB.open('firebaseLocalStorageDb', 1);
      request.onupgradeneeded = () => request.result.createObjectStore('firebaseLocalStorage', { keyPath: 'fbase_key' });
      request.onsuccess = () => resolve(request.result); request.onerror = () => reject(request.error);
    });
    await new Promise((resolve, reject) => {
      const transaction = db.transaction('firebaseLocalStorage', 'readwrite');
      transaction.objectStore('firebaseLocalStorage').put({ fbase_key: __ontimeTest.authPersistenceKey(), value: {
        uid, email: 'offline@example.test', emailVerified: true, displayName: 'Cached Offline Regression', isAnonymous: false,
        providerData: [], stsTokenManager: { refreshToken: 'regression-only', accessToken: 'regression-only', expirationTime: Date.now() + 3600000 },
        apiKey: __ontimeTest.authPersistenceKey().split(':')[2], appName: '[DEFAULT]', createdAt: String(Date.now()), lastLoginAt: String(Date.now())
      } });
      transaction.oncomplete = resolve; transaction.onerror = () => reject(transaction.error);
    }); db.close();
  }, uid);
  // The production Auth client runs here; network stays disabled for this whole scenario.
  await setDisconnected(page, uid, true);
  await page.goto(`${origin}/?cached_auth_test=${uid}`);
  await page.getByRole('button', { name: '班表', exact: true }).click();
  await page.getByText('cached-work', { exact: true }).first().waitFor();
  await openManualMeal(page, '12:00', '12:20', 'lunch'); await saveMeal(page);
  const saved = await pendingSnapshot(page, uid);
  assert.equal(saved.pending.length, 2);
  assert.equal(saved.data.meals.length, 1);
  assert.equal(harness.cloud(uid).size, 0);
});

test('unknown commute estimates do not turn the whole shift into a blocked meal window', async t => {
  const page = await openPage(t);
  const result = await page.evaluate(async () => {
    const repository = new __ontimeTest.Repository('fixture:planning', { localOnly: true });
    const { data } = await repository.loadAppData(); await repository.close();
    data.shifts = data.shifts.map(shift => ({ ...shift, plannedBreaks: [], commuteSnapshot: { ...shift.commuteSnapshot, outMinutes: null, backMinutes: null, noCommute: false } }));
    const input = __ontimeTest.mealInput(data, '2026-11-04', Date.now());
    return { commute: input.commuteIntervals, lunch: __ontimeTest.suggestMeals(input).suggestions.find(meal => meal.kind === 'lunch') };
  });
  assert.equal(result.commute.length, 0);
  assert.ok(result.lunch);
  assert.equal(result.lunch.reason, '上班期間用餐');
});


test('cached auth initializes without a login iframe and Google sign-in still supplies its popup resolver', async t => {
  const page = await openPage(t);
  const result = await page.evaluate(async () => {
    const auth = __ontimeTest.authClient();
    await auth._initializationPromise;
    const lazy = !auth._popupRedirectResolver;
    return { lazy, popup: await __ontimeTest.testGooglePopup() };
  });
  assert.equal(result.lazy, true);
  assert.deepEqual(result.popup, { resolver: true, provider: 'google.com', auth: true });
});
