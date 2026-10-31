"""The third common tester set (click sweep): the runner carries the engine and never calls a missing set a pass."""
import importlib.util
import json
from pathlib import Path
import sys
import tempfile
import unittest

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

    def write_config(self, surfaces):
        path = self.root / ".agentstoz/click-sweep.json"
        path.parent.mkdir(parents=True, exist_ok=True)
        path.write_text(json.dumps({"schemaVersion": 1, "surfaces": surfaces}), encoding="utf-8")

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
        self.assertIn("sweep run", caps["commands"])


if __name__ == "__main__":
    unittest.main()
