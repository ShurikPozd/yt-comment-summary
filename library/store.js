// «Моя библиотека»: хранилище каталога (IndexedDB расширения).

// ---------- хранилище (IndexedDB расширения) ----------
export function openDb() {
  return new Promise((resolve, reject) => {
    const r = indexedDB.open("ytcs-library", 1);
    r.onupgradeneeded = () => r.result.createObjectStore("kv");
    r.onsuccess = () => resolve(r.result);
    r.onerror = () => reject(r.error);
  });
}
export async function kv(key, value) {
  const db = await openDb();
  return new Promise((resolve, reject) => {
    const tx = db.transaction("kv", value === undefined ? "readonly" : "readwrite");
    const st = tx.objectStore("kv");
    const r = value === undefined ? st.get(key) : st.put(value, key);
    tx.oncomplete = () => resolve(value === undefined ? r.result : true);
    tx.onerror = () => reject(tx.error);
  });
}
