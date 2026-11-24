# Перебор величины сдвига: для каждого k подставляет его в шаблон CSS, снимает
# страницы и считает отклонения у подходящих элементов.
#   python tools/align/opt.py <ключ[,ключ…]> "<regex элементов>" "<CSS с {k}>" k1 k2 … [--dprs 1,1.25,1.5,2]
# Например:
#   python tools/align/opt.py lib-triage "t-btn" ".t-btn > span{position:relative;top:{k}px}" 0 -1 -2
# Печатает по каждому k сумму и худшее отклонение (текст и значок, css px) и лучший k.
# Сервер стендов должен быть запущен: python tools/align/serve.py 8777
# Помните: Chrome округляет сдвиги значков и отступы до целых css px — дробные k
# обычно дают то же, что ближайшее целое.
import os, re, subprocess, sys, tempfile

from pixan import measure

HERE = os.path.dirname(os.path.abspath(__file__))


def main():
    sys.stdout.reconfigure(encoding="utf-8")
    args = sys.argv[1:]
    dprs = "1,1.25,1.5,2"
    if "--dprs" in args:
        i = args.index("--dprs")
        dprs = args[i + 1]
        del args[i : i + 2]
    pages, rx, tpl, ks = args[0].split(","), re.compile(args[1]), args[2], args[3:]
    rows = []
    with tempfile.TemporaryDirectory() as tmp:
        for k in ks:
            css = os.path.join(tmp, "opt.css")
            with open(css, "w", encoding="utf-8") as f:
                f.write(tpl.replace("{k}", k))
            out = os.path.join(tmp, "k" + re.sub(r"\W", "_", k))
            subprocess.run(["node", "shot.mjs", out, dprs, *pages], cwd=HERE, env={**os.environ, "ALIGN_CSS": css}, check=False)
            total, worst, n = 0.0, 0.0, 0
            for f in sorted(os.listdir(out)):
                if not f.endswith(".json"):
                    continue
                base = os.path.join(out, f[:-5])
                for r in measure(base + ".png", base + ".json"):
                    if r["bc"] is None or not rx.search(f"{f.split('@')[0]} {r['el']} «{r['text']}»"):
                        continue
                    v = [abs(r["bc"])] + ([abs(r["dd"])] if r["dd"] is not None else [])
                    total += sum(v)
                    worst = max(worst, *v)
                    n += 1
            rows.append((k, total, worst, n))
            print(f"k={k:>8}  сумма {total:6.2f}  худшее {worst:5.2f}  замеров {n}", flush=True)
    best = min(rows, key=lambda r: (round(r[2], 2), r[1]))
    print(f"лучший k={best[0]} (худшее {best[2]:.2f}, сумма {best[1]:.2f})")


if __name__ == "__main__":
    main()
