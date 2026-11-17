// Тема до загрузки настроек: панель открывается сразу в последней выбранной
// теме, без вспышки (настройки из chrome.storage приходят асинхронно).
try {
  const t = localStorage.getItem("ytcs:theme");
  if (t === "dark" || t === "light") document.documentElement.dataset.theme = t;
} catch (e) {
  /* не критично */
}
