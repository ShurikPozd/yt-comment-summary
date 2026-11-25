# Сервер стендов для замера центровки: раздаёт корень репозитория с той же
# политикой скриптов, что у страниц расширения (script-src 'self').
#   python tools/align/serve.py [порт=8777]
# Подмены «на лету» (файлы в репозитории не меняются):
#   /library/library.html — перед theme-boot.js вставляется заглушка chrome.*
#                           (tools/align/stands/lib-stub.js) с вымышленным каталогом;
#   /sidepanel/stand.html — вся разметка панели (sidepanel.html) со всеми вкладками
#                           сразу и без скриптов панели: только значки (stands/panel.js);
#   /watch                — макет страницы YouTube (stands/youtube.html или,
#                           с ?stand=queue, колонка очереди stands/queue.html):
#                           контент-скриптам нужен путь /watch;
#   /embed/…              — макет нового встроенного плеера «Моей библиотеки» (stands/embed.html);
#   /tools/align/embed-js/<модуль>.js — модуль из корня, где проверка «встроенный плеер —
#                           наш» (рамка внутри страницы chrome-extension://) заменена на «да».
import functools, http.server, os, re, sys

ROOT = os.path.abspath(os.path.join(os.path.dirname(__file__), "..", ".."))
STANDS = os.path.join(ROOT, "tools", "align", "stands")
PORT = int(sys.argv[1]) if len(sys.argv) > 1 else 8777


class H(http.server.SimpleHTTPRequestHandler):
    extensions_map = {
        **http.server.SimpleHTTPRequestHandler.extensions_map,
        ".mjs": "text/javascript",
        ".js": "text/javascript",
        ".wasm": "application/wasm",
    }

    def end_headers(self):
        self.send_header("Content-Security-Policy", "script-src 'self' 'wasm-unsafe-eval'; object-src 'self';")
        self.send_header("Cache-Control", "no-store")
        super().end_headers()

    def log_message(self, *a):
        pass

    def send_html(self, html):
        body = html.encode("utf-8")
        self.send_response(200)
        self.send_header("Content-Type", "text/html; charset=utf-8")
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    def do_GET(self):
        path, _, query = self.path.partition("?")
        if path == "/library/library.html":
            with open(os.path.join(ROOT, "library", "library.html"), encoding="utf-8") as f:
                html = f.read()
            tag = '<script src="../sidepanel/theme-boot.js"></script>'
            return self.send_html(html.replace(tag, '<script src="/tools/align/stands/lib-stub.js"></script>' + tag, 1))
        if path == "/sidepanel/stand.html":
            with open(os.path.join(ROOT, "sidepanel", "sidepanel.html"), encoding="utf-8") as f:
                html = f.read()
            html = re.sub(r"<script[^>]*>\s*</script>", "", html)
            # html.booting прячет пустой экран до ответа скрипта панели — здесь его нет
            html = html.replace('<html lang="ru" class="booting">', '<html lang="ru">', 1)
            show = "<style>.view{display:block!important} .copy-btn.hidden,#tabs.hidden,#collect-bar.hidden{display:flex!important}"
            # панель во всю длину, без внутренней прокрутки — в снимок попадает всё
            show += "html,body,#app{height:auto!important;max-height:none!important;overflow:visible!important}#content{overflow:visible!important;flex:none!important}</style>"
            html = html.replace("</head>", show + "</head>", 1)
            html = html.replace("</body>", '<script type="module" src="/tools/align/stands/panel.js"></script></body>', 1)
            return self.send_html(html)
        if path.startswith("/embed/"):
            with open(os.path.join(STANDS, "embed.html"), encoding="utf-8") as f:
                return self.send_html(f.read())
        m = re.fullmatch(r"/tools/align/embed-js/([\w-]+\.js)", path)
        if m:
            with open(os.path.join(ROOT, m.group(1)), encoding="utf-8") as f:
                js = f.read()
            js = js.replace("location.ancestorOrigins?.[0] === `chrome-extension://${chrome.runtime.id}`", "true")
            body = js.encode("utf-8")
            self.send_response(200)
            self.send_header("Content-Type", "text/javascript; charset=utf-8")
            self.send_header("Content-Length", str(len(body)))
            self.end_headers()
            return self.wfile.write(body)
        if path == "/watch":
            name = "queue.html" if "stand=queue" in query else "youtube.html"
            with open(os.path.join(STANDS, name), encoding="utf-8") as f:
                return self.send_html(f.read())
        return super().do_GET()


http.server.ThreadingHTTPServer(("127.0.0.1", PORT), functools.partial(H, directory=ROOT)).serve_forever()
