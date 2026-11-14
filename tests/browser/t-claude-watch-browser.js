// Claude の返事が遅い・試し直している・スタンバイ後（v0.24.145）を、本物の Chromium で本体を読み込んで検査する。
//
// ■ これは `sh tests/run.sh` では走らない（tests/t-*.js の形にしていない）
//
//   node serve.js &
//   NODE_PATH=/opt/node22/lib/node_modules node tests/browser/t-claude-watch-browser.js
//
// 実機 2026-11-14（やっさん）: 止めたあと PC をスタンバイにし、立ち上げたら Claude の要約が「いつまで続くのか、正常なのか、
// 試し直しているのか、止まっているのか分からない」。見本（https://claude.ai/artifact/WiLp7kmj4F1n8V942Ss73a）で OK をもらった形を確かめる。
// Claude の口（claudeBridgeRun）は差し替える。_tryClaudeBridge（gemini.js）の試し直しとスタンバイ後のやり直しを通す
const { chromium } = require('playwright');
const URL = process.env.URL || 'http://127.0.0.1:8765/';
let fail = 0;
const eq = (label, got, want) => {
  const ok = JSON.stringify(got) === JSON.stringify(want);
  console.log(`${ok ? '✓' : '✕'} ${label}` + (ok ? '' : `\n    得 ${JSON.stringify(got)}\n    期 ${JSON.stringify(want)}`));
  if (!ok) fail++;
};

(async () => {
  const browser = await chromium.launch();
  const page = await browser.newPage();
  page.on('pageerror', e => { console.log('✕ ページで例外: ' + e.message); fail++; });
  await page.goto(URL);
  await page.waitForTimeout(1200);
  // Claude に回る設定にして（失敗しても Gemini に回さない＝試し直す）、口だけ差し替える
  await page.evaluate(() => {
    window.claudeBridgeShouldUse = () => true;
    window.claudeBridgeIsEnabled = () => true;
    window.claudeBridgeBrokenReason = () => '';
    window.claudeBridgeNoFallback = () => true;
    window.claudeBridgePromptFromBody = () => 'プロンプト';
    window.claudeBridgeTimeoutFor = () => 720000;
    window.__calls = [];
    window.__plan = [];
    window.claudeBridgeRun = (prompt, opts) => { window.__calls.push(opts.timeoutMs); const f = window.__plan.shift(); return f ? f() : new Promise(() => {}); };
  });
  const status = () => page.evaluate(() => ({ t: document.getElementById('status-indicator').textContent, c: document.getElementById('status-indicator').className }));

  console.log('■ ふつうに動いているときは何も足さない');
  await page.evaluate(() => { window.__plan = [() => new Promise((r) => setTimeout(() => r({ ok: true, text: '要約', seconds: 1 }), 600))]; window.__r = _tryClaudeBridge({}, 'summary'); });
  await page.waitForTimeout(300);
  eq('オレンジにならない', (await status()).c.includes('caution'), false);
  eq('返事が来れば、その字を返す', await page.evaluate(() => window.__r), '要約');

  console.log('\n■ 試し直している');
  await page.evaluate(() => { window.__calls = []; window.__plan = [() => Promise.resolve({ ok: false, error: '時間内に返事がありませんでした' })]; window.__r2 = _tryClaudeBridge({}, 'summary'); });
  await page.waitForTimeout(3000);   // 試し直す前に 2 秒待つ
  const s1 = await status();
  eq('オレンジ・注意の絵で「要約を試し直しています（1/3 回目）」', [s1.t, s1.c.includes('caution'), s1.c.includes('cw-retry'), s1.c.includes('has-detail')], ['要約を試し直しています（1/3 回目）', true, true, true]);
  eq('試し直すときは待つ上限を延ばす（720 → 900 秒）', await page.evaluate(() => window.__calls.map((ms) => ms / 1000)), [720, 900]);
  await page.click('#status-indicator');
  await page.waitForTimeout(400);
  const det = await page.evaluate(() => (document.querySelector('.status-detail') || {}).textContent || '');
  eq('押すとくわしく（前の回の待ち時間・待つ上限・あと何回）', [det.includes('12 分待っても'), det.includes('待つ上限：15 分'), det.includes('あと 2 回')], [true, true, true]);
  await page.click('#titlebar .app-name');
  await page.waitForTimeout(300);

  console.log('\n■ スタンバイから戻った: 待たずにやり直す（試し直しの回数には数えない）');
  await page.evaluate(() => { window.__plan = [() => new Promise((r) => setTimeout(() => r({ ok: true, text: 'やり直した要約', seconds: 2 }), 1500))]; claudeWatchFireWake(); });
  await page.waitForTimeout(500);
  const s2 = await status();
  eq('「スタンバイ後、要約をやり直しています」', [s2.t, s2.c.includes('cw-retry')], ['スタンバイ後、要約をやり直しています', true]);
  eq('待つ上限は前の回と同じ（回数に数えない）', await page.evaluate(() => window.__calls.map((ms) => ms / 1000)), [720, 900, 900]);
  eq('やり直した返事を使う', await page.evaluate(() => window.__r2), 'やり直した要約');
  await page.waitForTimeout(400);
  eq('終わればオレンジは消えて、いつもの表示に戻る', (await status()).c.includes('caution'), false);

  console.log('\n■ いつもの 2 倍を過ぎた: 返事を待っている時間（字の出し入れの動きはしない）');
  await page.evaluate(() => { localStorage.setItem('dictation:claudeTimes', JSON.stringify({ title: [3] })); window.__plan = []; _tryClaudeBridge({}, 'title'); });
  await page.waitForTimeout(19000);
  eq('20 秒まではまだ出さない（いつもの 2 倍・最低 20 秒）', (await status()).c.includes('caution'), false);
  await page.waitForTimeout(2500);
  const s3 = await status();
  eq('オレンジ・砂時計で「Claude の返事を待っています 0:2x」', [/^Claude の返事を待っています 0:2\d$/.test(s3.t), s3.c.includes('cw-wait')], [true, true]);
  await page.waitForTimeout(1200);   // 出たときのふわっと（字が濃くなる途中）が終わってから測る
  const ops = [];
  for (let i = 0; i < 25; i++) { ops.push(await page.evaluate(() => [Number(getComputedStyle(document.querySelector('#status-indicator .status-text')).opacity), !!document.getElementById('status-indicator').dataset.oldText])); await page.waitForTimeout(60); }
  eq('時間が進んでも、字は消えて出直さない', [Math.min(...ops.map((x) => x[0])), ops.some((x) => x[1])], [1, false]);

  console.log('\n■ 名前の上に重なる（マイクの絵の右まで伸ばせる）・地は透けない');
  await page.setViewportSize({ width: 400, height: 700 });   // サイドパネルの幅
  await page.waitForTimeout(1500);
  const lay = await page.evaluate(() => {
    const st = document.getElementById('status-indicator').getBoundingClientRect(), name = document.querySelector('#titlebar .app-name').getBoundingClientRect(), icon = document.querySelector('#titlebar .app-icon').getBoundingClientRect();
    const bg = getComputedStyle(document.getElementById('status-indicator')).backgroundColor;
    return { over: st.left < name.right, afterIcon: st.left >= icon.right, opaque: !/rgba\(.*, 0\.\d+\)$/.test(bg) };
  });
  eq('名前の上に重なり、マイクの絵にはかからない・地は透けない', lay, { over: true, afterIcon: true, opaque: true });

  await browser.close();
  console.log(fail ? `\n✕ ${fail} 件失敗` : '\nすべて通過');
  process.exit(fail ? 1 : 0);
})();
