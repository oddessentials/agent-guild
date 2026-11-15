import json
import logging
import threading
import urllib.request
import uuid
from collections import deque

logger = logging.getLogger(__name__)

HEARTBEAT_SECONDS = 30
QUEUE_LIMIT = 1000
COMMAND_LIMIT = 500
DEFAULT_URL = "http://127.0.0.1:47821"
HOOKS = (
    "on_session_start", "on_session_end", "on_session_finalize", "on_session_delete",
    "pre_llm_call", "pre_tool_call", "post_tool_call", "subagent_start", "subagent_stop",
    "pre_approval_request", "post_approval_response",
    "on_human_input_request", "on_human_input_resolved",
)
FIELDS = (
    "session_id", "platform", "tool_name", "tool_call_id", "turn_id",
    "completed", "failed", "interrupted", "parent_session_id", "child_session_id",
    "child_role", "child_status", "request_id", "kind", "choice", "outcome", "reason",
)
# Reports go to the manager on this machine only: never through a proxy from the environment, which would get the
# report token and what is reported and could not reach the manager. Hermes's own requests keep their proxy settings.
LOCAL = urllib.request.build_opener(urllib.request.ProxyHandler({}))


def _secret(name):
    try:
        from agent.secret_scope import get_secret
        return get_secret(name)
    except Exception:
        return None


def _settings(path):
    try:
        with open(path, encoding="utf-8") as file:
            lines = file.read().split("\n")
    except Exception:
        return None, None
    url = lines[2].strip() if len(lines) > 2 else ""
    return lines[0].strip() or None, (url or DEFAULT_URL).rstrip("/")


def _redact(text, limit=None):
    try:
        from agent.redact import redact_sensitive_text
        redacted = redact_sensitive_text(text, force=True)
    except Exception:
        return None
    if not isinstance(redacted, str):
        return None
    return redacted[:limit] if limit else redacted


class Reporter:
    def __init__(self):
        self.lock = threading.Lock()
        self.wake = threading.Event()
        self.events = deque(maxlen=QUEUE_LIMIT)
        self.seq = 0
        self.instance = uuid.uuid4().hex
        self.token_file = None
        self.open = {"sessions": {}, "working": set(), "subagents": {}, "tools": {}, "waits": {}}
        self.turns = {}
        self.settled = True
        self.thread = None
        self.down = False
        self.stopped = False

    def _track(self, name, kw, data):
        sid, tool, child, request = kw.get("session_id"), kw.get("tool_call_id"), kw.get("child_session_id"), kw.get("request_id")
        o = self.open
        turn = kw.get("turn_id")
        if not sid and turn in self.turns:
            sid = data["session_id"] = self.turns[turn]
        elif sid and turn and name in ("pre_llm_call", "pre_tool_call"):
            self.turns[turn] = sid
        ended = child if name == "subagent_stop" else sid if name in ("on_session_end", "on_session_finalize", "on_session_delete") else None
        if ended:
            self.turns = {t: s for t, s in self.turns.items() if s != ended}
        call = f"{sid or ''}:{tool}" if tool else None
        if sid and name not in ("on_session_finalize", "on_session_delete") and sid not in o["subagents"]:
            session = o["sessions"].setdefault(sid, {})
            if name in ("on_session_start", "pre_llm_call") and isinstance(kw.get("platform"), str):
                session["platform"] = kw["platform"]
        if name == "on_session_end" and sid:
            o["working"].discard(sid)
        elif name in ("on_session_finalize", "on_session_delete") and sid:
            o["sessions"].pop(sid, None)
            o["working"].discard(sid)
        elif name == "pre_llm_call" and sid:
            o["working"].add(sid)
        elif name == "pre_tool_call":
            if sid:
                o["working"].add(sid)
            if call:
                o["tools"][call] = {"session_id": sid, "tool_name": kw.get("tool_name")}
        elif name == "post_tool_call" and call:
            o["tools"].pop(call, None)
        elif name == "subagent_start" and child:
            o["subagents"][child] = {k: data[k] for k in ("parent_session_id", "child_role", "child_goal") if k in data}
        elif name == "subagent_stop" and child:
            o["subagents"].pop(child, None)
            o["working"].discard(child)
        elif name == "pre_approval_request" and call:
            o["waits"][f"approval:{call}"] = {"session_id": sid}
        elif name == "post_approval_response" and call:
            o["waits"].pop(f"approval:{call}", None)
        elif name == "on_human_input_request" and request:
            o["waits"][f"input:{request}"] = {"session_id": sid}
        elif name == "on_human_input_resolved" and request:
            o["waits"].pop(f"input:{request}", None)

    def _data(self, name, kw):
        data = {k: kw[k] for k in FIELDS if isinstance(kw.get(k), (str, int, float, bool))}
        args = kw.get("args")
        texts = (
            ("command", args.get("command") if isinstance(args, dict) else None, COMMAND_LIMIT),
            ("child_goal", kw.get("child_goal"), None),
        )
        for key, text, limit in texts:
            redacted = _redact(text, limit) if isinstance(text, str) else None
            if redacted is not None:
                data[key] = redacted
        return data

    def handle(self, name, kw):
        data = self._data(name, kw)
        with self.lock:
            if self.stopped:
                return
            self.token_file = _secret("AGENT_GUILD_HERMES_TOKEN_FILE") or self.token_file
            self._track(name, kw, data)
            self.seq += 1
            self.events.append({"seq": self.seq, "event": name, "data": data})
            self.settled = False
            if self.thread is None:
                self.thread = threading.Thread(target=self._run, name="agent-guild-reporter", daemon=True)
                self.thread.start()
        self.wake.set()

    def _take(self):
        with self.lock:
            messages = list(self.events)
            self.events.clear()
            o = self.open
            snapshot = {
                "sessions": {k: dict(v) for k, v in o["sessions"].items()},
                "working": sorted(o["working"]),
                "subagents": {k: dict(v) for k, v in o["subagents"].items()},
                "tools": {k: dict(v) for k, v in o["tools"].items()},
                "waits": {k: dict(v) for k, v in o["waits"].items()},
            }
            busy = any(snapshot.values())
            if busy or not self.settled:
                self.seq += 1
                messages.append({"seq": self.seq, "open": snapshot})
                self.settled = not busy
            return messages, self.token_file, self.stopped

    def _run(self):
        while True:
            self.wake.wait(None if self.settled else HEARTBEAT_SECONDS)
            self.wake.clear()
            messages, path, final = self._take()
            token, url = _settings(path) if messages else (None, None)
            if token:
                self._post(url, token, messages)
            if final:
                return

    def stop(self):
        with self.lock:
            self.stopped = True
            self.events.clear()
            for items in self.open.values():
                items.clear()
            self.turns.clear()
            self.settled = False
        self.wake.set()

    def _post(self, url, token, messages):
        body = json.dumps({"instance": self.instance, "messages": messages}).encode("utf-8")
        request = urllib.request.Request(f"{url}/api/v1/hermes/hook", data=body, method="POST", headers={
            "content-type": "application/json", "x-agent-guild-report-token": token,
        })
        try:
            with LOCAL.open(request, timeout=10) as response:
                response.read()
            self.down = False
        except Exception as exc:
            if not self.down:
                logger.warning("agent-guild: cannot report to Agent Guild at %s (%s)", url, exc)
            self.down = True


def register(ctx):
    reporter = Reporter()

    def callback(name):
        def hook(**kw):
            try:
                reporter.handle(name, kw)
            except Exception:
                pass
            return None
        return hook

    for name in HOOKS:
        ctx.register_hook(name, callback(name))
    ctx.on_unload(reporter.stop)
