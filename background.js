chrome.runtime.onInstalled.addListener(() => {
  chrome.storage.session
    .setAccessLevel({ accessLevel: "TRUSTED_AND_UNTRUSTED_CONTEXTS" })
    .catch((e) => console.error("setAccessLevel:", e));
  chrome.sidePanel
    .setPanelBehavior({ openPanelOnActionClick: true })
    .catch((e) => console.error("sidePanel behavior:", e));
});

chrome.runtime.onStartup.addListener(() => {
  chrome.storage.session
    .setAccessLevel({ accessLevel: "TRUSTED_AND_UNTRUSTED_CONTEXTS" })
    .catch((e) => console.error("setAccessLevel:", e));
  chrome.sidePanel
    .setPanelBehavior({ openPanelOnActionClick: true })
    .catch((e) => console.error("sidePanel behavior:", e));
});