"""Behavioral regressions for the portable runner; no app, network or AI."""
import importlib.util
import json
import os
from pathlib import Path
import signal
import shutil
import subprocess
import sys
import tempfile
import time
import unittest
from unittest.mock import patch

sys.dont_write_bytecode = True
SCRIPT = Path(__file__).resolve().parents[2] / "scripts/agentstoz-maintainer.py"
spec = importlib.util.spec_from_file_location("maintainer", SCRIPT)
m = importlib.util.module_from_spec(spec)
spec.loader.exec_module(m)


class MaintainerTests(unittest.TestCase):
    def test_future_runner_metadata_is_preserved_without_downgrade(self):
        plan = m.setup_plan(self.root); m.apply_setup(self.root, plan['revision'])
        path = self.root / m.TESTER_META
        meta = json.loads(path.read_text()); meta['templateVersion'] = '99.0.0'; path.write_text(json.dumps(meta))
        before = (self.root / m.RUNNER).read_bytes()
        self.assertEqual(m.inspect_project(self.root)['installation'], 'unsupported')
        with self.assertRaisesRegex(ValueError, 'Newer tester'):
            m.setup_plan(self.root)
        self.assertEqual((self.root / m.RUNNER).read_bytes(), before)

    @unittest.skipIf(os.name == 'nt', 'POSIX parent supervision')
    def test_parent_watch_binding_is_not_inherited_by_nested_tests(self):
        self.config([{'id': 'nested', 'argv': ['{python}', '-c', "import os; assert 'AGENTSTOZ_TESTER_PARENT_PID' not in os.environ"], 'timeoutSeconds': 3}])
        result = subprocess.run([sys.executable, '-B', str(SCRIPT), 'run', '--root', str(self.root)],
                                env={**os.environ, 'AGENTSTOZ_TESTER_PARENT_PID': str(os.getpid())}, capture_output=True, text=True, timeout=15)
        self.assertEqual(result.returncode, 0, result.stderr + result.stdout)

    def test_missing_ai_adapter_is_reported_and_reconnected(self):
        plan = m.setup_plan(self.root)
        m.apply_setup(self.root, plan['revision'])
        (self.root / '.claude/skills/agentstoz-test/SKILL.md').unlink()
        self.assertEqual(m.inspect_project(self.root)['installation'], 'partial')
        self.assertFalse(m.inspect_project(self.root)['instructionsConnected'])
        repair = m.setup_plan(self.root)
        self.assertEqual([c['path'] for c in repair['changes']], ['.claude/skills/agentstoz-test/SKILL.md'])
        m.apply_setup(self.root, repair['revision'])
        self.assertTrue(m.inspect_project(self.root)['instructionsConnected'])

    def test_cleanup_permission_failure_never_becomes_a_pass(self):
        with patch.object(m, 'stop_group', return_value=False):
            result = m.execute([sys.executable, '-c', "print('done')"], self.root, 2)
        self.assertEqual(result['state'], 'blocked')
        self.assertEqual(result['reason'], 'process-cleanup-unconfirmed')

    def test_non_git_project_runs_and_detects_source_changes(self):
        shutil.rmtree(self.root / '.git')
        config = self.config()
        self.assertEqual(m.run_profile(self.root, config, 'quick'), 0)
        before = m.source_identity(self.root)
        self.assertEqual(before['kind'], 'filesystem')
        (self.root / 'source.py').write_text('value = 2\n')
        self.assertNotEqual(before['fingerprint'], m.source_identity(self.root)['fingerprint'])

    def test_setup_journal_cannot_edit_unrelated_files(self):
        plan = m.setup_plan(self.root)
        plan['state'] = 'applying'
        plan['changes'] = [{'path': 'application.py', 'before': None, 'after': 'changed'}]
        base = {k: plan[k] for k in ('rootIdentity', 'changes')}
        plan['revision'] = m.digest(m.canonical_json(base))
        m.save_text(self.root, m.SETUP_JOURNAL, json.dumps(plan))
        with self.assertRaisesRegex(ValueError, 'Invalid setup transaction file'):
            m.apply_setup(self.root, plan['revision'])
        self.assertFalse((self.root / 'application.py').exists())

    def test_host_setup_preserves_config_and_user_instructions(self):
        self.config()
        config = (self.root / m.CONFIG).read_bytes()
        (self.root / 'AGENTS.md').write_text('User instructions\n')
        plan = m.setup_plan(self.root)
        self.assertFalse((self.root / m.RUNNER).exists())
        m.apply_setup(self.root, plan['revision'])
        self.assertEqual((self.root / m.CONFIG).read_bytes(), config)
        self.assertTrue((self.root / 'AGENTS.md').read_text().startswith('User instructions\n'))
        self.assertEqual(m.setup_plan(self.root)['changes'], [])
        self.assertEqual(m.inspect_project(self.root)['installation'], 'ready')

    def test_host_setup_recovers_only_its_partial_transaction(self):
        plan = m.setup_plan(self.root)
        original = m.save_text
        def fail_after_journal(root, relative, text):
            if relative == m.RUNNER:
                raise OSError('simulated interruption')
            return original(root, relative, text)
        with patch.object(m, 'save_text', fail_after_journal):
            with self.assertRaises(OSError):
                m.apply_setup(self.root, plan['revision'])
        self.assertEqual(m.setup_plan(self.root)['revision'], plan['revision'])
        m.apply_setup(self.root, plan['revision'])
        self.assertEqual(m.inspect_project(self.root)['installation'], 'ready')
        self.assertNotIn('before', (self.root / m.SETUP_JOURNAL).read_text())

    def test_host_run_id_is_not_replayed_or_used_as_a_path(self):
        config = self.config()
        run_id = '20260914T010000Z-1234abcd'
        self.assertEqual(m.run_profile(self.root, config, 'quick', run_id=run_id), 0)
        with self.assertRaisesRegex(ValueError, 'already exists'):
            m.run_profile(self.root, config, 'quick', run_id=run_id)
        with self.assertRaisesRegex(ValueError, 'Invalid run'):
            m.run_profile(self.root, config, 'quick', run_id='../escape')

    def setUp(self):
        self.temp = tempfile.TemporaryDirectory(prefix="agentstoz-maintainer-test-")
        self.root = Path(self.temp.name).resolve()
        subprocess.run(["git", "init", "-q", str(self.root)], check=True)
        (self.root / ".gitignore").write_text(".agentstoz/maintainer/\n__pycache__/\n")
        subprocess.run(["git", "-C", str(self.root), "add", ".gitignore"], check=True)
        subprocess.run(["git", "-C", str(self.root), "-c", "user.name=Fixture", "-c", "user.email=fixture@example.invalid",
                        "commit", "-qm", "Fixture"], check=True)

    def tearDown(self):
        self.temp.cleanup()

    def config(self, checks=None):
        checks = checks or [{"id": "one", "argv": ["{python}", "-c", "print('PASS')"], "timeoutSeconds": 3}]
        data = {"schemaVersion": 1, "profiles": {"quick": [c["id"] for c in checks]}, "checks": checks, "limits": ["No real device"]}
        (self.root / ".agentstoz").mkdir(exist_ok=True)
        (self.root / m.CONFIG).write_text(json.dumps(data))
        return m.load_config(self.root)

    def test_command_is_argv_not_shell(self):
        token = "$(touch pwned); `echo BAD` & 한글"
        r = m.execute([sys.executable, "-c", "import sys; print(sys.argv[1])", token], self.root, 3)
        self.assertEqual(r["state"], "passed")
        self.assertIn(token, r["output"])
        self.assertFalse((self.root / "pwned").exists())

    def test_nonzero_is_failed_and_missing_executable_is_blocked(self):
        self.assertEqual(m.execute([sys.executable, "-c", "raise SystemExit(7)"], self.root, 3)["exitCode"], 7)
        self.assertEqual(m.execute(["agentstoz-nonexistent-fixture"], self.root, 3)["state"], "blocked")

    def test_bounded_output_redacts_secret_across_writes(self):
        secret = "maintainerfixture" * 6
        with patch.dict(os.environ, {"EXAMPLE_SECRET_KEY": secret}):
            r = m.execute([sys.executable, "-c", "import os,sys; print('x'*200000); s=os.environ['EXAMPLE_SECRET_KEY']; sys.stdout.write(s[:12]); sys.stdout.flush(); sys.stdout.write(s[12:])"], self.root, 3)
        self.assertEqual(r["state"], "passed")
        self.assertTrue(r["outputTruncated"])
        self.assertLessEqual(len(r["output"]), m.MAX_TAIL)
        self.assertNotIn(secret, r["output"])
        self.assertIn("[redacted]", r["output"])

    def test_redacts_common_credentials_and_paths(self):
        value = "Authorization: Bearer secret123\nhttps://person:password@host.example/#pair=abcdefghi\napi_key=abc123\n/Users/fixture\nhello@example.com"
        output = m.redact(value, Path("/Users/fixture"))
        for secret in ["secret123", "abcdefghi", "abc123", "person:password", "hello@example.com", "/Users/fixture"]:
            self.assertNotIn(secret, output)

    @unittest.skipIf(os.name == "nt", "POSIX process-group assertion")
    def test_timeout_terminates_descendants_that_ignore_term(self):
        pidfile = self.root / "child.pid"
        grandchild = "import os,signal,time,pathlib; signal.signal(signal.SIGTERM,signal.SIG_IGN); pathlib.Path('child.pid').write_text(str(os.getpid())); time.sleep(30)"
        parent = "import subprocess,sys,time; subprocess.Popen([sys.executable,'-c'," + repr(grandchild) + "]); time.sleep(30)"
        r = m.execute([sys.executable, "-c", parent], self.root, 0.5)
        self.assertEqual(r["reason"], "timeout")
        self.assertLess(r["durationSeconds"], 6)
        pid = int(pidfile.read_text())
        for _ in range(30):
            result = subprocess.run(["ps", "-o", "stat=", "-p", str(pid)], capture_output=True, text=True)
            if result.returncode or result.stdout.strip().startswith("Z"):
                break
            time.sleep(0.05)
        self.assertTrue(result.returncode or result.stdout.strip().startswith("Z"), "grandchild survived timeout")

    @unittest.skipIf(os.name == "nt", "POSIX process-group assertion")
    def test_successful_parent_cannot_leave_a_hanging_pipe(self):
        r = m.execute([sys.executable, "-c", "import subprocess,sys; subprocess.Popen([sys.executable,'-c','import time; time.sleep(30)']); print('done')"], self.root, 2)
        self.assertEqual(r["state"], "passed")
        self.assertLess(r["durationSeconds"], 6)

    def test_manifest_rejects_unknown_duplicate_checks_and_bad_path(self):
        for changes in [dict(argv="echo unsafe"), dict(cwd="../outside"), dict(timeoutSeconds=0), dict(timeoutSeconds=True)]:
            with self.assertRaises(ValueError):
                self.config([{"id": "one", "argv": ["echo", "ok"], **changes}])
        with self.assertRaises(ValueError):
            self.config([{"id": "same"}, {"id": "same"}])
        with self.assertRaises(ValueError):
            self.config([{"id": "one", "needs": ["missing"]}])

    def test_path_symlink_cannot_escape_project(self):
        outside = self.root / "outside"
        outside.mkdir()
        (self.root / ".agentstoz").symlink_to(outside, target_is_directory=True)
        with self.assertRaises(ValueError):
            m.project_lock(self.root).__enter__()
        self.assertEqual(list(outside.iterdir()), [])

    def test_parallel_run_rejected_and_lock_releases(self):
        self.config()
        with m.project_lock(self.root):
            with self.assertRaises(ValueError):
                with m.project_lock(self.root):
                    pass
        with m.project_lock(self.root):
            pass

    def test_results_distinguish_blocked_failed_and_passed_without_cache(self):
        config = self.config([
            {"id": "bad", "argv": ["{python}", "-c", "raise SystemExit(4)"]},
            {"id": "dependent", "argv": ["{python}", "-c", "raise Exception('must not run')"], "needs": ["bad"]},
            {"id": "ok", "argv": ["{python}", "-c", "print('good')"]},
            {"id": "phone", "argv": ["{python}", "-c", "pass", "{env:AGENTSTOZ_MISSING_TEST_DEVICE}"]},
        ])
        with patch.dict(os.environ, {}, clear=True):
            # Keep tool lookup so source identity can be resolved.
            os.environ["PATH"] = os.defpath + ":/usr/local/bin:/opt/homebrew/bin"
            code = m.run_profile(self.root, config, "quick")
        self.assertEqual(code, 1)
        report = m.reports(self.root)[0]
        self.assertEqual([c["state"] for c in report["checks"]], ["failed", "blocked", "passed", "blocked"])
        self.assertEqual(report["checks"][1]["reason"], "prerequisite-not-passed")
        self.assertTrue(report["sourceUnchanged"])
        good = self.config()
        self.assertEqual(m.run_profile(self.root, good, "quick"), 0)
        self.assertEqual(m.run_profile(self.root, good, "quick"), 0)
        self.assertEqual(len(m.reports(self.root)), 3)

    def test_changed_source_cannot_report_full_success(self):
        config = self.config([{"id": "one", "argv": ["{python}", "-c", "from pathlib import Path; Path('new-source.py').write_text('new')"]}])
        self.assertEqual(m.run_profile(self.root, config, "quick"), 2)
        self.assertFalse(m.reports(self.root)[0]["sourceUnchanged"])

    def test_missing_platform_and_manual_checks_are_not_passes(self):
        config = self.config([{"id": "device", "platforms": ["unavailable-os"], "argv": ["no"]}, {"id": "manual"}])
        self.assertEqual(m.run_profile(self.root, config, "quick"), 2)
        self.assertEqual([c["state"] for c in m.reports(self.root)[0]["checks"]], ["blocked", "blocked"])

    def test_replay_one_check_also_runs_dependencies(self):
        config = self.config([{"id": "first", "argv": ["{python}", "-c", "pass"]},
                              {"id": "unrelated", "argv": ["no-such-command"]},
                              {"id": "last", "argv": ["{python}", "-c", "pass"], "needs": ["first"]}])
        self.assertEqual(m.run_profile(self.root, config, "quick", "last"), 0)
        self.assertEqual([c["id"] for c in m.reports(self.root)[0]["checks"]], ["first", "last"])

    def test_local_memory_is_bounded_relevant_and_not_executed(self):
        mem = self.root / ".agent-memory"
        (mem / "notes").mkdir(parents=True)
        (mem / "config.json").write_text(json.dumps({"sourcePath": ".agent-memory/CORE.md"}))
        (mem / "CORE.md").write_text("### Tests\n`.agent-memory/notes/test.md`\n- Workroom regression\n### Other\n`.agent-memory/notes/other.md`\n- unrelated\n")
        (mem / "notes/test.md").write_text("### Workroom test lesson\nDo not execute: touch PWNED\n" + "regression " * 1000)
        (mem / "notes/other.md").write_text("SECRET OTHER SECTION")
        before = (mem / "notes/test.md").read_bytes()
        result = m.memory_evidence(self.root, ["workroom test"])
        self.assertEqual(result["state"], "available")
        self.assertLessEqual(sum(len(e["text"]) for e in result["excerpts"]), 6000)
        self.assertNotIn("SECRET OTHER SECTION", str(result))
        self.assertFalse((self.root / "PWNED").exists())
        self.assertEqual(before, (mem / "notes/test.md").read_bytes())

    def test_linked_worktree_recalls_primary_memory_only(self):
        self.test_local_memory_is_bounded_relevant_and_not_executed()
        linked = self.root / "linked"
        subprocess.run(["git", "-C", str(self.root), "worktree", "add", "--detach", str(linked)], check=True, capture_output=True)
        result = m.memory_evidence(linked, ["workroom"])
        self.assertEqual(result["state"], "available")
        self.assertFalse((linked / ".agent-memory").exists())

    def test_no_matching_memory_or_memory_not_needed(self):
        self.assertEqual(m.memory_evidence(self.root, ["workroom"])["state"], "unavailable")
        self.assertEqual(m.memory_evidence(self.root, [])["state"], "not-needed")

    def test_scaffold_preview_is_read_only_and_preserves_existing(self):
        m.init_project(self.root)
        self.assertFalse((self.root / m.CONFIG).exists())
        m.init_project(self.root, True)
        data = m.load_config(self.root)
        self.assertNotIn("argv", data["checks"][0])
        self.assertEqual(m.run_profile(self.root, data, "quick"), 2)
        original = (self.root / m.CONFIG).read_bytes()
        with self.assertRaises(ValueError):
            m.init_project(self.root, True)
        self.assertEqual(original, (self.root / m.CONFIG).read_bytes())
        ignored = subprocess.run(["git", "-C", str(self.root), "check-ignore", ".agentstoz/maintainer/runs/example/report.json"], capture_output=True)
        self.assertEqual(ignored.returncode, 0)

    def test_scaffold_uses_existing_project_command(self):
        (self.root / "package.json").write_text(json.dumps({"scripts": {"test": "example", "verify": "example"}}))
        (self.root / "bun.lock").write_text("")
        m.init_project(self.root, True)
        self.assertEqual(m.load_config(self.root)["checks"][0]["argv"], ["bun", "run", "verify"])

    def test_baseline_needs_three_matching_successful_runs(self):
        config = self.config()
        self.assertEqual(m.run_profile(self.root, config, "quick"), 0)
        with self.assertRaises(ValueError):
            m.make_baseline(self.root, "quick")
        for _ in range(2):
            self.assertEqual(m.run_profile(self.root, config, "quick"), 0)
        m.make_baseline(self.root, "quick")
        report = m.reports(self.root)[0]
        self.assertEqual(m.compare_baseline(self.root, report)["state"], "comparable")
        report["comparisonKey"] = "other"
        self.assertEqual(m.compare_baseline(self.root, report)["state"], "different-config-or-environment")

    def test_latest_report_uses_start_time_not_random_id(self):
        for suffix, timestamp in [("ffffffff", "2026-09-14T00:00:00.100000+00:00"), ("00000000", "2026-09-14T00:00:00.900000+00:00")]:
            run_id = "20260914T000000Z-" + suffix
            report = {"schemaVersion": 1, "runId": run_id, "startedAt": timestamp}
            m.save_text(self.root, m.STATE + "/runs/" + run_id + "/report.json", json.dumps(report))
        self.assertTrue(m.reports(self.root)[0]["runId"].endswith("00000000"))

    def test_new_run_is_visible_before_first_check_finishes(self):
        self.config([{"id": "one", "argv": ["{python}", "-c", "import time;time.sleep(1)"]}])
        child = subprocess.Popen([sys.executable, str(SCRIPT), "run", "--root", str(self.root)], stdout=subprocess.DEVNULL)
        try:
            deadline = time.monotonic() + 5
            while time.monotonic() < deadline and not m.reports(self.root):
                time.sleep(0.01)
            report = m.reports(self.root)[0]
            self.assertEqual(report["state"], "running")
            self.assertEqual(report["checks"], [])
            self.assertEqual(child.wait(timeout=5), 0)
        finally:
            if child.poll() is None:
                child.kill(); child.wait()

    def test_comparison_invalidates_on_device_input_or_dependency_change(self):
        config = self.config([{"id": "one", "argv": ["echo", "{env:AGENTSTOZ_TEST_DEVICE}"]}])
        with patch.dict(os.environ, {"AGENTSTOZ_TEST_DEVICE": "device-A"}):
            before = m.comparison_identity(self.root, config, ["one"], {})
        with patch.dict(os.environ, {"AGENTSTOZ_TEST_DEVICE": "device-B"}):
            after = m.comparison_identity(self.root, config, ["one"], {})
            self.assertNotEqual(before, after)
            (self.root / "bun.lock").write_text("changed")
            self.assertNotEqual(after, m.comparison_identity(self.root, config, ["one"], {}))

    @unittest.skipUnless(hasattr(os, "mkfifo"), "FIFO available on POSIX")
    def test_special_files_do_not_hang_source_or_memory_reads(self):
        os.mkfifo(self.root / "named-pipe")
        # Git omits untracked FIFOs. Explicit memory/config reads must still
        # reject them without waiting for a writer; bound the regression itself.
        self.assertIsNotNone(m.source_identity(self.root)["fingerprint"])
        previous = signal.signal(signal.SIGALRM, lambda *_: (_ for _ in ()).throw(TimeoutError("FIFO read hung")))
        signal.alarm(3)
        try:
            with self.assertRaises(ValueError):
                m.read_json(self.root / "named-pipe")
        finally:
            signal.alarm(0)
            signal.signal(signal.SIGALRM, previous)

    def test_corrupt_memory_is_unavailable_not_runner_crash(self):
        mem = self.root / ".agent-memory"
        mem.mkdir()
        (mem / "config.json").write_text("[]")
        self.assertEqual(m.memory_evidence(self.root, ["test"])["state"], "unavailable")

    def test_exported_python_project_runs_from_an_unrelated_folder(self):
        # A real new repository without a pre-existing Python ignore rule.
        (self.root / ".gitignore").write_text("")
        (self.root / "tests").mkdir()
        (self.root / "tests/test_example.py").write_text("import unittest\nclass Example(unittest.TestCase):\n def test_example(self): self.assertEqual(2+2,4)\n")
        m.init_project(self.root, True)
        copied = self.root / "scripts/agentstoz-maintainer.py"
        completed = subprocess.run([sys.executable, str(copied), "run"], cwd=tempfile.gettempdir(), capture_output=True, text=True, timeout=10)
        self.assertEqual(completed.returncode, 0, completed.stdout + completed.stderr)
        report = m.reports(self.root)[0]
        self.assertEqual(report["state"], "passed")
        self.assertTrue(report["sourceUnchanged"])
        self.assertFalse((self.root / "tests/__pycache__").exists())


if __name__ == "__main__":
    unittest.main()
