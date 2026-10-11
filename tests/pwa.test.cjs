const { test } = require('node:test');
const assert = require('node:assert/strict');
const { createServer } = require('node:http');
const { readFileSync, mkdtempSync, rmSync } = require('node:fs');
const { tmpdir } = require('node:os');
const { join } = require('node:path');
const { chromium } = require('playwright');

test('PWA installation at GitHub Pages subpath: manifest, native prompt, fallback, standalone and offline start', async t => {
  const root = join(__dirname, '..');
  const server = createServer((req, res) => {
    const path = new URL(req.url, 'http://localhost').pathname;
    const file = path === '/codex/' ? 'index.html' : path.slice('/codex/'.length);
    try {
      res.setHeader('Content-Type', file.endsWith('.js') ? 'application/javascript' : file.endsWith('.webmanifest') ? 'application/manifest+json' : file.endsWith('.png') ? 'image/png' : file.endsWith('.css') ? 'text/css' : file.endsWith('.woff2') ? 'font/woff2' : 'text/html');
      res.end(readFileSync(join(root, file)));
    } catch { res.writeHead(404); res.end(); }
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise(resolve => server.close(resolve)));
  const profile = mkdtempSync(join(tmpdir(), 'ontime-pwa-'));
  const context = await chromium.launchPersistentContext(profile, { executablePath: '/usr/bin/chromium', args: ['--no-sandbox'], viewport: { width: 390, height: 844 } });
  const browser = context.browser();
  t.after(async () => { await context.close(); rmSync(profile, { recursive: true, force: true }); });
  const page = await context.newPage();
  const errors = []; page.on('pageerror', error => errors.push(error.message));
  const origin = `http://127.0.0.1:${server.address().port}`;
  await page.goto(origin + '/codex/?fixture=1&scene=planning');
  await page.getByRole('button', { name: '安裝 App', exact: true }).waitFor();
  const manifest = await page.evaluate(async () => {
    const link = document.querySelector('link[rel="manifest"]');
    const data = await (await fetch(link.href)).json();
    return { data, url: link.href };
  });
  for (const key of ['id', 'start_url', 'scope']) assert.equal(new URL(manifest.data[key], manifest.url).pathname, '/codex/');
  assert.equal(manifest.data.display, 'standalone');
  for (const icon of manifest.data.icons) {
    const size = await page.evaluate(async src => {
      const img = new Image(); img.src = src; await img.decode(); return [img.naturalWidth, img.naturalHeight];
    }, new URL(icon.src, manifest.url).href);
    assert.equal(size.join('x'), icon.sizes);
  }
  await page.waitForFunction(() => !!navigator.serviceWorker.controller);
  const cdp = await context.newCDPSession(page);
  await cdp.send('Page.enable');
  const installability = await cdp.send('Page.getInstallabilityErrors');
  assert.deepEqual(installability.installabilityErrors, []);
  await page.evaluate(() => {
    window.promptCount = 0;
    const event = new Event('beforeinstallprompt', { cancelable: true });
    event.prompt = () => { window.promptCount++; return Promise.resolve(); };
    event.userChoice = Promise.resolve({ outcome: 'dismissed' });
    dispatchEvent(event);
  });
  await page.getByRole('button', { name: '安裝 App', exact: true }).click();
  await page.getByRole('status').filter({ hasText: '已取消安裝' }).waitFor();
  assert.equal(await page.evaluate(() => window.promptCount), 1);
  await page.getByRole('button', { name: '安裝 App', exact: true }).click();
  await page.getByRole('dialog').getByText('Android / Chrome', { exact: true }).waitFor();
  await page.getByRole('button', { name: '關閉', exact: true }).click();
  await page.evaluate(() => {
    const event = new Event('beforeinstallprompt', { cancelable: true });
    event.prompt = () => { window.promptCount++; return Promise.resolve(); };
    event.userChoice = Promise.resolve({ outcome: 'accepted' });
    dispatchEvent(event);
  });
  await page.getByRole('button', { name: '安裝 App', exact: true }).click();
  await page.getByRole('status').filter({ hasText: '已確認安裝' }).waitFor();
  assert.equal(await page.evaluate(() => window.promptCount), 2);
  await page.evaluate(() => dispatchEvent(new Event('appinstalled')));
  await page.getByRole('button', { name: '安裝 App', exact: true }).waitFor({ state: 'hidden' });
  await page.waitForFunction(() => !!navigator.serviceWorker.controller);
  const scope = await page.evaluate(async () => (await navigator.serviceWorker.ready).scope);
  assert.equal(new URL(scope).pathname, '/codex/');
  await context.setOffline(true);
  await page.reload();
  await page.getByRole('button', { name: '用餐安排', exact: true }).waitFor();
  assert.equal(await page.evaluate(() => !!window.ontimePwa), true);
  assert.equal(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth), false);
  await context.setOffline(false);
  const ios = await browser.newContext({ viewport: { width: 320, height: 720 }, userAgent: 'Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X) AppleWebKit/605.1.15 Version/18.0 Mobile/15E148 Safari/604.1' });
  const phone = await ios.newPage();
  await phone.goto(origin + '/codex/?fixture=1');
  await phone.getByRole('button', { name: '安裝 App', exact: true }).click();
  await phone.getByRole('dialog').getByText('iPhone / iPad', { exact: true }).waitFor();
  assert.equal(await phone.evaluate(() => document.documentElement.scrollWidth > innerWidth), false);
  await ios.addInitScript(() => Object.defineProperty(navigator, 'standalone', { value: true }));
  await phone.reload();
  await phone.getByRole('button', { name: '用餐安排', exact: true }).waitFor();
  assert.equal(await phone.getByRole('button', { name: '安裝 App', exact: true }).count(), 0);
  assert.deepEqual(errors, []);
});
