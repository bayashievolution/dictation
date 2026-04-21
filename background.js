/**
 * ばっさんディクテーション — background service worker
 * 拡張アイコンのクリックでサイドパネルを開くように設定
 */

chrome.runtime.onInstalled.addListener(() => {
  chrome.sidePanel.setPanelBehavior({ openPanelOnActionClick: true })
    .catch(err => console.error('setPanelBehavior failed:', err));
});

// Chrome 起動時にも一応設定（念のため）
chrome.runtime.onStartup.addListener(() => {
  chrome.sidePanel.setPanelBehavior({ openPanelOnActionClick: true })
    .catch(err => console.error('setPanelBehavior failed:', err));
});
