// Стенд панели со списками «Скорость по каналам» и «Громкость по каналам»: заглушка
// chrome.storage с вымышленными каналами, затем настоящие модули списков.
const now = Date.now();
const id = (c) => "UC" + c.repeat(22);
const store = {
  settings: { volumeLeveler: true },
  channelSpeeds: { [id("a")]: { r: 1.5, n: "Лекции по истории", t: now }, [id("b")]: { r: 1.25, n: "Подкаст о науке", t: now - 1 } },
  channelVolumes: {
    [id("c")]: { v: 150, n: "Тихий подкаст", t: now },
    [id("d")]: { v: 40, n: "Громкая музыка", t: now - 1 },
    [id("e")]: { v: 85, n: "Очень длинное название канала, которое не помещается в одну строку", t: now - 2 },
  },
};
globalThis.chrome = {
  runtime: { id: "stand" },
  storage: {
    local: {
      get: async (k) => Object.fromEntries([].concat(k).filter((x) => x in store).map((x) => [x, structuredClone(store[x])])),
      set: async (o) => Object.assign(store, structuredClone(o)),
    },
    onChanged: { addListener() {} },
  },
};
const script = (src) =>
  new Promise((ok) => {
    const s = document.createElement("script");
    s.src = src;
    s.onload = s.onerror = ok;
    document.head.appendChild(s);
  });
await script("/speed-core.js");
await script("/volume-core.js");
await import("/sidepanel/channel-speed.js");
await import("/sidepanel/channel-volume.js");
await new Promise((r) => setTimeout(r, 100)); // списки отрисованы
