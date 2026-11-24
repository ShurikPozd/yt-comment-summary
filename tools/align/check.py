# Итог замера центровки: падает, если подпись дальше порога от середины элемента
# или значок дальше порога от заглавной.
#   python tools/align/check.py <папка> [--dprs 1.5,2] [--th 0.6] [--pages k1,k2…] [--json итог.json] [--all]
# Снимки и рамки в папке — от shot.mjs. Белый список — allow.txt рядом.
#   --all  — напечатать все элементы с отклонениями по каждому масштабу (для отчёта «до/после»);
#   --show <regex> — напечатать замеры элементов, чья строка «страница элемент «подпись»» подходит.
import json, os, re, sys

from pixan import measure

HERE = os.path.dirname(os.path.abspath(__file__))


def load_allow():
    rules = []
    with open(os.path.join(HERE, "allow.txt"), encoding="utf-8") as f:
        for line in f:
            line = line.strip()
            if not line or line.startswith(";"):
                continue
            pat, why, lim = (line.split(" :: ") + ["", ""])[:3]
            rules.append((re.compile(pat.strip()), why.strip() or "без причины", float(lim) if lim.strip() else None))
    return rules


def main():
    sys.stdout.reconfigure(encoding="utf-8")
    args = sys.argv[1:]
    opt = {"--dprs": "1.5,2", "--th": "0.6", "--pages": "", "--json": "", "--show": ""}
    flags = set()
    rest = []
    i = 0
    while i < len(args):
        if args[i] in opt:
            opt[args[i]] = args[i + 1]
            i += 2
        elif args[i].startswith("--"):
            flags.add(args[i])
            i += 1
        else:
            rest.append(args[i])
            i += 1
    folder = rest[0]
    dprs = [d for d in opt["--dprs"].split(",") if d]
    th = float(opt["--th"])
    allow = load_allow()
    want = [k for k in opt["--pages"].split(",") if k]

    missing = []
    keys = want or sorted({f.split("@")[0] for f in os.listdir(folder) if f.endswith(".json")})
    items = {}  # (страница, элемент, подпись) → {dpr: (текст, значок)}
    multi = set()
    for key in keys:
        for dpr in dprs:
            base = os.path.join(folder, f"{key}@{dpr}")
            if not (os.path.exists(base + ".json") and os.path.exists(base + ".png")):
                missing.append(f"{key}@{dpr}")
                continue
            for r in measure(base + ".png", base + ".json"):
                k = (key, r["el"], r["text"])
                if r["multi"]:
                    multi.add(k)
                    continue
                if r["bc"] is None:
                    continue
                cur = items.setdefault(k, {}).get(dpr)
                # одинаковых элементов на странице может быть много — берём худший
                if cur is None or abs(r["bc"]) + abs(r["dd"] or 0) > abs(cur[0]) + abs(cur[1] or 0):
                    items[k][dpr] = (r["bc"], r["dd"])

    fails, allowed, report = [], [], []
    for k, per in sorted(items.items()):
        worst_t = max(abs(v[0]) for v in per.values())
        worst_i = max((abs(v[1]) for v in per.values() if v[1] is not None), default=0)
        vals = "  ".join(f"{d}: текст {v[0]:+.2f}" + (f" значок {v[1]:+.2f}" if v[1] is not None else "") for d, v in sorted(per.items()))
        line = f"{k[0]:15s} {k[1]}  «{k[2]}»  [{vals}]"
        if opt["--show"] and re.search(opt["--show"], f"{k[0]} {k[1]} «{k[2]}»"):
            print("  · " + line)
        report.append({"page": k[0], "el": k[1], "text": k[2], "per": {d: {"text": v[0], "icon": v[1]} for d, v in per.items()}})
        if worst_t <= th and worst_i <= th:
            continue
        rule = next((r for r in allow if r[0].search(f"{k[0]} {k[1]} «{k[2]}»")), None)
        if rule and (rule[2] is None or max(worst_t, worst_i) <= rule[2]):
            allowed.append((line, rule[1] + (f" (допуск ±{rule[2]} px)" if rule[2] is not None else "")))
        else:
            fails.append((line + (f"  — больше допуска ±{rule[2]} px из allow.txt" if rule else ""), None))

    n = len(items)
    print(f"проверено элементов: {n} на {len(keys)} страницах × масштабы {', '.join(dprs)}; порог ±{th} px")
    if multi:
        print(f"многострочных (не сравниваются): {len(multi)}")
    if allowed:
        print(f"исключения из allow.txt: {len(allowed)}")
        for line, why in allowed:
            print(f"  ~ {line}\n      причина: {why}")
    if "--all" in flags:
        print("все элементы с отклонениями больше порога:")
        for line, _ in fails + allowed:
            print("  " + line)
    if opt["--json"]:
        with open(opt["--json"], "w", encoding="utf-8") as f:
            json.dump(report, f, ensure_ascii=False, indent=1)
    for m in missing:
        print(f"НЕТ СНИМКА {m} — стенд не открылся (см. вывод shot.mjs выше)")
    for line, _ in fails:
        print(f"КРИВО {line}")
    if fails or missing:
        print(f"центровка: {len(fails)} разъехавшихся, {len(missing)} без снимка")
        sys.exit(1)
    print("центровка: всё ровно")


if __name__ == "__main__":
    main()
