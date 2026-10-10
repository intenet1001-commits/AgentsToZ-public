"""페르소나 래퍼 검사. 이 스크립트를 검증하는 테스트가 **하나도 없었다**(감사 2026-10-06).

1.5.0부터 `scripts/persona-tests.py`는 공통 러너(`personas`)를 부르는 얇은 래퍼다. 같은 규칙을
같은 강도로 지키는지 본다 — 이름만으로는 통과하지 않음, 화면 근거는 스크립트로 실행, 경로 탈출·
심링크 거부, 실패 전파, 화면 근거 없음 표기. 실행은 러너의 `execute`를 가로채서 본다.
"""
from __future__ import annotations

import importlib.util
import json
from pathlib import Path
import sys
import tempfile
import unittest
from unittest.mock import patch

sys.dont_write_bytecode = True
SCRIPT = Path(__file__).resolve().parents[2] / "scripts/persona-tests.py"
spec = importlib.util.spec_from_file_location("persona_tests", SCRIPT)
pt = importlib.util.module_from_spec(spec)
spec.loader.exec_module(pt)


def passed(*_args, **_kwargs):
    return {"state": "passed", "exitCode": 0, "output": "", "durationSeconds": 0}


class PersonaRunnerTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory(prefix="persona-tests-")
        self.root = Path(self.temp.name).resolve()
        (self.root / "tests/personas").mkdir(parents=True)

    def tearDown(self):
        self.temp.cleanup()

    def catalog(self, personas):
        (self.root / "tests/personas/catalog.json").write_text(
            json.dumps({"schemaVersion": 1, "personas": personas}), encoding="utf-8")

    def touch(self, name):
        (self.root / "tests" / name).write_text("// fixture\n", encoding="utf-8")

    def run_main(self, *argv):
        return pt.main(["--root", str(self.root), *argv])

    def test_the_wrapper_uses_the_common_runner(self):
        # 규칙은 공통 러너 한 곳에만 있다 — 래퍼가 다시 구현하면 두 벌이 어긋난다.
        self.assertEqual(pt.RUNNER_PATH, SCRIPT.parent / "agentstoz-maintainer.py")
        self.assertTrue(callable(pt.runner.run_personas))

    def test_a_label_alone_never_passes(self):
        # `all([])` 가 True 라서, 이름만 추가한 페르소나가 서브프로세스 0회로 통과했다 —
        # 「통과한 관점 수」가 그 순간 거짓이 된다.
        self.catalog([{"id": "ghost", "goal": "증거 없음", "tests": []}])
        with self.assertRaisesRegex(ValueError, "a label alone never passes"):
            self.run_main()
        self.catalog([{"id": "ghost", "goal": "증거 없음"}])
        with self.assertRaisesRegex(ValueError, "a label alone never passes"):
            self.run_main()

    def test_a_screen_script_runs_as_a_script_not_as_a_unit_test(self):
        # `.test.ts` 하드 필터가 이미 있던 Playwright 자산을 원천 차단하고 있었다.
        self.touch("screen-check.mjs")
        self.touch("contract.test.ts")
        self.catalog([{"id": "p", "goal": "g", "tests": ["contract.test.ts",
                                                          {"file": "screen-check.mjs", "args": ["--fast"], "env": {"X": "1"}}]}])
        calls = []

        def fake(argv, cwd, timeout, env=None):
            calls.append((argv, (env or {}).get("X"), timeout))
            return passed()

        with patch.object(pt.runner, "execute", fake):
            self.assertEqual(self.run_main(), 0)
        self.assertIn((["bun", "test", "./tests/contract.test.ts"], None, 180), calls)
        self.assertIn((["bun", "tests/screen-check.mjs", "--fast"], "1", 600), calls)

    def test_shared_evidence_runs_once_and_counts_for_every_persona(self):
        self.touch("shared.test.ts")
        self.catalog([{"id": "a", "goal": "g", "tests": ["shared.test.ts"]},
                      {"id": "b", "goal": "g", "tests": ["shared.test.ts"]}])
        calls, printed = [], []
        with patch.object(pt.runner, "execute", lambda argv, *a, **k: calls.append(argv) or passed()), \
             patch("builtins.print", lambda *args, **kwargs: printed.append(" ".join(str(a) for a in args))):
            self.assertEqual(self.run_main(), 0)
        self.assertEqual(calls, [["bun", "test", "./tests/shared.test.ts"]])
        self.assertEqual(sorted(line.split()[2] for line in printed if line.startswith("PERSONA PASS")), ["a", "b"])

    def test_inline_runs_write_no_second_report(self):
        # 이 래퍼는 `persona` 프로필 검사 안에서 돈다 — 바깥 실행이 잠금과 보고서를 가진다.
        self.touch("contract.test.ts")
        self.catalog([{"id": "p", "goal": "g", "tests": ["contract.test.ts"]}])
        with patch.object(pt.runner, "execute", passed):
            self.assertEqual(self.run_main(), 0)
        self.assertFalse((self.root / ".agentstoz/maintainer").exists())

    def test_path_escapes_and_links_are_still_refused(self):
        self.catalog([{"id": "p", "goal": "g", "tests": ["../outside.test.ts"]}])
        with self.assertRaisesRegex(ValueError, "Unsafe test path"):
            self.run_main()
        self.catalog([{"id": "p", "goal": "g", "tests": ["missing.mjs"]}])
        with self.assertRaisesRegex(ValueError, "Missing or linked test"):
            self.run_main()
        (self.root / "tests/real.test.ts").write_text("// fixture\n", encoding="utf-8")
        (self.root / "tests/linked.test.ts").symlink_to(self.root / "tests/real.test.ts")
        self.catalog([{"id": "p", "goal": "g", "tests": ["linked.test.ts"]}])
        with self.assertRaisesRegex(ValueError, "Missing or linked test"):
            self.run_main()

    def test_an_unknown_file_type_is_refused(self):
        self.touch("notes.md")
        self.catalog([{"id": "p", "goal": "g", "tests": ["notes.md"]}])
        with self.assertRaisesRegex(ValueError, "Unsupported persona test type"):
            self.run_main()

    def test_duplicate_ids_are_refused(self):
        self.touch("a.test.ts")
        self.catalog([{"id": "p", "goal": "g", "tests": ["a.test.ts"]}, {"id": "p", "goal": "g", "tests": ["a.test.ts"]}])
        with self.assertRaisesRegex(ValueError, "unique"):
            self.run_main()

    def test_a_failing_test_fails_the_profile(self):
        self.touch("broken.test.ts")
        self.catalog([{"id": "p", "goal": "g", "tests": ["broken.test.ts"]}])
        failed = lambda *a, **k: {"state": "failed", "exitCode": 1, "output": "boom", "reason": "nonzero-exit"}
        printed = []
        with patch.object(pt.runner, "execute", failed), \
             patch("builtins.print", lambda *args, **kwargs: printed.append(" ".join(str(a) for a in args))):
            self.assertEqual(self.run_main(), 1)
        self.assertTrue(any(line.startswith("PERSONA FAIL p") for line in printed), printed)

    def test_the_report_says_when_a_persona_has_no_rendered_screen(self):
        self.touch("contract.test.ts")
        self.catalog([{"id": "p", "goal": "g", "tests": ["contract.test.ts"]}])
        printed = []
        with patch.object(pt.runner, "execute", passed), \
             patch("builtins.print", lambda *args, **kwargs: printed.append(" ".join(str(a) for a in args))):
            self.assertEqual(self.run_main(), 0)
        verdict = next(line for line in printed if line.startswith("PERSONA"))
        self.assertIn("contract 1 · screen 0", verdict)
        self.assertIn("source contracts only, no rendered screen", verdict)


if __name__ == "__main__":
    unittest.main()
