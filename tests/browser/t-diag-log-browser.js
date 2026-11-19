// 診断ログに、害の無い ResizeObserver のお知らせを残さない（v0.24.150）を、本物の Chromium で本体を読み込んで検査する。
//
// ■ これは `sh tests/run.sh` では走らない（tests/t-*.js の形にしていない）
//
//   node serve.js &
//   NODE_PATH=/opt/node22/lib/node_modules node tests/browser/t-diag-log-browser.js
//
// やっさんのログ（2026-11-19）で「ResizeObserver loop completed with undelivered notifications」が数秒おきに出て、
// ほかの行が読めなくなっていた。ほんとうのエラーはこれまでどおり残ることも見る
const { chromium } = require('playwright');
const URL = process.env.URL || 'http://127.0.0.1:8765/';
let fail = 0;
const eq = (label, got, want) => {
  const ok = JSON.stringify(got) === JSON.stringify(want);
  console.log(`${ok ? '✓' : '✕'} ${label}` + (ok ? '' : `\n    得 ${JSON.stringify(got)}\n    期 ${JSON.stringify(want)}`));
  if (!ok) fail++;
};
(async () => {
  const b = await chromium.launch();
  const p = await b.newPage();
  await p.goto(URL);
  await p.waitForTimeout(800);
  const r = await p.evaluate(() => {
    const n0 = diagLog.entries.length;
    window.dispatchEvent(new ErrorEvent('error', { message: 'ResizeObserver loop completed with undelivered notifications.' }));
    const n1 = diagLog.entries.length;
    window.dispatchEvent(new ErrorEvent('error', { message: 'ほんとうのエラー' }));
    return [n1 - n0, diagLog.entries.length - n1, diagLog.entries[diagLog.entries.length - 1].msg.includes('ほんとうのエラー')];
  });
  eq('ResizeObserver のお知らせは記録しない', r[0], 0);
  eq('ほんとうのエラーは記録する', [r[1], r[2]], [1, true]);
  await b.close();
  console.log(fail ? `\n✕ ${fail} 件失敗` : '\nすべて通過');
  process.exit(fail ? 1 : 0);
})();
