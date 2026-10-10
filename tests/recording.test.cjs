const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const { createServer } = require('node:http');
const { readFileSync, existsSync } = require('node:fs');
const { join } = require('node:path');
const { chromium, webkit } = require('playwright');

let server, browser, origin;
const html = readFileSync(join(__dirname, '../index.html'));
const engine = process.env.TEST_BROWSER || 'chromium';

before(async () => {
  server = createServer((request, response) => {
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

test('attendance and journeys use compact controls and still save records', async t => {
  const page = await openPage(t);
  await page.getByRole('button', { name: '今天', exact: true }).click();
  await page.getByRole('button', { name: '補登／修正紀錄', exact: true }).click();
  let dialog = page.getByRole('dialog');
  assert.equal(await dialog.locator('.recording-occurrence:visible').count(), 0);
  await dialog.getByLabel('補登上班時間', { exact: true }).fill('08:00');
  await dialog.getByLabel('補登下班時間', { exact: true }).fill('09:00');
  await page.getByRole('button', { name: '儲存補登', exact: true }).click();
  await dialog.waitFor({ state: 'hidden' });
  await page.getByRole('button', { name: '補登／修正紀錄', exact: true }).click();
  dialog = page.getByRole('dialog');
  await dialog.getByLabel('紀錄種類', { exact: true }).selectOption('journey');
  for (const [label, time] of [['出門', '07:00'], ['抵達', '07:30'], ['離開', '09:00'], ['到家', '09:30']]) {
    await dialog.getByLabel(`補登${label}時間`, { exact: true }).fill(time);
  }
  await assertNoOverflow(page);
  await page.getByRole('button', { name: '儲存補登', exact: true }).click();
  await dialog.waitFor({ state: 'hidden' });
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
