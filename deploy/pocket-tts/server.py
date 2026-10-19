"""Speech server for Kyutai Pocket TTS with a fixed pool of worker processes.

`pocket-tts serve` holds one model and its generation is not thread-safe, so two calls speaking at
once would share it. Here every worker process owns its own model; a request waits briefly for a
free worker and otherwise gets 503, so the agent falls back to another voice instead of stuttering.

Sessions let the agent decide per call: a call that gets a session speaks with this voice for its
whole length, a call that does not (all sessions taken) uses the fallback voice from the start.
Measured 2026-10-19 on an i9-10900K, 2 threads per worker: 4 workers generating at once still ran
1.3x faster than real time, 6 did not keep up. A caller mostly listens, so a session holds a worker
only part of the time and there are more sessions than workers.

Endpoints:
  POST   /tts             {"text": "...", "voice": "juergen"?} -> raw s16le mono PCM, chunked;
                          the sample rate is in X-Sample-Rate
  POST   /sessions        -> 201 {"id": "..."} or 503 when all sessions are taken
  DELETE /sessions/<id>   -> 204
  GET    /health          -> pool and session counts
"""

import json
import logging
import multiprocessing as mp
import os
import queue
import secrets
import signal
import sys
import threading
import time
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

def env(name: str, default: str) -> str:
    """An empty variable counts as unset: compose passes `${X:-}` through as ''."""
    return os.environ.get(name) or default


LANGUAGE = env("POCKET_LANGUAGE", "german")
DEFAULT_VOICE = env("POCKET_VOICE", "juergen")
WORKERS = int(env("POCKET_WORKERS", "4"))
THREADS = int(env("POCKET_THREADS", "2"))
MAX_SESSIONS = int(env("POCKET_MAX_SESSIONS", str(WORKERS * 2)))
# A session the agent never released (crash, killed container) frees itself after this.
SESSION_TTL_S = float(env("POCKET_SESSION_TTL_S", "3600"))
# Longer than this for a free worker and the agent is better off with its fallback voice.
WORKER_WAIT_S = float(env("POCKET_WORKER_WAIT_S", "1.0"))
HOST = env("POCKET_HOST", "127.0.0.1")
PORT = int(env("POCKET_PORT", "8090"))

log = logging.getLogger("pocket-server")


def worker_main(conn, stop):
    import numpy as np
    import torch

    torch.set_num_threads(THREADS)
    from pocket_tts import TTSModel

    model = TTSModel.load_model(language=LANGUAGE)
    states = {DEFAULT_VOICE: model.get_state_for_audio_prompt(DEFAULT_VOICE)}
    conn.send(model.sample_rate)
    while True:
        job = conn.recv()
        if job is None:
            return
        text, voice = job
        stop.clear()
        try:
            if voice not in states:
                states[voice] = model.get_state_for_audio_prompt(voice)
            for chunk in model.generate_audio_stream(states[voice], text, stop=stop):
                pcm = (np.clip(chunk.numpy(), -1.0, 1.0) * 32767).astype("<i2").tobytes()
                conn.send(("audio", pcm))
                if stop.is_set():
                    break
            conn.send(("done", None))
        except Exception as error:  # noqa: BLE001 - reported to the request, the worker lives on
            conn.send(("error", str(error)))


class Worker:
    def __init__(self, ctx):
        self.conn, child = ctx.Pipe()
        self.stop = ctx.Event()
        self.process = ctx.Process(target=worker_main, args=(child, self.stop), daemon=True)
        self.process.start()
        self.sample_rate = 0

    def wait_ready(self):
        self.sample_rate = self.conn.recv()


class Pool:
    def __init__(self):
        ctx = mp.get_context("spawn")
        self.idle = queue.Queue()
        # Started together, so the models load in parallel.
        self.workers = [Worker(ctx) for _ in range(WORKERS)]
        for worker in self.workers:
            worker.wait_ready()
            self.idle.put(worker)
        self.sample_rate = self.workers[0].sample_rate
        self.sessions = {}
        self.lock = threading.Lock()

    def busy(self):
        return len(self.workers) - self.idle.qsize()

    def open_session(self):
        now = time.monotonic()
        with self.lock:
            for sid, expires in list(self.sessions.items()):
                if expires < now:
                    del self.sessions[sid]
            if len(self.sessions) >= MAX_SESSIONS:
                return None
            sid = secrets.token_hex(8)
            self.sessions[sid] = now + SESSION_TTL_S
            return sid

    def close_session(self, sid):
        with self.lock:
            self.sessions.pop(sid, None)


class Handler(BaseHTTPRequestHandler):
    protocol_version = "HTTP/1.1"
    pool: Pool

    def log_message(self, fmt, *args):  # request lines would log nothing useful, texts never
        pass

    def reply_json(self, status, body):
        data = json.dumps(body).encode()
        self.send_response(status)
        self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", str(len(data)))
        self.end_headers()
        self.wfile.write(data)

    def do_GET(self):
        if self.path != "/health":
            return self.reply_json(404, {"error": "not found"})
        pool = self.pool
        with pool.lock:
            sessions = len(pool.sessions)
        self.reply_json(
            200,
            {
                "workers": len(pool.workers),
                "busy": pool.busy(),
                "sessions": sessions,
                "maxSessions": MAX_SESSIONS,
                "sampleRate": pool.sample_rate,
            },
        )

    def do_DELETE(self):
        if not self.path.startswith("/sessions/"):
            return self.reply_json(404, {"error": "not found"})
        self.pool.close_session(self.path.removeprefix("/sessions/"))
        self.send_response(204)
        self.send_header("Content-Length", "0")
        self.end_headers()

    def do_POST(self):
        length = int(self.headers.get("Content-Length") or 0)
        body = self.rfile.read(length) if length else b""
        if self.path == "/sessions":
            sid = self.pool.open_session()
            if sid is None:
                return self.reply_json(503, {"error": "all sessions taken"})
            return self.reply_json(201, {"id": sid})
        if self.path != "/tts":
            return self.reply_json(404, {"error": "not found"})
        try:
            request = json.loads(body or b"{}")
            text = str(request["text"]).strip()
        except (ValueError, KeyError):
            return self.reply_json(400, {"error": 'body must be JSON with "text"'})
        if not text:
            return self.reply_json(400, {"error": "empty text"})
        voice = str(request.get("voice") or DEFAULT_VOICE)
        try:
            worker = self.pool.idle.get(timeout=WORKER_WAIT_S)
        except queue.Empty:
            return self.reply_json(503, {"error": "no free worker"})
        try:
            self.stream(worker, text, voice)
        finally:
            self.pool.idle.put(worker)

    def stream(self, worker, text, voice):
        worker.conn.send((text, voice))
        started = False
        try:
            while True:
                kind, payload = worker.conn.recv()
                if kind == "error":
                    if not started:
                        self.reply_json(500, {"error": payload})
                    return
                if not started:
                    self.send_response(200)
                    self.send_header("Content-Type", "audio/pcm")
                    self.send_header("X-Sample-Rate", str(self.pool.sample_rate))
                    self.send_header("Transfer-Encoding", "chunked")
                    self.end_headers()
                    started = True
                if kind == "done":
                    self.wfile.write(b"0\r\n\r\n")
                    return
                self.wfile.write(b"%x\r\n%s\r\n" % (len(payload), payload))
                self.wfile.flush()
        except (BrokenPipeError, ConnectionResetError):
            # The agent cut the answer short: stop generating, then drain to the worker's "done".
            worker.stop.set()
            while worker.conn.recv()[0] == "audio":
                pass
            self.close_connection = True


def main():
    logging.basicConfig(level=logging.INFO, format="%(asctime)s %(levelname)s %(message)s")
    Handler.pool = Pool()
    server = ThreadingHTTPServer((HOST, PORT), Handler)
    server.daemon_threads = True
    log.info(
        "listening on %s:%d, %d workers x %d threads, %d sessions, language %s, voice %s",
        HOST, PORT, WORKERS, THREADS, MAX_SESSIONS, LANGUAGE, DEFAULT_VOICE,
    )
    # As PID 1 in a container, Python ignores SIGTERM unless it has a handler; podman would wait
    # 10 s and kill. Exiting lets the daemon worker processes go down with us.
    signal.signal(signal.SIGTERM, lambda *_: sys.exit(0))
    server.serve_forever()


if __name__ == "__main__":
    main()
