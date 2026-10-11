// Only the local test server instruments the bundle. Production HTML has no test hooks.
const { readFileSync } = require('node:fs');
const { join } = require('node:path');
const clouds = new Map(), failUploads = new Set(), disconnected = new Set();
let workerVariant = 'v1';
function cloud(uid) { if (!clouds.has(uid)) clouds.set(uid, new Map()); return clouds.get(uid); }
function instrument(html) {
  const hooks = `
    globalThis.__ontimeTest = { Repository: Bv, prepareMealPhoto: ontimePrepareMealPhoto, parseBackup: sP, exportBackup: rP, payMode: ontimePayMode, paySnapshot: ontimePaySnapshot, workSummary: g0, validateRevision: Da, sessionCsv: oP, budget: bp, mealInput: Ip, suggestMeals: Lk, authClient: () => cc()?.auth, testGooglePopup: async () => {
      const original = _j; let args;
      try { _j = async (...value) => { args = value; return { user: { uid: 'popup-regression' } }; }; await SL(); return { resolver: args[2] === iO, provider: args[1].providerId, auth: args[0] === cc()?.auth }; }
      finally { _j = original; }
    }, authPersistenceKey: () => "firebase:authUser:" + bs.VITE_FIREBASE_API_KEY + ":[DEFAULT]" };
    const testUid = new URLSearchParams(location.search).get('sync_test');
    if (testUid) {
      const user = { uid: testUid, displayName: 'Offline Regression', email: 'offline@example.test' };
      cc = () => ({ auth: { currentUser: user }, firestore: {} });
      CL = listener => { queueMicrotask(() => listener(user)); return () => {}; };
      DL = () => () => {};
      tw = (_, ...path) => ({ uid: path[1], id: path[3] });
      aL = (_, ...path) => ({ uid: path[1] });
      const endpoint = ref => '/__test-cloud/' + encodeURIComponent(ref.uid) + (ref.id ? '/' + encodeURIComponent(ref.id) : '');
      Lp = async ref => { const response = await fetch(endpoint(ref)); if (response.status === 404) return { exists: () => false }; if (!response.ok) throw Error('Cloud read unavailable'); const data = await response.json(); return { exists: () => true, data: () => data }; };
      bL = async (ref, data) => { const response = await fetch(endpoint(ref), { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(data) }); if (!response.ok) throw Error('Cloud upload unavailable'); };
      TL = async ref => { const response = await fetch(endpoint(ref)); if (!response.ok) throw Error('Cloud read unavailable'); return { docs: (await response.json()).map(data => ({ data: () => data })) }; };
    }
  `;
  return html.replace('wS.createRoot(document.getElementById("root"))', hooks + '\nwS.createRoot(document.getElementById("root"))');
}
async function handle(request, response, root) {
  const url = new URL(request.url, 'http://localhost');
  if (disconnected.size) {
    response.writeHead(503); response.end('Test network unavailable'); return true;
  }
  if (url.pathname === '/sw.js') {
    const script = readFileSync(join(root, 'sw.js'), 'utf8').replace('${prefix}v1', '${prefix}' + workerVariant);
    response.writeHead(200, { 'Content-Type': 'application/javascript', 'Cache-Control': 'no-store' }); response.end(script); return true;
  }
  if (!url.pathname.startsWith('/__test-cloud/')) return false;
  const [uid, id] = url.pathname.slice('/__test-cloud/'.length).split('/').map(decodeURIComponent), records = cloud(uid);
  response.setHeader('Content-Type', 'application/json');
  if (request.method === 'POST') {
    if (failUploads.delete(uid)) { response.writeHead(503); response.end('{}'); return true; }
    const chunks = []; for await (const chunk of request) chunks.push(chunk);
    const revision = JSON.parse(Buffer.concat(chunks).toString());
    const existing = records.get(id);
    if (existing && JSON.stringify(existing) !== JSON.stringify(revision)) { response.writeHead(409); response.end('{}'); return true; }
    records.set(id, revision); response.end('{}');
  } else if (!id) response.end(JSON.stringify([...records.values()]));
  else if (records.has(id)) response.end(JSON.stringify(records.get(id)));
  else { response.writeHead(404); response.end('{}'); }
  return true;
}
module.exports = { instrument, handle, cloud, failUploads, disconnected, setWorkerVariant: value => { workerVariant = value; } };
