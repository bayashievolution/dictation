/**
 * captions-bootstrap.js — captions.html の早期初期化（CSP 対応の外部スクリプト）
 *
 * v0.13.31: settingsOnly モード（メイン画面の字幕モーダル内 iframe で使う想定）。
 * URL に ?settingsOnly=1 が付いていたら、字幕表示エリア・ツールバーを隠して
 * 設定パネルだけを常時表示する。
 *
 * CSP 制約：manifest.json の `extension_pages` で script-src 'self' のため、
 * inline script は禁止。外部 JS として読み込むことで CSP 違反を回避する。
 */
(function () {
  try {
    var p = new URLSearchParams(location.search);
    if (p.get('settingsOnly') !== '1') return;

    document.documentElement.classList.add('cap-settings-only');

    // 外部 CSS（captions.css）が効かない場合に備えた inline 保険スタイル。
    // <link rel="stylesheet"> より前に評価されるので、必ず勝つ。
    var s = document.createElement('style');
    s.textContent = [
      '#cap-canvas, #cap-toolbar { display: none !important; }',
      '#cap-settings.cap-settings, #cap-settings.cap-settings.hidden {',
      '  position: static !important; display: block !important;',
      '  width: 100% !important; height: 100vh !important; max-width: none !important;',
      '  transform: none !important; border: none !important; box-shadow: none !important;',
      '  visibility: visible !important; opacity: 1 !important; pointer-events: auto !important;',
      '}',
      '#cap-settings .cap-settings-head { display: none !important; }',
      '#cap-settings .cap-settings-body {',
      '  padding: 16px !important; max-height: none !important;',
      '  height: 100vh !important; overflow: auto !important;',
      '}',
      'body { margin: 0 !important; padding: 0 !important; }'
    ].join('\n');
    document.head.appendChild(s);
  } catch (e) { /* no-op */ }
})();
