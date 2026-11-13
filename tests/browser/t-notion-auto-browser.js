// 録音を止めたら Notion に自動で保存（v0.24.142）を、本物の Chromium にこのフォルダを**拡張として**読み込んで検査する。
//
// ■ これは `sh tests/run.sh` では走らない（tests/t-*.js の形にしていない）
//
//   NODE_PATH=/opt/node22/lib/node_modules node tests/browser/t-notion-auto-browser.js
//   （serve.js は要らない）
//
// Notion は拡張のページでしか動かない（ブラウザ版は CORS で届かない）ので拡張として開く。api.notion.com は差し替える。
// マイクと Web Speech は偽物にして、本当に［録音］→［停止］を押す。止めたあとの流れ（stopRecording の最後）から
// 自動保存が呼ばれているかを見るため（CLAUDE.md「誰がいつ呼ぶか」）
const { chromium } = require('playwright');
const fs = require('fs'), path = require('path'), os = require('os');
const REPO = path.resolve(__dirname, '../..');

let fail = 0;
const eq = (label, got, want) => {
  const ok = JSON.stringify(got) === JSON.stringify(want);
  console.log(`${ok ? '✓' : '✕'} ${label}` + (ok ? '' : `\n    得 ${JSON.stringify(got)}\n    期 ${JSON.stringify(want)}`));
  if (!ok) fail++;
};

(async () => {
  const udd = fs.mkdtempSync(path.join(os.tmpdir(), 'dict-notion-auto-'));
  const ctx = await chromium.launchPersistentContext(udd, {
    headless: false,
    args: ['--headless=new', `--disable-extensions-except=${REPO}`, `--load-extension=${REPO}`, '--use-fake-ui-for-media-stream', '--use-fake-device-for-media-stream'],
  });
  const calls = [];
  let failPages = false;
  await ctx.route('https://api.notion.com/**', (r) => {
    const req = r.request();
    const p = req.url().replace('https://api.notion.com/v1', '');
    calls.push(req.method() + ' ' + p + (req.method() === 'POST' ? ' ' + req.postData() : ''));
    if (p.startsWith('/data_sources/')) return r.fulfill({ contentType: 'application/json', body: JSON.stringify({ properties: { '名前': { type: 'title' }, '日付': { type: 'date' } } }) });
    if (p === '/pages' && failPages) return r.fulfill({ status: 500, contentType: 'application/json', body: JSON.stringify({ message: 'Internal error' }) });
    if (p === '/pages') return r.fulfill({ contentType: 'application/json', body: JSON.stringify({ id: 'page1', url: 'https://notion.so/page1' }) });
    if (p.includes('/children')) return r.fulfill({ contentType: 'application/json', body: JSON.stringify({ results: [{ id: 'tg1', type: 'toggle', toggle: { rich_text: [] } }] }) });
    if (p.startsWith('/search')) return r.fulfill({ contentType: 'application/json', body: JSON.stringify({ results: [{ object: 'data_source', id: 'ds1', title: [{ plain_text: '講義ノート' }] }], has_more: false }) });
    if (p.includes('/users/me')) return r.fulfill({ contentType: 'application/json', body: JSON.stringify({ name: 'x' }) });
    return r.fulfill({ contentType: 'application/json', body: JSON.stringify({ results: [], has_more: false }) });
  });
  await ctx.addInitScript(() => {
    // Web Speech の偽物: start で 1 つ確定した文を返す
    class FakeRec extends EventTarget {
      start() { setTimeout(() => { if (this.onstart) this.onstart(); }, 10); }
      stop() { setTimeout(() => { if (this.onend) this.onend(); }, 10); }
      abort() { this.stop(); }
    }
    window.SpeechRecognition = FakeRec;
    window.webkitSpeechRecognition = FakeRec;
  });
  const sw = ctx.serviceWorkers()[0] || await ctx.waitForEvent('serviceworker', { timeout: 15000 });
  const id = new URL(sw.url()).host;

  async function run(settings) {
    const page = await ctx.newPage();
    page.on('pageerror', e => { console.log('✕ ページで例外: ' + e.message); fail++; });
    await page.goto(`chrome-extension://${id}/index.html`);
    await page.evaluate((s) => { localStorage.clear(); localStorage.setItem('dictation:settings', JSON.stringify(s)); }, settings);
    await page.reload();
    await page.waitForTimeout(1200);
    calls.length = 0;
    await page.click('#btn-toggle');
    await page.waitForTimeout(800);
    const sid = await page.evaluate(() => { appendRawChunk('今日は火災報知器の話をします'); return state.recordingSessionId || state.activeId; });
    await page.click('#btn-toggle');
    await page.waitForTimeout(3000);
    return { page, sid };
  }
  const base = { inputMode: 'web-speech', aiEnabled: false, autoSummarize: false, notionEnabled: true, notionToken: 'ntn_good',
    notionLastDataSourceId: 'ds1', notionLastDataSourceTitle: '講義ノート', notionLastDatePropName: '日付' };

  console.log('■ オフなら何もしない');
  {
    const { page } = await run({ ...base, notionAutoSave: false });
    eq('Notion に送らない', calls.filter((c) => c.startsWith('POST /pages')).length, 0);
    await page.close();
  }

  console.log('\n■ オン・前回の保存先・閉じない: 雲の印が付いたタブが残る');
  {
    const { page, sid } = await run({ ...base, notionAutoSave: true, notionAutoTarget: 'last', notionAutoCloseTab: false });
    const post = calls.find((c) => c.startsWith('POST /pages')) || '';
    eq('止めたら前回の保存先に新しいノートを作る（日付の列も）', [post.includes('"data_source_id":"ds1"'), post.includes('"日付"')], [true, true]);
    eq('中身（文字起こし）も送る', calls.some((c) => c.includes('/blocks/page1/children')), true);
    const st = await page.evaluate((sid) => ({ tab: !!state.sessions.find((s) => s.id === sid), up: !!(state.sessions.find((s) => s.id === sid) || {}).notionUploadedAt,
      badge: !!document.querySelector('.tab-uploaded'), title: document.getElementById('notion-progress-title').textContent }), sid);
    eq('タブは残り、保存済みの印が付く', [st.tab, st.up, st.badge], [true, true, true]);
    eq('右下の小窓で知らせる', st.title, 'Notion への自動保存が完了しました');
    await page.close();
  }

  console.log('\n■ オン・決めた保存先（既存のノートに追記）・閉じる・録音を残す');
  {
    const dest = { id: 'ds2', title: '会議', titleProp: '名前', dateProp: '', pageId: 'note9', pageUrl: 'https://notion.so/note9', pageTitle: '定例' };
    const { page, sid } = await run({ ...base, notionAutoSave: true, notionAutoTarget: 'fixed', notionAutoDest: dest, notionAutoCloseTab: true, notionAutoKeepAudio: true });
    eq('決めたノートに追記する（新しいノートは作らない）', [calls.some((c) => c.includes('/blocks/note9/children')), calls.some((c) => c.startsWith('POST /pages'))], [true, false]);
    const st = await page.evaluate((sid) => ({ tab: !!state.sessions.find((s) => s.id === sid), pinned: isAudioPinned(sid), body: document.getElementById('notion-progress-body').textContent }), sid);
    eq('タブを閉じ、録音は残す（保管している録音に「残す」）', [st.tab, st.pinned], [false, true]);
    eq('小窓に閉じたことと録音を残したことを書く', [st.body.includes('閉じました'), st.body.includes('録音は残しました')], [true, true]);
    await page.close();
  }

  console.log('\n■ 失敗したら: タブを閉じず、録音も残したまま知らせる');
  {
    failPages = true;
    const { page, sid } = await run({ ...base, notionAutoSave: true, notionAutoTarget: 'last', notionAutoCloseTab: true });
    // Notion がだめだったときは何度か試し直すので、終わるまで待つ
    await page.waitForFunction(() => /失敗/.test(document.getElementById('notion-progress-title').textContent), null, { timeout: 30000 }).catch(() => {});
    failPages = false;
    const st = await page.evaluate((sid) => ({ tab: !!state.sessions.find((s) => s.id === sid), up: !!(state.sessions.find((s) => s.id === sid) || {}).notionUploadedAt,
      title: document.getElementById('notion-progress-title').textContent, body: document.getElementById('notion-progress-body').textContent }), sid);
    eq('タブは残る（閉じる設定でも）・印は付かない', [st.tab, st.up], [true, false]);
    eq('失敗したと知らせる', [st.title, st.body.includes('保存し直せます')], ['Notion への自動保存に失敗しました', true]);
    await page.close();
  }

  console.log('\n■ 前回の保存先が無いとき');
  {
    const { page } = await run({ ...base, notionAutoSave: true, notionAutoTarget: 'last', notionLastDataSourceId: '' });
    eq('送らずに、保存先が無いと知らせる', [calls.filter((c) => c.startsWith('POST')).length, (await page.textContent('#notion-progress-body')).includes('保存先がまだありません')], [0, true]);
    await page.close();
  }

  console.log('\n■ 設定の欄');
  {
    const page = await ctx.newPage();
    await page.goto(`chrome-extension://${id}/index.html`);
    await page.evaluate((s) => { localStorage.setItem('dictation:settings', JSON.stringify(s)); }, { ...base, notionAutoSave: false });
    await page.reload(); await page.waitForTimeout(1000);
    await page.evaluate(() => { openSettings(); expandAllSettingsSections(); });
    await page.waitForTimeout(600);
    const vis = () => page.evaluate(() => { const e = document.getElementById('notion-auto-fields'); return !e.hidden && e.getBoundingClientRect().height > 10; });
    eq('オフなら下の欄は隠れている', await vis(), false);
    await page.evaluate(() => document.getElementById('input-notion-auto-save').scrollIntoView({ block: 'center' }));
    await page.click('#input-notion-auto-save');
    await page.waitForTimeout(800);
    eq('オンにすると出る', await vis(), true);
    eq('保存先の選択肢（決めた保存先はまだ選べない）', await page.$$eval('#input-notion-auto-target option', (o) => o.map((x) => [x.textContent, x.disabled])), [['前回の保存先', false], ['決めた保存先（「保存先を選ぶ」で選びます）', true]]);
    // 保存先を選ぶ → いつもの小窓 → 決めた保存先に
    await page.click('#btn-notion-auto-pick');
    await page.waitForFunction(() => !document.getElementById('notion-picker').classList.contains('hidden') && !document.getElementById('btn-notion-picker-ok').disabled, null, { timeout: 8000 }).catch(() => {});
    await page.click('#btn-notion-picker-ok');
    await page.waitForTimeout(400);
    eq('選ぶと「決めた保存先：〜」になり、選ばれる', await page.evaluate(() => { const s = document.getElementById('input-notion-auto-target'); return [s.value, s.options[1].textContent]; }), ['fixed', '決めた保存先：講義ノート']);
    await page.click('#input-notion-auto-close');
    await page.evaluate(() => saveSettingsFromForm());
    const st = await page.evaluate(() => { const s = JSON.parse(localStorage.getItem('dictation:settings')); return [s.notionAutoSave, s.notionAutoTarget, s.notionAutoDest && s.notionAutoDest.id, s.notionAutoCloseTab, s.notionAutoKeepAudio]; });
    eq('保存すると設定に入る', st, [true, 'fixed', 'ds1', true, false]);
    await page.close();
  }

  await ctx.close();
  fs.rmSync(udd, { recursive: true, force: true });
  console.log(fail ? `\n✕ ${fail} 件失敗` : '\nすべて通過');
  process.exit(fail ? 1 : 0);
})();
