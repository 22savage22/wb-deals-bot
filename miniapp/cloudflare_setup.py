"""One-shot loopback credential handoff. Never logs or displays credentials."""
import json
import re
import secrets
from http.server import BaseHTTPRequestHandler, HTTPServer
from urllib.parse import parse_qs


def main():
    nonce = secrets.token_urlsafe(24)
    credentials = {}
    host = '127.0.0.1:8769'

    class Handler(BaseHTTPRequestHandler):
        def log_message(self, *args):
            pass

        def respond(self, code, body):
            self.send_response(code)
            self.send_header('Content-Type', 'text/html; charset=utf-8')
            self.send_header('Cache-Control', 'no-store')
            self.send_header('Content-Security-Policy', "default-src 'none'; form-action 'self'; frame-ancestors 'none'")
            self.end_headers()
            self.wfile.write(body.encode())

        def do_GET(self):
            if (self.path == '/credential' and self.headers.get('Host') == host
                    and self.headers.get('X-Setup-Nonce') == nonce):
                return self.respond(200, json.dumps(credentials))
            if self.headers.get('Host') != host or self.path != '/' + nonce:
                return self.respond(404, 'Not found')
            self.respond(200, '<title>Local Cloudflare setup</title><form method="post">'
                         '<label>Temporary Cloudflare token <input name="token" type="password" autocomplete="off"></label>'
                         '<button>Use for this session only</button></form>')

        def do_POST(self):
            if (self.headers.get('Host') != host or self.path != '/' + nonce
                    or self.headers.get('Origin') != 'http://' + host):
                return self.respond(403, 'Forbidden')
            length = int(self.headers.get('Content-Length', 0))
            if not 0 < length < 1024:
                return self.respond(400, 'Invalid request')
            token = parse_qs(self.rfile.read(length).decode()).get('token', [''])[0]
            if not re.fullmatch(r'[A-Za-z0-9_-]{35,100}', token):
                return self.respond(400, 'Invalid token')
            if credentials:
                return self.respond(409, 'Already configured')
            credentials['token'] = token
            self.respond(200, 'Credential held in memory for this session only. No file created.')

    print('Local setup: http://' + host + '/' + nonce, flush=True)
    HTTPServer(('127.0.0.1', 8769), Handler).serve_forever()


if __name__ == '__main__':
    main()
