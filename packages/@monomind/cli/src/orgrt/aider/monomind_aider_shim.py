"""monomind <-> aider shim (monoes/monomind#383).

Run with AIDER'S OWN interpreter (the python in the `aider` entry point's
shebang): it imports aider's scripting API, so it needs aider's packages.

Protocol (monomind-owned, not aider's):
  stdin  one JSON request, then EOF:
           {prompt, cwd, state_dir, access: "full"|"scoped", settings: bool,
            model?, effort?, max_turns?, session_id?}
  stdout NDJSON, one event per line:
           {"type":"session","session_id","resumed"}
           {"type":"status","message"}
           {"type":"text","text"}            (the answer; model reasoning is dropped)
           {"type":"tool_start","id","name","kind","input"}
           {"type":"tool_end","id","ok","output","exit_code"?}
           {"type":"usage","input_tokens","output_tokens","cost_usd"}
           {"type":"error","code":"auth"|"quota"|"api"|"runner-error","message"}
           {"type":"result","stop_reason":"end_turn"|"max_turns","text"}
  exit   0 ok, 1 unexpected failure, 2 bad request, 3 provider/API error,
         4 aider could not be imported (the runner falls back to the CLI).

Everything aider itself prints goes to stderr: fd 1 is re-pointed at fd 2
before aider is imported, and the NDJSON goes to a private dup of the
original stdout, so nothing aider (or a command it runs) writes can corrupt
the event stream.

Access: `full` answers every confirmation yes, INCLUDING the ones aider marks
explicit_yes_required (running a model-suggested shell command), which
`--yes-always` answers no. That is what gives coder mode real shell autonomy.
`scoped` answers those no (and never installs packages), reporting each
declined command as a failed shell call; it declines files outside cwd or in .git.

Sessions: the conversation is kept as JSON under `state_dir` (never in the
user's repo), keyed by a shim-minted id; resuming loads it back as aider's
done_messages. aider's own chat/input history logs go there too.
"""

import difflib
import json
import os
import re
import sys
import uuid

# Shipped next to this file; the script's own dir is on sys.path.
from monomind_aider_setup import (
    ReasoningFilter,
    apply_effort,
    as_list,
    git_root_of,
    load_user_config,
    path_in_scope,
)

EXIT_OK, EXIT_FAIL, EXIT_USAGE, EXIT_API, EXIT_IMPORT = 0, 1, 2, 3, 4
SESSION_RE = re.compile(r"^[A-Za-z0-9_-]{1,128}$")
# Questions scoped access always answers no, besides explicit_yes_required.
SCOPED_DENY = ("Run pip install?", "Install playwright?")
# Questions about a file (the subject): scoped access keeps it inside cwd.
PATH_QUESTIONS = ("Create new file?", "Add file to the chat?",
                  "Allow edits to file that has not been added to the chat?")
OUTPUT_CAP = 64 * 1024


class Emitter:
    def __init__(self, stream):
        self.stream = stream

    def __call__(self, type_, **fields):
        fields["type"] = type_
        self.stream.write(json.dumps(fields, ensure_ascii=False) + "\n")
        self.stream.flush()


def _cap(text):
    text = text or ""
    return text if len(text) <= OUTPUT_CAP else text[:OUTPUT_CAP] + "\n[truncated]"


class Tools:
    """Mints ids and emits matched tool_start/tool_end events."""

    def __init__(self, emit):
        self.emit = emit
        self.n = 0

    def start(self, name, kind, input_):
        self.n += 1
        tid = "aider-%d" % self.n
        self.emit("tool_start", id=tid, name=name, kind=kind, input=input_)
        return tid

    def end(self, tid, ok, output, exit_code=None):
        ev = {"id": tid, "ok": bool(ok), "output": _cap(output)}
        if isinstance(exit_code, int):
            ev["exit_code"] = exit_code
        self.emit("tool_end", **ev)

    def once(self, name, kind, input_, ok, output, exit_code=None):
        self.end(self.start(name, kind, input_), ok, output, exit_code)


def make_io_class(InputOutput):
    class ShimIO(InputOutput):
        """Never prompts: every question is answered by the access mode."""

        def __init__(self, full, tools, **kw):
            super().__init__(**kw)
            self.full = full
            self.tools = tools
            self.errors = []
            self.hit_reflection_cap = False
            # Scoped path checks: cwd, and aider's root (set once coder exists).
            self.scope_dir, self.edit_root = kw.get("root") or os.getcwd(), None

        def confirm_ask(
            self,
            question,
            default="y",
            subject=None,
            explicit_yes_required=False,
            group=None,
            allow_never=False,
        ):
            self.num_user_asks += 1
            risky = explicit_yes_required or question.strip() in SCOPED_DENY
            if question.strip() in PATH_QUESTIONS and subject:
                risky = risky or not path_in_scope(self.scope_dir, self.edit_root, subject)
            yes = self.full or not risky
            if not yes and subject and question.startswith("Run shell command"):
                for cmd in subject.splitlines():
                    cmd = cmd.strip()
                    if cmd and not cmd.startswith("#"):
                        self.tools.once(
                            "run_shell_command",
                            "shell",
                            {"command": cmd},
                            False,
                            "declined: shell commands need --access full",
                        )
            hist = "%s %s" % (question.strip(), "y" if yes else "n")
            self.append_chat_history(hist, linebreak=True, blockquote=True)
            return yes

        def prompt_ask(self, question, default="", subject=None):
            return default

        def offer_url(self, url, prompt="Open URL for more info?", allow_never=True):
            return False

        def get_input(self, *args, **kwargs):
            raise EOFError()

        def tool_error(self, message="", strip=True):
            if message:
                self.errors.append(str(message))
            super().tool_error(message, strip)

        def tool_warning(self, message="", strip=True):
            if "reflections allowed" in str(message):
                self.hit_reflection_cap = True
            super().tool_warning(message, strip)

    return ShimIO


def classify_error(err):
    name = type(err).__name__
    text = str(err)
    if name in ("AuthenticationError", "PermissionDeniedError") or re.search(
        r"api[_ ]?key|unauthori[sz]ed|\b401\b|\b403\b", text, re.I
    ):
        return "auth"
    if name in ("RateLimitError", "BudgetExceededError") or re.search(
        r"quota|insufficient.*(balance|credit)|billing", text, re.I
    ):
        return "quota"
    return "api"


def _read(path):
    try:
        with open(path, "r", encoding="utf-8") as f:
            return f.read()
    except (OSError, UnicodeDecodeError):
        return None


def instrument(coder, io, tools, emit, state, run_cmd_modules):
    """Wrap aider's own seams so every text chunk, edit, shell command,
    lint run and commit becomes an NDJSON event."""
    from aider.reasoning_tags import REASONING_END, REASONING_START, remove_reasoning_content

    orig_send = coder.send

    def send(messages, model=None, functions=None):
        streamed = False
        answer = ReasoningFilter(REASONING_START, REASONING_END)
        try:
            for chunk in orig_send(messages, model=model, functions=functions):
                if chunk:
                    streamed = True
                    shown = answer(chunk)
                    if shown and not answer.emitted and state["text"]:
                        # A reflection's reply follows the previous reply.
                        shown = "\n\n" + shown
                    if shown:
                        answer.emitted = True
                        state["text"].append(shown)
                        emit("text", text=shown)
                yield chunk
        except Exception as err:  # noqa: BLE001 — recorded, then aider handles it
            state["error"] = (classify_error(err), "%s: %s" % (type(err).__name__, err))
            raise
        state["error"] = None
        content = remove_reasoning_content(
            coder.partial_response_content or "", coder.reasoning_tag_name
        )
        if not streamed and content:
            content = ("\n\n" if state["text"] else "") + content
            state["text"].append(content)
            emit("text", text=content)

    coder.send = send

    orig_apply = coder.apply_edits

    def edit_path(e):
        if isinstance(e, (tuple, list)):
            return e[0] if e else None
        return getattr(e, "path", None)  # patch_coder's PatchAction

    def apply_edits(edits, **kwargs):
        if kwargs.get("dry_run"):
            return orig_apply(edits, **kwargs)
        paths = []
        for e in edits or []:
            p = edit_path(e)
            if p and p not in paths:
                paths.append(p)
        abs_paths = {p: coder.abs_root_path(p) for p in paths}
        before = {p: _read(abs_paths[p]) for p in paths}
        try:
            res = orig_apply(edits, **kwargs)
        except Exception as err:
            for p in paths:
                tools.once("edit_file", "edit", {"file_path": abs_paths[p]}, False, str(err))
            raise
        for p in paths:
            fp, old, new = abs_paths[p], before[p], _read(abs_paths[p])
            blocks = [e for e in edits if edit_path(e) == p]
            # aider creates a new file empty before applying (allowed_to_edit),
            # so an empty "before" is a write of the whole content too.
            if not old and new is not None:
                tools.once("write_file", "write", {"file_path": fp, "content": new}, True, "")
            elif old is not None and new is None:
                files = [{"file_path": fp, "action": "delete"}]
                tools.once("apply_patch", "patch", {"files": files}, True, "")
            elif (
                len(blocks) == 1
                and isinstance(blocks[0], (tuple, list))
                and len(blocks[0]) == 3
                and all(isinstance(x, str) for x in blocks[0][1:])
                and blocks[0][1]
            ):
                inp = {"file_path": fp, "old_string": blocks[0][1], "new_string": blocks[0][2]}
                tools.once("edit_file", "edit", inp, True, "")
            else:
                diff = "".join(
                    difflib.unified_diff(
                        (old or "").splitlines(True), (new or "").splitlines(True), p, p
                    )
                )
                files = [{"file_path": fp, "action": "update", "diff": diff}]
                tools.once("apply_patch", "patch", {"files": files}, True, "")
        return res

    coder.apply_edits = apply_edits

    for mod in run_cmd_modules:
        orig_run = mod.run_cmd

        def run_cmd(command, verbose=False, error_print=None, cwd=None, _orig=orig_run):
            tid = tools.start("run_shell_command", "shell", {"command": command, "cwd": cwd})
            try:
                status, output = _orig(command, verbose=verbose, error_print=error_print, cwd=cwd)
            except BaseException as err:
                tools.end(tid, False, str(err))
                raise
            tools.end(tid, status == 0, output or "", exit_code=status)
            return status, output

        mod.run_cmd = run_cmd

    linter = getattr(coder, "linter", None)
    if linter is not None:
        orig_lint = linter.run_cmd

        def lint_run_cmd(cmd, rel_fname, code):
            tid = tools.start("lint", "shell", {"command": "%s %s" % (cmd, rel_fname)})
            res = orig_lint(cmd, rel_fname, code)
            tools.end(tid, res is None, getattr(res, "text", "") if res else "")
            return res

        linter.run_cmd = lint_run_cmd

    orig_commit = coder.show_auto_commit_outcome

    def show_auto_commit_outcome(res):
        commit_hash, message = res
        tools.once("git_commit", "other", {"hash": commit_hash, "message": message}, True, "")
        return orig_commit(res)

    coder.show_auto_commit_outcome = show_auto_commit_outcome


def run(req, emit):
    import aider.commands as aider_commands
    from aider import models
    from aider.coders import Coder
    from aider.coders import base_coder
    from aider.io import InputOutput
    from aider.repo import GitRepo

    full = req.get("access") == "full"
    cwd = os.path.abspath(req.get("cwd") or os.getcwd())
    state_dir = req.get("state_dir")
    prompt = req.get("prompt")
    if not state_dir or not isinstance(prompt, str):
        emit("error", code="runner-error", message="shim request needs prompt and state_dir")
        return EXIT_USAGE
    os.chdir(cwd)
    os.makedirs(state_dir, mode=0o700, exist_ok=True)
    # Marks every process this turn spawns as an agent's (agent-context.ts).
    os.environ["AI_AGENT"] = "aider"
    os.environ["MONOMIND_AIDER"] = "1"

    resume = req.get("session_id")
    sid = resume or uuid.uuid4().hex
    if not SESSION_RE.match(sid):
        emit("error", code="runner-error", message="invalid session id")
        return EXIT_USAGE
    hist_path = os.path.join(state_dir, sid + ".json")
    done_messages = []
    if resume:
        saved = _read(hist_path)
        if saved is None:
            emit("status", message="aider: no saved history for session %s; starting fresh" % sid)
        else:
            try:
                done_messages = json.loads(saved).get("messages") or []
            except ValueError:
                emit("status", message="aider: session %s history unreadable; starting fresh" % sid)
    emit("session", session_id=sid, resumed=bool(done_messages))
    emit("status", message="aider: MCP servers are not supported on this runtime")

    git_root = git_root_of(cwd)
    conf = load_user_config(cwd, git_root) if req.get("settings") else {}

    tools = Tools(emit)
    ShimIO = make_io_class(InputOutput)
    io = ShimIO(
        full,
        tools,
        pretty=False,
        yes=None,
        fancy_input=False,
        chat_history_file=os.path.join(state_dir, sid + ".chat.history.md"),
        input_history_file=os.path.join(state_dir, sid + ".input.history"),
        root=cwd,
    )

    model_name = req.get("model") or conf.get("model") or os.environ.get("AIDER_MODEL")
    if not model_name:
        try:
            from aider.onboarding import try_to_select_default_model

            model_name = try_to_select_default_model()
        except Exception:  # noqa: BLE001
            model_name = None
    main_model = models.Model(
        model_name or models.DEFAULT_MODEL_NAME,
        weak_model=conf.get("weak-model"),
        editor_model=conf.get("editor-model"),
    )
    apply_effort(main_model, req.get("effort"), emit)

    repo = None
    if git_root:
        try:
            repo = GitRepo(io, [], git_root, models=main_model.commit_message_models())
        except Exception:  # noqa: BLE001 — not a usable repo: run without git
            repo = None

    read_only = [str(p) for p in as_list(conf.get("read"))]
    if req.get("settings"):
        for name in ("AGENTS.md", "CONVENTIONS.md"):
            if os.path.isfile(os.path.join(cwd, name)):
                read_only.append(name)
    read_only = [os.path.abspath(p) for p in dict.fromkeys(read_only) if os.path.isfile(p)]

    auto_commits = bool(conf.get("auto-commits", False))
    coder = Coder.create(
        main_model=main_model,
        edit_format=conf.get("edit-format"),
        io=io,
        repo=repo,
        fnames=[],
        read_only_fnames=read_only,
        done_messages=done_messages,
        auto_commits=auto_commits,
        dirty_commits=auto_commits and bool(conf.get("dirty-commits", True)),
        use_git=repo is not None,
        stream=True,
        suggest_shell_commands=True,
        detect_urls=False,
        auto_lint=bool(conf.get("auto-lint", True)),
        auto_test=bool(conf.get("auto-test", False)),
        test_cmd=conf.get("test-cmd"),
        map_tokens=int(conf.get("map-tokens", 1024)),
    )
    io.edit_root = coder.root
    max_turns = req.get("max_turns")
    if isinstance(max_turns, int) and max_turns > 0:
        coder.max_reflections = max_turns - 1

    state = {"text": [], "error": None}
    instrument(coder, io, tools, emit, state, [base_coder, aider_commands])
    if not full:
        # No aider /commands (/run, /git, ...) from the prompt in scoped mode;
        # file mentions are still picked up as they would be.
        def preproc(inp):
            if inp:
                coder.check_for_file_mentions(inp)
            return inp

        coder.preproc_user_input = preproc

    try:
        coder.run(with_message=prompt)
    finally:
        messages = list(coder.done_messages) + list(coder.cur_messages)
        tmp = hist_path + ".tmp"
        with open(tmp, "w", encoding="utf-8") as f:
            json.dump({"v": 1, "cwd": cwd, "model": main_model.name, "messages": messages}, f)
        os.replace(tmp, hist_path)
        emit(
            "usage",
            input_tokens=int(coder.total_tokens_sent + coder.message_tokens_sent),
            output_tokens=int(coder.total_tokens_received + coder.message_tokens_received),
            cost_usd=float(coder.total_cost or 0.0),
        )

    if state["error"]:
        code, message = state["error"]
        emit("error", code=code, message=message)
        return EXIT_API
    stop = "max_turns" if io.hit_reflection_cap else "end_turn"
    emit("result", stop_reason=stop, text="".join(state["text"]))
    return EXIT_OK


def main():
    out = os.fdopen(os.dup(1), "w", encoding="utf-8")
    os.dup2(2, 1)
    sys.stdout = sys.stderr
    emit = Emitter(out)
    try:
        req = json.loads(sys.stdin.read() or "{}")
        if not isinstance(req, dict):
            raise ValueError("request is not an object")
    except ValueError as err:
        emit("error", code="runner-error", message="bad shim request: %s" % err)
        return EXIT_USAGE
    null = os.open(os.devnull, os.O_RDONLY)
    os.dup2(null, 0)
    sys.stdin = open(os.devnull, "r")
    try:
        import aider  # noqa: F401
        from aider.coders import Coder  # noqa: F401
    except Exception as err:  # noqa: BLE001
        emit("error", code="import", message="cannot import aider: %s" % err)
        return EXIT_IMPORT
    try:
        return run(req, emit)
    except Exception as err:  # noqa: BLE001
        import traceback

        traceback.print_exc()
        emit("error", code="runner-error", message="%s: %s" % (type(err).__name__, err))
        return EXIT_FAIL


if __name__ == "__main__":
    code = main()
    # Skip interpreter shutdown: aider/litellm leave non-daemon threads
    # (summarizer, cache warming, logging) that can hold the exit for long
    # after the result is out. Everything that matters is flushed here.
    sys.stderr.flush()
    os._exit(code)
