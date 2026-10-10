"""공통 러너의 `personas` — 프로젝트마다 자기 카탈로그로 페르소나를 검사한다(러너 1.5.0).

지키는 것:
- 카탈로그가 없으면 「없음」이다 — 통과도, 고장도 아니다(종료 코드 78).
- 근거는 도구를 가정하지 않는다: manifest 검사 참조 · 명시 argv(+ kind) · 옛 tests/ 단축형.
- 판정은 결정적 테스트의 종료 코드뿐이다. **탐색 기록(`exploratory/observed`)은 판정·이력·통계에 들어가지 않는다.**
- 탐색 브리프는 초안이다: 금지 행동을 싣고, 판정이 없고, 크기가 묶여 있다.
"""
from __future__ import annotations

import importlib.util
import json
import os
from pathlib import Path
import subprocess
import sys
import tempfile
import unittest

sys.dont_write_bytecode = True
SCRIPT = Path(__file__).resolve().parents[2] / "scripts/agentstoz-maintainer.py"
spec = importlib.util.spec_from_file_location("maintainer_personas", SCRIPT)
m = importlib.util.module_from_spec(spec)
spec.loader.exec_module(m)

OK = ["{python}", "-c", "pass"]


def init_repo(root, ignore):
    subprocess.run(["git", "init", "-q", str(root)], check=True)
    (root / ".gitignore").write_text(ignore)
    subprocess.run(["git", "-C", str(root), "add", ".gitignore"], check=True)
    subprocess.run(["git", "-C", str(root), "-c", "user.name=Fixture", "-c", "user.email=fixture@example.invalid",
                    "commit", "-qm", "Fixture"], check=True)
FAIL = ["{python}", "-c", "raise SystemExit(3)"]


class PersonaCommandTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory(prefix="agentstoz-personas-")
        self.root = Path(self.temp.name).resolve()
        init_repo(self.root, ".agentstoz/maintainer/\n__pycache__/\n")

    def tearDown(self):
        self.temp.cleanup()

    def catalog(self, personas, path=m.PERSONA_CATALOG):
        target = self.root / path
        target.parent.mkdir(parents=True, exist_ok=True)
        target.write_text(json.dumps({"schemaVersion": 1, "personas": personas}, ensure_ascii=False), encoding="utf-8")

    def manifest(self, checks):
        path = self.root / m.CONFIG
        path.parent.mkdir(parents=True, exist_ok=True)
        path.write_text(json.dumps({"schemaVersion": 1, "profiles": {"quick": [checks[0]["id"]]}, "checks": checks}))

    def cli(self, *argv):
        return subprocess.run([sys.executable, "-B", str(SCRIPT), "personas", *argv, "--root", str(self.root)],
                              capture_output=True, text=True, timeout=60, env={**os.environ, "PYTHONDONTWRITEBYTECODE": "1"})

    # --- no catalog -------------------------------------------------------------------------------
    def test_a_project_without_a_catalog_is_none_not_pass_and_not_broken(self):
        listed = self.cli("list", "--json")
        self.assertEqual(listed.returncode, 0, listed.stderr)
        self.assertEqual(json.loads(listed.stdout)["state"], "none")
        ran = self.cli("run", "--json")
        self.assertEqual(ran.returncode, m.NOT_APPLICABLE_EXIT, ran.stdout + ran.stderr)
        self.assertEqual(json.loads(ran.stdout)["state"], "none")
        self.assertFalse((self.root / m.STATE / "runs").exists(), "nothing ran, so nothing is recorded")
        self.assertEqual(m.inspect_project(self.root)["personas"]["state"], "none")

    # --- evidence forms ---------------------------------------------------------------------------
    def test_argv_evidence_is_tool_neutral_and_recorded_as_a_normal_run(self):
        self.catalog([{"id": "reader", "goal": "목록을 읽는다", "tests": [
            {"argv": OK, "kind": "contract", "name": "unit"},
            {"argv": ["{python}", "-c", "import os,sys; sys.exit(0 if os.environ.get('SEEN')=='1' else 4)"],
             "kind": "screen", "env": {"SEEN": "1"}, "name": "drawn"}]}])
        ran = self.cli("run")
        self.assertEqual(ran.returncode, 0, ran.stdout + ran.stderr)
        self.assertIn("PERSONA PASS reader [contract 1 · screen 1]", ran.stdout)
        report = m.reports(self.root)[0]
        self.assertEqual(report["profile"], m.PERSONA_PROFILE)
        self.assertEqual(report["state"], "passed")
        self.assertEqual(report["personas"][0]["verdict"], "PASS")
        self.assertEqual({c["evidence"] for c in report["checks"]}, {"persona:contract", "persona:screen"})
        self.assertTrue(all(c["covers"] == ["reader"] for c in report["checks"]))
        # History and stats are the normal machinery.
        self.assertEqual({row["profile"] for row in m.read_history(self.root)}, {m.PERSONA_PROFILE})
        self.assertIn("personas run --root . --persona reader", m.reproduce_command(report, report["checks"][0]))

    def test_a_check_reference_runs_the_manifest_command_once(self):
        self.manifest([{"id": "unit", "argv": ["{python}", "-c", "print('ran-unit')"], "timeoutSeconds": 30}])
        self.catalog([{"id": "a", "goal": "g", "tests": [{"check": "unit"}]},
                      {"id": "b", "goal": "g", "tests": [{"check": "unit", "kind": "screen"}]}])
        ran = self.cli("run")
        self.assertEqual(ran.returncode, 0, ran.stdout + ran.stderr)
        report = m.reports(self.root)[0]
        self.assertEqual([c["id"] for c in report["checks"]], ["unit"])
        self.assertEqual(report["checks"][0]["covers"], ["a", "b"])
        self.assertIn("PERSONA PASS a [contract 1 · screen 0 (source contracts only, no rendered screen)]", ran.stdout)
        self.assertIn("PERSONA PASS b [contract 0 · screen 1]", ran.stdout)
        self.catalog([{"id": "a", "goal": "g", "tests": [{"check": "missing"}]}])
        with self.assertRaisesRegex(ValueError, "unknown check"):
            m.run_personas(self.root)

    def test_a_failure_fails_only_the_personas_it_belongs_to(self):
        self.catalog([{"id": "good", "goal": "g", "tests": [{"argv": OK, "kind": "contract"}]},
                      {"id": "bad", "goal": "g", "tests": [{"argv": OK, "kind": "contract"}, {"argv": FAIL, "kind": "contract"}]}])
        ran = self.cli("run")
        self.assertEqual(ran.returncode, 1, ran.stdout + ran.stderr)
        self.assertIn("PERSONA PASS good", ran.stdout)
        self.assertIn("PERSONA FAIL bad", ran.stdout)
        self.assertEqual(len(m.reports(self.root)[0]["checks"]), 2, "shared evidence runs once")

    def test_selected_personas_only(self):
        self.catalog([{"id": "one", "goal": "g", "tests": [{"argv": OK, "kind": "contract", "name": "one"}]},
                      {"id": "two", "goal": "g", "tests": [{"argv": FAIL, "kind": "contract", "name": "two"}]}])
        self.assertEqual(self.cli("run").returncode, 1)
        self.assertEqual(self.cli("run", "--persona", "one").returncode, 0)
        # A narrower later run does not erase another persona's last verdict.
        latest = m.persona_summary(self.root)["latest"]
        self.assertEqual({v["id"]: v["verdict"] for v in latest["verdicts"]}, {"one": "PASS", "two": "FAIL"})
        self.assertNotEqual(*[v["runId"] for v in latest["verdicts"]])
        with self.assertRaisesRegex(ValueError, "Unknown persona ID"):
            m.run_personas(self.root, ["nobody"])

    def test_catalog_shape_is_strict(self):
        cases = [
            ([{"id": "p", "goal": "g", "tests": [{"argv": OK}]}], "declares kind"),
            ([{"id": "p", "goal": "g", "tests": [{"argv": OK, "kind": "vibes"}]}], "declares kind"),
            ([{"id": "p", "goal": "g", "tests": [{"argv": OK, "kind": "contract", "cwd": "../x"}]}], "project-relative"),
            ([{"id": "p", "goal": "g", "tests": []}], "a label alone never passes"),
            ([{"id": "P Q", "goal": "g", "tests": [{"argv": OK, "kind": "contract"}]}], "unique"),
            ([{"id": "p", "goal": "g", "tests": [{"argv": OK, "kind": "contract"}], "extra": 1}], "Unknown persona field"),
            ([{"id": "p", "goal": "g", "tests": [{"argv": OK, "kind": "contract"}], "explore": {"vibe": []}}], "explore holds"),
        ]
        for personas, message in cases:
            with self.subTest(message=message):
                self.catalog(personas)
                with self.assertRaisesRegex(ValueError, message):
                    m.load_personas(self.root)
                self.assertEqual(m.persona_summary(self.root)["state"], "invalid")
                self.assertEqual(self.cli("list", "--json").returncode, 2)

    def test_two_catalogs_are_refused(self):
        self.catalog([{"id": "p", "goal": "g", "tests": [{"argv": OK, "kind": "contract"}]}])
        self.catalog([{"id": "p", "goal": "g", "tests": [{"argv": OK, "kind": "contract"}]}], m.PERSONA_LEGACY_CATALOG)
        with self.assertRaisesRegex(ValueError, "Two persona catalogs"):
            m.load_personas(self.root)

    def test_persona_runs_do_not_hide_the_profile_status(self):
        self.manifest([{"id": "unit", "argv": OK}])
        self.catalog([{"id": "p", "goal": "g", "tests": [{"argv": FAIL, "kind": "contract"}]}])
        self.cli("run")
        inspected = m.inspect_project(self.root)
        self.assertIsNone(inspected["latest"], "a persona run is not a manifest profile result")
        self.assertEqual(inspected["personas"]["latest"]["verdicts"][0]["verdict"], "FAIL")


class ExplorationBoundaryTests(unittest.TestCase):
    """탐색은 `exploratory/observed` 이다. 어떤 탐색 기록도 페르소나를 통과시킬 수 없다."""

    def setUp(self):
        self.temp = tempfile.TemporaryDirectory(prefix="agentstoz-explore-")
        self.root = Path(self.temp.name).resolve()
        init_repo(self.root, ".agentstoz/maintainer/\n__pycache__/\nfindings*.json\n")
        (self.root / ".agentstoz").mkdir()
        (self.root / m.PERSONA_CATALOG).write_text(json.dumps({"schemaVersion": 1, "personas": [
            {"id": "newcomer", "goal": "처음 연결할 때 실패 원인을 이해한다",
             "tests": [{"argv": FAIL, "kind": "screen", "name": "first-run"}],
             "explore": {"successCriteria": ["실패 원인이 한 화면 안에 보인다"],
                         "forbidden": ["실제 계정으로 로그인하지 않는다"], "surfaces": ["온보딩 첫 화면"]}}]}, ensure_ascii=False))

    def tearDown(self):
        self.temp.cleanup()

    def findings(self, value, name="findings.json"):
        (self.root / name).write_text(json.dumps(value, ensure_ascii=False))
        return name

    def test_an_exploration_record_cannot_make_a_persona_pass(self):
        recorded = m.persona_observe(self.root, "newcomer", self.findings({"findings": [{
            "title": "이유가 안 보인다", "steps": ["앱을 연다"], "observed": "빈 화면", "expected": "원인 문구",
            "screenshot": "shots/1.png", "severity": "high"}]}))
        self.assertEqual(recorded["class"], m.EXPLORATION_CLASS)
        self.assertIsNone(recorded["verdict"])
        stored = json.loads((self.root / recorded["recorded"]).read_text())
        self.assertEqual(stored["class"], "exploratory/observed")
        self.assertFalse((self.root / m.HISTORY).exists(), "an observation is not a history row")
        result = m.run_personas(self.root)
        self.assertEqual(result["verdicts"][0]["verdict"], "FAIL", "only the deterministic test decides")
        self.assertEqual(result["code"], 1)
        self.assertEqual({row["state"] for row in m.read_history(self.root)}, {"failed"})
        self.assertEqual(list(m.load_stats(self.root)), ["first-run"], "stats know only deterministic evidence")
        summary = m.persona_summary(self.root)["personas"][0]
        self.assertEqual(summary["observations"], 1)
        self.assertEqual(m.persona_summary(self.root)["latest"]["verdicts"][0]["verdict"], "FAIL")

    def test_observations_cannot_carry_a_verdict(self):
        for bad in ({"findings": [{"title": "t", "observed": "o", "expected": "e"}], "verdict": "PASS"},
                    {"findings": [{"title": "t", "observed": "o", "expected": "e", "state": "passed"}]},
                    {"findings": [{"title": "t", "observed": "o", "expected": "e", "Passed": True}]}):
            with self.subTest(bad=bad), self.assertRaisesRegex(ValueError, "never a verdict"):
                m.persona_observe(self.root, "newcomer", self.findings(bad))
        with self.assertRaisesRegex(ValueError, "Unknown persona"):
            m.persona_observe(self.root, "someone-else", self.findings({"findings": [{"title": "t", "observed": "o", "expected": "e"}]}))
        with self.assertRaises(ValueError):
            m.persona_observe(self.root, "newcomer", "../outside.json")

    def test_the_brief_is_a_bounded_draft_with_the_forbidden_list_and_no_verdict(self):
        before = sorted(str(p) for p in self.root.rglob("*") if ".git/" not in str(p))
        brief = m.persona_brief(self.root, "newcomer")
        self.assertEqual(before, sorted(str(p) for p in self.root.rglob("*") if ".git/" not in str(p)), "a brief writes nothing")
        self.assertEqual((brief["class"], brief["draftOnly"], brief["verdict"]), (m.EXPLORATION_CLASS, True, None))
        text = brief["brief"]
        self.assertIn("실제 계정으로 로그인하지 않는다", text)
        for rule in m.DEFAULT_FORBIDDEN:
            self.assertIn(rule, text)
        for duty in ("실제 화면", "스크린샷", "회귀 테스트", "PASS/FAIL로 보고하지 마세요", "exploratory/observed"):
            self.assertIn(duty, text)
        self.assertIn("screen · first-run", text)
        self.assertNotIn(str(self.root), text)

    def test_the_brief_keeps_its_boundary_even_at_the_size_cap(self):
        long = ["가" * 299] * 16
        (self.root / m.PERSONA_CATALOG).write_text(json.dumps({"schemaVersion": 1, "personas": [
            {"id": "newcomer", "goal": "나" * 500, "tests": [{"argv": OK, "kind": "contract", "name": f"t{i}"} for i in range(32)],
             "explore": {"successCriteria": long, "forbidden": long, "surfaces": long}}]}, ensure_ascii=False))
        text = m.persona_brief(self.root, "newcomer")["brief"]
        self.assertLessEqual(len(text.encode("utf-8")), m.PERSONA_BRIEF_BYTES)
        self.assertIn("exploratory/observed", text.splitlines()[1])
        for rule in m.DEFAULT_FORBIDDEN:
            self.assertIn(rule, text, "the forbidden list comes before anything that can be cut")
        for duty in ("실제 화면", "회귀 테스트", "PASS/FAIL로 보고하지 마세요", "## 보고 형식"):
            self.assertIn(duty, text, "the duties survive a maximal catalog")

    def test_the_brief_cli_answers_json(self):
        done = subprocess.run([sys.executable, "-B", str(SCRIPT), "personas", "brief", "newcomer", "--root", str(self.root), "--json"],
                              capture_output=True, text=True, timeout=30)
        self.assertEqual(done.returncode, 0, done.stderr)
        self.assertEqual(json.loads(done.stdout)["class"], "exploratory/observed")
        unknown = subprocess.run([sys.executable, "-B", str(SCRIPT), "personas", "brief", "nobody", "--root", str(self.root), "--json"],
                                 capture_output=True, text=True, timeout=30)
        self.assertEqual(unknown.returncode, 2)


class PersonaCapabilityTests(unittest.TestCase):
    def test_capabilities_announce_persona_support(self):
        done = subprocess.run([sys.executable, "-B", str(SCRIPT), "capabilities"], capture_output=True, text=True, timeout=30)
        caps = json.loads(done.stdout)
        self.assertEqual(caps["personaSchemas"], [1])
        self.assertEqual(caps["personaEvidence"], ["contract", "screen"])
        self.assertEqual(caps["exploration"], "exploratory/observed")
        self.assertIn("personas run", caps["commands"])

    def test_repository_catalog_is_valid(self):
        relative, personas = m.load_personas(SCRIPT.parents[1])
        self.assertEqual(relative, m.PERSONA_LEGACY_CATALOG)
        self.assertTrue(personas)


if __name__ == "__main__":
    unittest.main()
