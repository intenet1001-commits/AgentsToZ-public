"""The third common tester set (click sweep): the runner carries the engine and never calls a missing set a pass."""
import importlib.util
import json
import hashlib
import contextlib
import io
from pathlib import Path
import sys
import tempfile
import unittest
from unittest.mock import patch

sys.dont_write_bytecode = True
REPO = Path(__file__).resolve().parents[2]
SCRIPT = REPO / "scripts/agentstoz-maintainer.py"
spec = importlib.util.spec_from_file_location("maintainer_click_sweep", SCRIPT)
m = importlib.util.module_from_spec(spec)
spec.loader.exec_module(m)

SUMMARY_WRITER = (
    "import json,os,sys\n"
    "d='.agentstoz/maintainer/click-sweep/{sid}'\n"
    "os.makedirs(d,exist_ok=True)\n"
    "passed='--update' in sys.argv or {passed}\n"
    "json.dump({{'schemaVersion':1,'surface':'{sid}','passed':passed,'elements':3,'clicked':3,'failures':0 if passed else 1,'updated':'--update' in sys.argv}},open(d+'/summary.json','w'))\n"
    "sys.exit(0 if passed else 1)\n"
)


class ClickSweepTests(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.root = Path(self.tmp.name).resolve()

    def tearDown(self):
        self.tmp.cleanup()

    def write_config(self, surfaces, version=1):
        path = self.root / ".agentstoz/click-sweep.json"
        path.parent.mkdir(parents=True, exist_ok=True)
        path.write_text(json.dumps({"schemaVersion": version, "surfaces": surfaces}), encoding="utf-8")

    def command_surface(self, sid, passed):
        script = self.root / f"sweep_{sid}.py"
        script.write_text(SUMMARY_WRITER.format(sid=sid, passed=passed), encoding="utf-8")
        return {"id": sid, "label": sid.upper(), "command": [sys.executable, str(script)]}

    def test_the_runner_carries_exactly_the_engine_source(self):
        # One distribution path: the embedded copy must be the file in scripts/, byte for byte.
        self.assertEqual(m.CLICK_SWEEP_ENGINE, (REPO / "scripts/agentstoz-click-sweep.mjs").read_text(encoding="utf-8"))
        self.assertRegex(m.click_sweep_engine_version() or "", r"^\d+\.\d+\.\d+$")

    def test_a_project_without_a_config_is_unconfigured_never_a_pass(self):
        status = m.click_sweep_status(self.root)
        self.assertEqual(status["config"], "none")
        self.assertEqual(status["engine"]["state"], "absent")
        self.assertIn("next", status)
        self.assertEqual(m.run_click_sweep(self.root, as_json=True), 2)

    def test_install_writes_the_shared_engine_and_never_overwrites_a_local_edit(self):
        result = m.install_click_sweep_engine(self.root)
        self.assertTrue(result["installed"])
        engine = self.root / m.CLICK_SWEEP_ENGINE_PATH
        self.assertEqual(engine.read_text(encoding="utf-8"), m.CLICK_SWEEP_ENGINE)
        self.assertEqual(m.click_sweep_engine_state(self.root), "ready")
        self.assertFalse(m.install_click_sweep_engine(self.root)["installed"])
        engine.write_text(m.CLICK_SWEEP_ENGINE + "// local edit\n", encoding="utf-8")
        self.assertEqual(m.click_sweep_engine_state(self.root), "modified")
        with self.assertRaises(ValueError):
            m.install_click_sweep_engine(self.root)
        self.assertTrue(engine.read_text(encoding="utf-8").endswith("// local edit\n"))

    def test_command_surfaces_report_pass_fail_and_the_last_summary(self):
        self.write_config([self.command_surface("desktop", True), self.command_surface("phone", False)])
        status = m.click_sweep_status(self.root)
        self.assertEqual(status["config"], "configured")
        self.assertEqual([s["id"] for s in status["surfaces"]], ["desktop", "phone"])
        self.assertEqual(status["surfaces"][0]["baseline"], ".agentstoz/click-sweep/desktop.json")
        self.assertFalse(status["surfaces"][0]["baselinePresent"])
        self.assertIsNone(status["surfaces"][0]["last"])
        self.assertEqual(m.run_click_sweep(self.root, "desktop", as_json=True), 0)
        self.assertEqual(m.run_click_sweep(self.root, as_json=True), 1)  # one failing surface fails the set
        last = {s["id"]: s["last"] for s in m.click_sweep_status(self.root)["surfaces"]}
        self.assertTrue(last["desktop"]["passed"])
        self.assertFalse(last["phone"]["passed"])
        # --update reaches the project command (its own baseline writer) and is reported as accepted.
        self.assertEqual(m.run_click_sweep(self.root, "phone", update=True, as_json=True), 0)
        self.assertTrue(m.click_sweep_summary(self.root, "phone")["updated"])

    def test_invalid_configs_are_reported_not_run(self):
        for surfaces in ([], [{"id": "Bad Id", "url": "http://127.0.0.1:1/"}], [{"id": "a", "url": "http://127.0.0.1:1/"}, {"id": "a", "url": "http://127.0.0.1:1/"}],
                         [{"id": "a", "url": "http://127.0.0.1:1/", "baseline": "../outside.json"}], [{"id": "a"}]):
            self.write_config(surfaces)
            status = m.click_sweep_status(self.root)
            self.assertEqual(status["config"], "invalid", surfaces)
            with self.assertRaises(ValueError):
                m.run_click_sweep(self.root, as_json=True)

    def test_unknown_surface_is_refused(self):
        self.write_config([self.command_surface("desktop", True)])
        with self.assertRaises(ValueError):
            m.run_click_sweep(self.root, "nope", as_json=True)

    def test_capabilities_announce_the_set(self):
        import contextlib
        import io
        out = io.StringIO()
        with contextlib.redirect_stdout(out):
            self.assertEqual(m.main(["capabilities"]), 0)
        caps = json.loads(out.getvalue())
        self.assertEqual(caps["clickSweep"], 1)
        self.assertEqual(caps["clickSweepTargetContract"], 2)
        self.assertIn("sweep run", caps["commands"])


DESKTOP_FIXTURE = """import hashlib,json,os,pathlib,sys
# Protocol fixture only: no desktop driver, window, screenshot or OS input.
e=os.environ
scope={"schemaVersion":2,"surface":e["AGENTSTOZ_SWEEP_SURFACE"],"target":"desktop","environment":e["AGENTSTOZ_SWEEP_ENVIRONMENT"],"platform":e["AGENTSTOZ_SWEEP_PLATFORM"]}
b=pathlib.Path(e["AGENTSTOZ_SWEEP_BASELINE_PATH"])
if e["AGENTSTOZ_SWEEP_UPDATE"]=="1":
 b.parent.mkdir(parents=True,exist_ok=True)
 b.write_text(json.dumps({**scope,"inventory":{"fixture-button":{"reaction":"fixture-only"}}}))
r={**scope,"runId":e["AGENTSTOZ_SWEEP_RUN_ID"],"baselinePath":e["AGENTSTOZ_SWEEP_BASELINE_PATH"],"baselineSha256":hashlib.sha256(b.read_bytes()).hexdigest(),"passed":True,"updated":e["AGENTSTOZ_SWEEP_UPDATE"]=="1","elements":1,"clicked":1,"failures":0}
p=pathlib.Path(e["AGENTSTOZ_SWEEP_RESULT_PATH"]);p.parent.mkdir(parents=True,exist_ok=True)
p.write_text(json.dumps(r))
pathlib.Path("fixture-command-ran").write_text("fixture-only")
"""


class DesktopClickSweepScopeTests(unittest.TestCase):
    setUp = ClickSweepTests.setUp
    tearDown = ClickSweepTests.tearDown
    write_config = ClickSweepTests.write_config
    command_surface = ClickSweepTests.command_surface
    def desktop(self, environment="fixture", **extra):
        script = self.root / "desktop_fixture.py"
        script.write_text(DESKTOP_FIXTURE)
        return {"id": "app", "target": "desktop", "environment": environment, "platform": sys.platform,
                "command": [sys.executable, str(script)], **extra}

    def test_desktop_fixture_needs_no_web_port_and_has_independent_baseline_and_report(self):
        surface = self.desktop()
        self.write_config([surface], 2)
        self.assertEqual(m.run_click_sweep(self.root, as_json=True), 3)
        self.assertFalse((self.root / "fixture-command-ran").exists())
        self.assertEqual(m.run_click_sweep(self.root, update=True, as_json=True), 0)
        baseline = self.root / m.click_sweep_baseline(surface)
        self.assertIn("desktop/fixture/", str(baseline))
        self.assertEqual(json.loads(baseline.read_text())["environment"], "fixture")
        last = m.click_sweep_summary(self.root, surface)
        self.assertTrue(last["passed"] and last["completed"])
        self.assertEqual((last["target"], last["environment"]), ("desktop", "fixture"))
        self.assertEqual(m.run_click_sweep(self.root, as_json=True), 0)
        self.assertEqual(m.click_sweep_status(self.root)["surfaces"][0]["target"], "desktop")

    def test_web_results_and_zero_exit_cannot_certify_desktop_or_replace_old_web_evidence(self):
        old = self.root / ".agentstoz/click-sweep/app.json"
        old.parent.mkdir(parents=True)
        old.write_text('{"schemaVersion":1,"surface":"app","elements":{"web-button":{}}}')
        summary = self.root / ".agentstoz/maintainer/click-sweep/app/summary.json"
        summary.parent.mkdir(parents=True)
        summary.write_text('{"schemaVersion":1,"passed":true,"elements":4}')
        before = old.read_bytes(), summary.read_bytes()
        surface = self.desktop(command=[sys.executable, "-c", "print('web command exit zero')"])
        self.write_config([surface], 2)
        self.assertEqual(m.run_click_sweep(self.root, update=True, as_json=True), 3)
        self.assertEqual((old.read_bytes(), summary.read_bytes()), before)
        last = m.click_sweep_summary(self.root, surface)
        self.assertEqual(last["state"], "unavailable")
        self.assertFalse(last["passed"] or last["completed"])
        # Even an otherwise complete result cannot relabel the browser engine as desktop.
        surface = self.desktop()
        script = Path(surface["command"][1])
        script.write_text(DESKTOP_FIXTURE.replace('p.write_text(json.dumps(r))', 'r["target"]="web";r["environment"]="browser";p.write_text(json.dumps(r))'))
        self.write_config([surface], 2)
        self.assertEqual(m.run_click_sweep(self.root, update=True, as_json=True), 3)

    def test_empty_ui_or_zero_click_adapter_is_unavailable_even_after_exit_zero(self):
        for field in ("elements", "clicked"):
            surface=self.desktop()
            script=Path(surface["command"][1])
            script.write_text(DESKTOP_FIXTURE.replace('"'+field+'":1', '"'+field+'":0'))
            self.write_config([surface],2)
            self.assertEqual(m.run_click_sweep(self.root,update=True,as_json=True),3)
            last=m.click_sweep_summary(self.root,surface)
            self.assertEqual(last["state"],"unavailable")
            self.assertFalse(last["passed"] or last["completed"])

    def test_a_previous_completion_cannot_be_reused_for_a_new_run(self):
        surface = self.desktop()
        self.write_config([surface], 2)
        self.assertEqual(m.run_click_sweep(self.root, update=True, as_json=True), 0)
        surface["command"] = [sys.executable, "-c", "pass"]
        self.write_config([surface], 2)
        self.assertEqual(m.run_click_sweep(self.root, as_json=True), 3)
        self.assertFalse(m.click_sweep_summary(self.root, surface)["completed"])

    def test_normal_run_detects_baseline_replacement_even_if_harness_claims_updated_false(self):
        surface=self.desktop()
        self.write_config([surface],2)
        self.assertEqual(m.run_click_sweep(self.root,update=True,as_json=True),0)
        baseline=self.root/m.click_sweep_baseline(surface);before=baseline.read_bytes()
        script=Path(surface["command"][1])
        change='if e["AGENTSTOZ_SWEEP_UPDATE"]=="0":\n v=json.loads(b.read_text());v["inventory"]["unreviewed-change"]={};b.write_text(json.dumps(v))\n'
        script.write_text(DESKTOP_FIXTURE.replace('r={**scope',change+'r={**scope'))
        self.assertEqual(m.run_click_sweep(self.root,as_json=True),3)
        self.assertNotEqual(baseline.read_bytes(),before)
        self.assertIn("unreviewed-change",json.loads(baseline.read_text())["inventory"])
        last=m.click_sweep_summary(self.root,surface)
        self.assertEqual(last["state"],"unavailable")
        self.assertIn("기준선 파일이 변경",last["reason"])

    def test_explicit_bad_baseline_types_never_fall_back_in_either_schema(self):
        for version in (1,2):
            for value in ("",0,False,None,[],{}):
                self.write_config([{"id":"web","target":"web","url":"http://127.0.0.1:1/","baseline":value}],version)
                self.assertEqual(m.click_sweep_status(self.root)["config"],"invalid",(version,value))

    def test_fixture_baseline_is_never_promoted_to_native_or_overwritten(self):
        surface = self.desktop(baseline="tests/fixture-baseline.json")
        self.write_config([surface], 2)
        self.assertEqual(m.run_click_sweep(self.root, update=True, as_json=True), 0)
        baseline = self.root / surface["baseline"]
        before = baseline.read_bytes()
        (self.root / "fixture-command-ran").unlink()
        surface["environment"] = "native"
        self.write_config([surface], 2)
        self.assertEqual(m.run_click_sweep(self.root, update=True, as_json=True), 3)
        self.assertFalse((self.root / "fixture-command-ran").exists())
        self.assertEqual(baseline.read_bytes(), before)
        self.assertNotEqual(m.click_sweep_evidence(surface), m.click_sweep_evidence({**surface,"environment":"fixture"}))

    def test_missing_harness_or_wrong_platform_is_unavailable_not_a_pass(self):
        surface = self.desktop(command=[str(self.root / "missing-desktop-driver")])
        self.write_config([surface], 2)
        self.assertEqual(m.run_click_sweep(self.root, update=True, as_json=True), 3)
        surface = self.desktop(platform="win32" if sys.platform != "win32" else "darwin")
        self.write_config([surface], 2)
        self.assertEqual(m.run_click_sweep(self.root, update=True, as_json=True), 3)
        self.assertFalse((self.root / "fixture-command-ran").exists())

    def test_target_contract_rejects_desktop_urls_missing_scope_and_shared_baselines(self):
        bad = [
            {"id":"app","target":"desktop","url":"http://127.0.0.1:1/","environment":"native","platform":sys.platform},
            {"id":"app","target":"desktop","command":["missing"]},
            {"id":"app","target":"web","environment":"native","url":"http://127.0.0.1:1/"},
            {"id":"app","command":["missing"]},
        ]
        for surface in bad:
            self.write_config([surface], 2)
            self.assertEqual(m.click_sweep_status(self.root)["config"], "invalid")
        surface = self.desktop(baseline="tests/shared.json")
        self.write_config([surface,{"id":"web","target":"web","url":"http://127.0.0.1:1/","baseline":"tests/shared.json"}], 2)
        self.assertEqual(m.click_sweep_status(self.root)["config"], "invalid")

    def test_legacy_commands_are_unknown_and_old_web_evidence_stays_readable(self):
        surface = {**self.command_surface("desktop", True), "environment":"project-custom", "target":"old-custom-target"}
        self.write_config([surface])
        self.assertEqual(m.click_sweep_status(self.root)["surfaces"][0]["target"], "legacy")
        self.assertEqual(m.run_click_sweep(self.root, as_json=True), 0)
        self.assertEqual(m.click_sweep_status(self.root)["surfaces"][0]["target"], "legacy")
        surface["target"] = "web"
        surface["environment"] = "browser"
        self.write_config([surface], 2)
        self.assertTrue(m.click_sweep_status(self.root)["surfaces"][0]["last"]["passed"])

    def test_formal_runner_upgrade_preserves_project_click_config_baselines_results_and_custom_engine(self):
        files = {
            ".agentstoz/click-sweep.json": json.dumps({"schemaVersion":1,"surfaces":[{"id":"private-app","command":["private-owned-harness"],"custom":"keep"}]}),
            "tests/private-baseline.json":"old project-owned baseline",
            ".agentstoz/maintainer/click-sweep/private-app/summary.json":"old project result",
            "scripts/agentstoz-click-sweep.mjs":"// locally customized project engine",
            ".agentstoz/maintainer.json":json.dumps({"schemaVersion":1,"profiles":{"quick":["one"]},"checks":[{"id":"one","argv":[sys.executable,"-c","pass"]}]}),
        }
        for name,text in files.items():
            p=self.root/name;p.parent.mkdir(parents=True,exist_ok=True);p.write_text(text)
        old="# managed old runner\n"
        (self.root/m.RUNNER).write_text(old)
        (self.root/m.TESTER_META).write_text(json.dumps({"schemaVersion":1,"templateVersion":"1.8.0","minimumRunnerVersion":"1.8.0","managedRunnerHash":m.digest(old),"defaultProfile":"quick"}))
        plan=m.setup_plan(self.root)
        m.apply_setup(self.root,plan["revision"])
        for name,text in files.items():self.assertEqual((self.root/name).read_text(),text,name)
        with self.assertRaises(ValueError):m.install_click_sweep_engine(self.root)

    def test_only_known_released_engine_can_upgrade_without_touching_project_evidence(self):
        engine=self.root/m.CLICK_SWEEP_ENGINE_PATH;engine.parent.mkdir()
        old="// official old fixture engine\n";engine.write_text(old)
        config={"schemaVersion":1,"surfaces":[{"id":"web","url":"http://127.0.0.1:1/"}]}
        self.write_config(config["surfaces"])
        before=(self.root/m.CLICK_SWEEP_CONFIG).read_bytes()
        with patch.object(m,"RELEASED_CLICK_SWEEP_ENGINES",{"1.0.0":m.digest(old)}):
            self.assertEqual(m.click_sweep_engine_state(self.root),"outdated")
            self.assertTrue(m.install_click_sweep_engine(self.root)["upgraded"])
        self.assertEqual((self.root/m.CLICK_SWEEP_CONFIG).read_bytes(),before)
        self.assertEqual(engine.read_text(),m.CLICK_SWEEP_ENGINE)
        engine.write_text(old+"// local edit")
        with self.assertRaises(ValueError):m.install_click_sweep_engine(self.root)

    def test_portable_contract_is_read_only_without_repo_docs_or_config_and_is_advertised(self):
        self.assertEqual(list(self.root.iterdir()), [])
        output = io.StringIO()
        with contextlib.redirect_stdout(output):
            self.assertEqual(m.main(["sweep", "contract", "--root", str(self.root), "--json"]), 0)
        contract = json.loads(output.getvalue())
        self.assertTrue(contract["readOnly"])
        self.assertEqual(contract["contractVersion"], 2)
        self.assertEqual(set(contract["desktopResult"]["exactFields"]), {"schemaVersion", "runId", "surface", "target", "environment", "platform", "baselinePath", "baselineSha256", "passed", "updated", "elements", "clicked", "failures"})
        self.assertEqual(len(contract["desktopEnvironment"]), 8)
        self.assertEqual(list(self.root.iterdir()), [], "help must not setup files, launch harnesses or create locks")
        initial = m.initial_files(self.root)
        self.assertIn("sweep contract --root . --json", initial[".agentstoz/MAINTAINER.md"])
        self.assertFalse((self.root / "docs/click-sweep-targets.md").exists())
        caps = io.StringIO()
        with contextlib.redirect_stdout(caps):self.assertEqual(m.main(["capabilities", "--root", str(self.root)]), 0)
        advertised = json.loads(caps.getvalue())
        self.assertEqual(advertised["clickSweepContract"], 2)
        self.assertIn("sweep contract", advertised["commands"])
        # An invalid project config cannot prevent help or be modified by reading it.
        self.write_config([{"id":"invalid"}], 2)
        before = (self.root/m.CLICK_SWEEP_CONFIG).read_bytes()
        with contextlib.redirect_stdout(io.StringIO()):
            self.assertEqual(m.main(["sweep", "contract", "--root", str(self.root), "--json"]), 0)
        self.assertEqual((self.root/m.CLICK_SWEEP_CONFIG).read_bytes(), before)
        plan = m.setup_plan(self.root)
        guide = next(c["after"] for c in plan["changes"] if c["path"] == ".agentstoz/MAINTAINER.md")
        self.assertIn("sweep contract --root . --json", guide)

    def test_stored_desktop_summary_inconsistency_is_unverified_without_rewriting_evidence(self):
        surface = self.desktop()
        self.write_config([surface], 2)
        path = self.root/m.click_sweep_evidence(surface)/"summary.json"
        path.parent.mkdir(parents=True)
        valid = {"schemaVersion":2,"surface":"app","target":"desktop","environment":"fixture","platform":sys.platform,
                 "baselinePath":m.click_sweep_baseline(surface),"state":"passed","completed":True,"passed":True,"updated":False,
                 "elements":2,"clicked":2,"failures":0}
        for delta in ({"elements":0}, {"elements":-1}, {"clicked":0}, {"clicked":None}, {"elements":None},
                      {"elements":1_000_001}, {"elements":True}, {"state":"failed"}, {"completed":"true"},
                      {"passed":1}, {"updated":0}, {"failures":1}, {"state":"failed","passed":False,"failures":0}):
            value = {**valid, **delta}
            if delta == {"elements":None}:value.pop("elements")
            raw = json.dumps(value)
            path.write_text(raw)
            brief = m.click_sweep_summary(self.root, surface)
            self.assertEqual(brief["state"], "unverified", delta)
            self.assertFalse(brief["passed"] or brief["completed"] or brief["updated"], delta)
            self.assertEqual(path.read_text(), raw, "read boundary must preserve original evidence")
        for delta in ({}, {"state":"failed","passed":False,"failures":1},
                      {"state":"unavailable","completed":False,"passed":False,"elements":0,"clicked":0}):
            value = {**valid, **delta}
            path.write_text(json.dumps(value))
            self.assertEqual(m.click_sweep_summary(self.root, surface), value)


if __name__ == "__main__":
    unittest.main()
