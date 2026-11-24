// Стенд очереди на странице YouTube (stands/queue.html): заглушка chrome.*, очередь в памяти.
// Сообщения queue:remove / queue:put меняют очередь, как фон расширения.
history.replaceState(null, "", "/watch?v=vid00000000");
const ids = Array.from({ length: 12 }, (_, i) => "vid" + String(i).padStart(8, "0"));
const titles = ["Текущее видео", "Как построить уютный дом в Майнкрафте", "Средневековый замок: постройка шаг за шагом", "Красивый мост через реку", "Рамен дома — простой рецепт", "Кот впервые видит снег", "Котёнок и робот-пылесос", "Древний Рим за 20 минут", "Пять песен на трёх аккордах", "Соло для начинающих", "Как работает интернет", "Танцующий робот"];
const db = { queue: ids.map((id, i) => ({ id, title: titles[i], channel: "Канал " + (i % 3 + 1), len: 300 + i * 97 })), queuePos: { vid00000002: 120 }, queueOpts: {} };
const listeners = [];
window.__log = [];
const fire = (ch) => listeners.forEach((f) => f(ch, "local"));
window.chrome = {
  runtime: {
    id: "stub",
    sendMessage: async (m) => {
      __log.push(m.type + " " + JSON.stringify(m.ids || (m.items || []).map((x) => x.rec?.id)));
      if (m.type === "queue:remove") {
        const old = db.queue; db.queue = old.filter((x) => !m.ids.includes(x.id));
        fire({ queue: { newValue: db.queue } }); return { total: db.queue.length };
      }
      if (m.type === "queue:put") {
        const q = db.queue.slice();
        for (const it of m.items.slice().sort((a, b) => a.at - b.at)) q.splice(Math.min(it.at, q.length), 0, it.rec);
        db.queue = q; fire({ queue: { newValue: db.queue } }); return { back: m.items.length };
      }
      return null;
    },
  },
  storage: { local: { get: async () => JSON.parse(JSON.stringify(db)), set: async () => {} }, onChanged: { addListener: (f) => listeners.push(f) } },
};
document.documentElement.setAttribute("dark", "");
