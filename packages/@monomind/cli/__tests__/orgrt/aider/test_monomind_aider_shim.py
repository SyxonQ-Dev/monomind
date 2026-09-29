"""Tests for src/orgrt/aider/monomind_aider_shim.py (monoes/monomind#383).

Run with aider's own interpreter (aider-shim-python.test.ts does, and skips
when aider is not installed):

    <aider python> -m unittest discover -s __tests__/orgrt/aider -p 'test_*.py'

No network: the model's replies come from litellm's own `mock_response`
(set per call on the model's extra_params), and the model-info lookup is
stubbed. Everything else — aider's edit-block parsing, file writes, the
confirmation that gates a model-suggested shell command, the command run
itself — is aider's real code.
"""

import json
import os
import subprocess
import sys
import tempfile
import unittest

HERE = os.path.dirname(os.path.abspath(__file__))
SHIM_DIR = os.path.normpath(os.path.join(HERE, "..", "..", "..", "src", "orgrt", "aider"))
sys.path.insert(0, SHIM_DIR)

import monomind_aider_shim as shim  # noqa: E402

# Any value: litellm never sees it (replies are mocked).
NO_KEY = "placeholder"

FAKES = r'''
import json, os
from aider import models

models.model_info_manager.get_model_info = lambda model: {}
_replies = json.loads(os.environ.get("FAKE_AIDER_REPLIES", "[]"))
_orig = getattr(models, "_real_send_completion", None) or models.Model.send_completion
models._real_send_completion = _orig
_seen = []


def send_completion(self, messages, functions, stream, temperature=None):
    _seen.append(messages)
    reply = _replies.pop(0) if _replies else "ok"
    if isinstance(reply, dict) and reply.get("raise") == "auth":
        import litellm
        raise litellm.AuthenticationError(
            message="AuthenticationError: invalid x-api-key", llm_provider="openai", model=self.name
        )
    self.extra_params = dict(self.extra_params or {}, mock_response=reply)
    return _orig(self, messages, functions, stream, temperature)


models.Model.send_completion = send_completion
'''

SHELL_REPLY = "I will create it with a command.\n\n```bash\necho ran > ran.txt\n```\n"
EDIT_REPLY = (
    "Creating the file.\n\nhello.txt\n```\n<<<<<<< SEARCH\n=======\nhello world\n"
    ">>>>>>> REPLACE\n```\n"
)


def install_fakes(replies):
    os.environ["FAKE_AIDER_REPLIES"] = json.dumps(replies)
    ns = {}
    exec(FAKES, ns)  # noqa: S102 — test-only stubs
    return ns["_seen"]


class ShimRun(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.cwd = os.path.join(self.tmp.name, "work")
        self.state = os.path.join(self.tmp.name, "state")
        os.makedirs(self.cwd)
        self.old_cwd = os.getcwd()
        os.environ["OPENAI_API_KEY"] = NO_KEY
        self.events = []

    def tearDown(self):
        os.chdir(self.old_cwd)
        self.tmp.cleanup()

    def emit(self, type_, **fields):
        fields["type"] = type_
        self.events.append(json.loads(json.dumps(fields)))

    def run_shim(self, replies, **req):
        seen = install_fakes(replies)
        base = {
            "prompt": "do it",
            "cwd": self.cwd,
            "state_dir": self.state,
            "access": "full",
            "model": "gpt-4o",
            "max_turns": 5,
        }
        base.update(req)
        self.events = []
        code = shim.run(base, self.emit)
        return code, seen

    def of(self, type_):
        return [e for e in self.events if e["type"] == type_]

    def test_full_mode_runs_a_model_suggested_shell_command(self):
        code, _ = self.run_shim([SHELL_REPLY], access="full")
        self.assertEqual(code, 0)
        self.assertTrue(os.path.exists(os.path.join(self.cwd, "ran.txt")))
        start = [e for e in self.of("tool_start") if e["kind"] == "shell"]
        self.assertEqual(start[0]["input"]["command"], "echo ran > ran.txt")
        end = [e for e in self.of("tool_end") if e["id"] == start[0]["id"]][0]
        self.assertEqual(end["exit_code"], 0)
        self.assertTrue(end["ok"])
        self.assertEqual(self.of("result")[0]["stop_reason"], "end_turn")

    def test_scoped_mode_declines_the_shell_command(self):
        code, _ = self.run_shim([SHELL_REPLY], access="scoped")
        self.assertEqual(code, 0)
        self.assertFalse(os.path.exists(os.path.join(self.cwd, "ran.txt")))
        start = [e for e in self.of("tool_start") if e["kind"] == "shell"]
        self.assertEqual(len(start), 1)
        end = [e for e in self.of("tool_end") if e["id"] == start[0]["id"]][0]
        self.assertFalse(end["ok"])
        self.assertIn("declined", end["output"])
        self.assertNotIn("exit_code", end)

    def test_a_failing_command_reports_its_exit_code(self):
        reply = "Check.\n\n```bash\nexit 7\n```\n"
        self.run_shim([reply], access="full")
        end = [e for e in self.of("tool_end") if "exit_code" in e][0]
        self.assertEqual(end["exit_code"], 7)
        self.assertFalse(end["ok"])

    def test_edit_creating_a_file_is_a_write(self):
        code, _ = self.run_shim([EDIT_REPLY])
        self.assertEqual(code, 0)
        with open(os.path.join(self.cwd, "hello.txt")) as f:
            self.assertEqual(f.read(), "hello world\n")
        start = self.of("tool_start")[0]
        self.assertEqual(start["kind"], "write")
        self.assertEqual(start["input"]["file_path"], os.path.join(self.cwd, "hello.txt"))
        self.assertEqual(start["input"]["content"], "hello world\n")
        self.assertTrue(self.of("tool_end")[0]["ok"])
        text = "".join(e["text"] for e in self.of("text"))
        self.assertIn("Creating the file.", text)

    def test_edit_of_an_existing_file_carries_old_and_new(self):
        with open(os.path.join(self.cwd, "a.txt"), "w") as f:
            f.write("one\n")
        reply = "a.txt\n```\n<<<<<<< SEARCH\none\n=======\ntwo\n>>>>>>> REPLACE\n```\n"
        self.run_shim([reply])
        with open(os.path.join(self.cwd, "a.txt")) as f:
            self.assertEqual(f.read(), "two\n")
        start = self.of("tool_start")[0]
        self.assertEqual(start["kind"], "edit")
        self.assertEqual(start["input"]["old_string"], "one\n")
        self.assertEqual(start["input"]["new_string"], "two\n")

    def test_auth_error_is_an_error_event_and_exit_3(self):
        code, _ = self.run_shim([{"raise": "auth"}])
        self.assertEqual(code, 3)
        err = self.of("error")[0]
        self.assertEqual(err["code"], "auth")
        self.assertIn("AuthenticationError", err["message"])
        self.assertEqual(self.of("result"), [])

    def test_resume_restores_the_conversation_from_the_state_dir(self):
        self.run_shim(["first answer"], prompt="remember the word banana")
        sid = self.of("session")[0]["session_id"]
        self.assertTrue(os.path.isfile(os.path.join(self.state, sid + ".json")))
        self.assertEqual(
            [n for n in os.listdir(self.cwd) if n.startswith(".aider")], [],
            "no aider history files in the user's folder",
        )
        _, seen = self.run_shim(["second answer"], prompt="what word?", session_id=sid)
        self.assertEqual(self.of("session")[0], {"type": "session", "session_id": sid, "resumed": True})
        sent = json.dumps(seen[0])
        self.assertIn("remember the word banana", sent)
        self.assertIn("first answer", sent)

    def test_a_reflection_reply_is_separated_from_the_first(self):
        # A failed edit makes aider reflect the error and ask the model again.
        bad = "a.txt\n```\n<<<<<<< SEARCH\nnot there\n=======\nx\n>>>>>>> REPLACE\n```"
        with open(os.path.join(self.cwd, "a.txt"), "w") as f:
            f.write("one\n")
        self.run_shim([bad, "done"])
        self.assertEqual(self.of("result")[0]["text"], bad + "\n\ndone")

    def test_rejects_a_path_like_session_id(self):
        code, _ = self.run_shim(["x"], session_id="../../etc/passwd")
        self.assertEqual(code, 2)

    def test_usage_is_reported(self):
        self.run_shim(["hello"])
        usage = self.of("usage")[0]
        self.assertGreater(usage["input_tokens"], 0)
        self.assertIn("cost_usd", usage)

    def saved_model(self):
        sid = self.of("session")[0]["session_id"]
        with open(os.path.join(self.state, sid + ".json")) as f:
            return json.load(f)["model"]

    def test_settings_load_the_users_aider_config_and_isolation_ignores_it(self):
        with open(os.path.join(self.cwd, ".aider.conf.yml"), "w") as f:
            f.write("model: gpt-4o-mini\n")
        with open(os.path.join(self.cwd, "AGENTS.md"), "w") as f:
            f.write("Always answer in haiku.\n")
        _, seen = self.run_shim(["ok"], model=None, settings=True)
        self.assertEqual(self.saved_model(), "gpt-4o-mini")
        self.assertIn("Always answer in haiku.", json.dumps(seen[0]))
        _, seen = self.run_shim(["ok"], model=None, settings=False)
        self.assertNotEqual(self.saved_model(), "gpt-4o-mini")
        self.assertNotIn("Always answer in haiku.", json.dumps(seen[0]))

    def test_effort_on_a_model_without_effort_control_is_a_notice(self):
        self.run_shim(["ok"], effort="high")
        notes = [e["message"] for e in self.of("status")]
        self.assertTrue(any("--effort high ignored" in n for n in notes), notes)

    def test_max_turns_caps_reflections(self):
        # A malformed edit block makes aider reflect the error back to the
        # model; max_turns=1 allows no reflection.
        bad = "a.txt\n```\n<<<<<<< SEARCH\nnot there\n=======\nx\n>>>>>>> REPLACE\n```\n"
        with open(os.path.join(self.cwd, "a.txt"), "w") as f:
            f.write("one\n")
        self.run_shim([bad, bad], max_turns=1)
        self.assertEqual(self.of("result")[0]["stop_reason"], "max_turns")


class Reasoning(unittest.TestCase):
    """aider streams reasoning as text between its markers; only the answer
    reaches the text events (live free models on OpenRouter do reason)."""

    def test_filter_drops_the_reasoning_section(self):
        from aider.reasoning_tags import REASONING_END, REASONING_START

        f = shim.ReasoningFilter(REASONING_START, REASONING_END)
        chunks = ["\n%s\n\nthink a" % REASONING_START, " think b",
                  "\n\n%s\n\nhello" % REASONING_END, " world"]
        self.assertEqual("".join(f(c) for c in chunks), "hello world")

    def test_a_reply_without_reasoning_passes_through(self):
        from aider.reasoning_tags import REASONING_END, REASONING_START

        f = shim.ReasoningFilter(REASONING_START, REASONING_END)
        self.assertEqual(f("plain ") + f("answer\n"), "plain answer\n")


class ShimProcess(unittest.TestCase):
    """main(): stdout carries only NDJSON even though aider prints freely."""

    def test_stdout_is_pure_ndjson(self):
        with tempfile.TemporaryDirectory() as tmp:
            cwd = os.path.join(tmp, "w")
            os.makedirs(cwd)
            boot = (
                "import sys; sys.path.insert(0, %r)\n%s\n"
                "import monomind_aider_shim as s; sys.exit(s.main())\n" % (SHIM_DIR, FAKES)
            )
            req = {"prompt": "go", "cwd": cwd, "state_dir": os.path.join(tmp, "s"),
                   "access": "full", "model": "gpt-4o"}
            env = dict(os.environ, FAKE_AIDER_REPLIES=json.dumps([SHELL_REPLY]),
                       OPENAI_API_KEY=NO_KEY)
            p = subprocess.run([sys.executable, "-c", boot], input=json.dumps(req),
                               capture_output=True, text=True, env=env, timeout=120)
            self.assertEqual(p.returncode, 0, p.stderr[-2000:])
            events = [json.loads(line) for line in p.stdout.splitlines()]
            types = [e["type"] for e in events]
            self.assertEqual(types[0], "session")
            self.assertEqual(types[-1], "result")
            self.assertIn("tool_start", types)
            self.assertIn("Running echo ran > ran.txt", p.stderr)

    def test_bad_request_exits_2(self):
        p = subprocess.run([sys.executable, os.path.join(SHIM_DIR, "monomind_aider_shim.py")],
                           input="not json", capture_output=True, text=True, timeout=60)
        self.assertEqual(p.returncode, 2)
        self.assertEqual(json.loads(p.stdout)["type"], "error")


if __name__ == "__main__":
    unittest.main()
