"""User setup, effort and reply-text helpers for the monomind aider shim
(monoes/monomind#383).

Split out of monomind_aider_shim.py (file-size rule); shipped beside it.
"""

import json
import os

THINKING_TOKENS = {"low": 4096, "medium": 8192, "high": 16384, "xhigh": 24576, "max": 32768}
REASONING_EFFORT = {"low": "low", "medium": "medium", "high": "high", "xhigh": "high", "max": "high"}


def load_user_config(cwd, git_root):
    """The user's .aider.conf.yml values (home, then git root, then cwd; the
    later file wins — aider's own precedence) and their .env files."""
    conf = {}
    try:
        import yaml
    except ImportError:
        return conf
    names = [os.path.join(os.path.expanduser("~"), ".aider.conf.yml")]
    if git_root:
        names.append(os.path.join(git_root, ".aider.conf.yml"))
    names.append(os.path.join(cwd, ".aider.conf.yml"))
    seen = set()
    for name in names:
        real = os.path.realpath(name)
        if real in seen or not os.path.isfile(real):
            continue
        seen.add(real)
        try:
            with open(real, "r", encoding="utf-8") as f:
                data = yaml.safe_load(f) or {}
        except Exception:  # noqa: BLE001 — a broken config file is skipped
            continue
        if isinstance(data, dict):
            conf.update(data)
    try:
        from dotenv import load_dotenv

        # Never over an explicit env value; the nearest .env wins otherwise.
        for d in [cwd, git_root, os.path.expanduser("~")]:
            if d and os.path.isfile(os.path.join(d, ".env")):
                load_dotenv(os.path.join(d, ".env"), override=False)
    except ImportError:
        pass
    for pair in as_list(conf.get("api-key")):
        provider, _, key = str(pair).partition("=")
        if provider and key:
            os.environ["%s_API_KEY" % provider.strip().upper()] = key.strip()
    for pair in as_list(conf.get("set-env")):
        k, _, v = str(pair).partition("=")
        if k and v:
            os.environ[k.strip()] = v.strip()
    return conf


def as_list(v):
    if v is None:
        return []
    return v if isinstance(v, list) else [v]


def apply_effort(model, effort, emit):
    if not effort:
        return
    accepts = getattr(model, "accepts_settings", None) or []
    if "reasoning_effort" in accepts and effort != "off":
        model.set_reasoning_effort(REASONING_EFFORT[effort])
    elif "thinking_tokens" in accepts:
        model.set_thinking_tokens(0 if effort == "off" else THINKING_TOKENS[effort])
    elif effort != "off":
        emit("status", message="aider: --effort %s ignored (model %s has no effort control)"
             % (effort, model.name))


def load_session(path, cwd):
    """(messages, status note, other cwd) for resuming the conversation saved
    at `path`; a session saved under another cwd is not loaded."""
    try:
        with open(path, "r", encoding="utf-8") as f:
            data = json.load(f)
    except OSError:
        return [], "aider: no saved history for session %s; starting fresh", None
    except ValueError:
        return [], "aider: session %s history unreadable; starting fresh", None
    saved = data.get("cwd") if isinstance(data, dict) else None
    if saved and os.path.realpath(saved) != os.path.realpath(cwd):
        return [], None, saved
    return (data.get("messages") if isinstance(data, dict) else None) or [], None, None


def path_in_scope(scope_dir, edit_root, path):
    """Whether `path` (relative to aider's root `edit_root`, or absolute) is
    inside `scope_dir` after symlinks and outside any .git dir."""
    base = os.path.realpath(scope_dir)
    rel = os.path.relpath(os.path.realpath(os.path.join(edit_root or base, path)), base)
    parts = rel.split(os.sep)
    return parts[0] != ".." and ".git" not in parts


def git_root_of(cwd):
    d = os.path.abspath(cwd)
    while True:
        if os.path.exists(os.path.join(d, ".git")):
            return d
        parent = os.path.dirname(d)
        if parent == d:
            return None
        d = parent


class ReasoningFilter:
    """Drops the reasoning section aider puts into its streamed text.

    aider streams a model's reasoning as ordinary text between its
    REASONING_START / REASONING_END markers (each whole within one chunk);
    only the answer belongs in the reply. One filter per model response.
    """

    def __init__(self, start, end):
        self.start, self.end = start, end
        self.inside = False
        self.shown = False
        self.emitted = False  # set by the shim once this response shows text

    def __call__(self, chunk):
        out = []
        while chunk:
            marker = self.end if self.inside else self.start
            i = chunk.find(marker)
            if i < 0:
                if not self.inside:
                    out.append(chunk)
                break
            if not self.inside:
                out.append(chunk[:i])
            chunk = chunk[i + len(marker):]
            self.inside = not self.inside
        text = "".join(out)
        if not self.shown:
            # The markers come wrapped in blank lines; the answer does not
            # start with them.
            text = text.lstrip()
            self.shown = bool(text)
        return text
