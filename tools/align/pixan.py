# Замер по пикселям: где на снимке «чернила» первой заглавной и значка.
#   python tools/align/pixan.py <папка> [ключ@dpr …] [--th 0.5]
# Для каждой пары из <ключ>@<dpr>.json (audit.js) по снимку <ключ>@<dpr>.png:
#   текст  — центр заглавной относительно середины элемента внутри рамки, css px (плюс — ниже);
#   значок — центр значка относительно центра заглавной, css px (плюс — ниже).
# Печатает разъехавшиеся больше порога. Как модуль: measure(png, json) → список.
import json, os, sys

import numpy as np
from PIL import Image

INK = 45  # насколько пиксель должен отличаться по яркости от фона, чтобы считаться буквой
EDGE = 2  # css px сверху и снизу элемента не смотрим — там рамка


def _lum(path):
    a = np.asarray(Image.open(path).convert("RGB"), dtype=np.float32)
    return a[..., 0] * 0.3 + a[..., 1] * 0.59 + a[..., 2] * 0.11


def _ink(L, bg, x0, x1, y0, y1, th=INK):
    """Верх и низ «чернил» в прямоугольнике (в пикселях снимка) или None."""
    H, W = L.shape
    x0, x1, y0, y1 = max(0, x0), min(W, x1), max(0, y0), min(H, y1)
    if x1 <= x0 or y1 <= y0:
        return None
    rows = np.nonzero((np.abs(L[y0:y1, x0:x1] - bg) > th).any(axis=1))[0]
    if not len(rows):
        return None
    return y0 + rows[0], y0 + rows[-1] + 1


def measure(png, js):
    d = json.load(open(js, encoding="utf-8"))
    s = d["dpr"]
    L = _lum(png)
    H, W = L.shape
    out = []
    for q in d["pairs"]:
        er, cr, sr = q["er"], q["cr"], q.get("sr")
        res = {"el": q["el"], "text": q["text"], "multi": q.get("multi", False), "bc": None, "dd": None}
        out.append(res)
        if res["multi"]:
            continue
        ey0, ey1 = int(np.ceil((er[1] + EDGE) * s)), int(np.floor((er[3] - EDGE) * s))
        cx0, cx1 = int(np.floor((cr[0] + 0.6) * s)), int(np.ceil((cr[2] - 0.6) * s))
        # фон — самая частая яркость в столбце буквы по всей высоте элемента
        col = L[max(0, int(er[1] * s)) : min(H, int(np.ceil(er[3] * s))), max(0, cx0) : min(W, cx1)]
        if not col.size:
            continue
        bg = np.bincount(np.clip(col, 0, 255).astype(np.uint8).ravel()).argmax()
        b = _ink(L, bg, cx0, cx1, max(ey0, int(np.floor(cr[1] * s))), min(ey1, int(np.ceil(cr[3] * s))))
        if not b:
            continue
        capc = (b[0] + b[1]) / 2 / s
        bt, bb = q.get("bw", [0, 0])
        res["bc"] = round(capc - (er[1] + bt + er[3] - bb) / 2, 2)
        if sr:
            ix0, ix1 = int(np.floor(sr[0] * s)), int(np.ceil(sr[2] * s))
            iy0, iy1 = max(ey0, int(np.floor(sr[1] * s))), min(ey1, int(np.ceil(sr[3] * s)))
            a = _ink(L, bg, ix0, ix1, iy0, iy1) or _ink(L, bg, ix0, ix1, iy0, iy1, 25)
            if a:
                res["dd"] = round((a[0] + a[1]) / 2 / s - capc, 2)
    return out


def main():
    args = [a for a in sys.argv[1:]]
    th = 0.5
    if "--th" in args:
        i = args.index("--th")
        th = float(args[i + 1])
        del args[i : i + 2]
    folder, tags = args[0], args[1:]
    if not tags:
        tags = sorted(f[:-5] for f in os.listdir(folder) if f.endswith(".json"))
    for tag in tags:
        res = measure(os.path.join(folder, tag + ".png"), os.path.join(folder, tag + ".json"))
        n = sum(r["bc"] is not None for r in res)
        seen, bad = set(), 0
        print(f"== {tag}")
        for r in res:
            if r["bc"] is None:
                continue
            off = abs(r["bc"]) > th or (r["dd"] is not None and abs(r["dd"]) > th)
            k = (r["el"], r["text"], r["bc"], r["dd"])
            if off and k not in seen:
                seen.add(k)
                bad += 1
                print(f"  текст {r['bc']:+.2f}" + (f"  значок {r['dd']:+.2f}" if r["dd"] is not None else "") + f"  {r['el']}  «{r['text']}»")
        print(f"  проверено {n}, разъехавшихся {bad}")


if __name__ == "__main__":
    sys.stdout.reconfigure(encoding="utf-8")
    main()
