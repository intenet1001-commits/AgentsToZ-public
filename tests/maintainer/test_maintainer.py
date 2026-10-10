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
original_initial = m.initial_files


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

    @unittest.skipIf(os.name == 'nt', 'POSIX symlink fixture')
    def test_linked_worktree_symlinked_requirement_loads_and_runs(self):
        # The app links node_modules into linked worktrees (api-server.ts). A
        # required precondition may be a link; storage paths still may not.
        shared = Path(tempfile.mkdtemp(prefix='agentstoz-shared-deps-'))
        self.addCleanup(shutil.rmtree, shared, True)
        (shared / 'marker').write_text('dependency')
        # A directory-only ignore rule leaves the link itself untracked.
        (self.root / '.gitignore').write_text('.agentstoz/maintainer/\n__pycache__/\nnode_modules/\n')
        subprocess.run(['git', '-C', str(self.root), '-c', 'user.name=Fixture', '-c', 'user.email=fixture@example.invalid',
                        'commit', '-qam', 'ignore'], check=True)
        (self.root / 'node_modules').symlink_to(shared, target_is_directory=True)
        config = self.config([{'id': 'deps', 'requires': ['node_modules'],
                               'argv': ['{python}', '-c', "print(open('node_modules/marker').read())"], 'timeoutSeconds': 5}])
        self.assertEqual(m.run_profile(self.root, config, 'quick'), 0)
        report = m.reports(self.root)[0]
        self.assertEqual(report['state'], 'passed')
        self.assertTrue(report['sourceUnchanged'])
        self.assertIsNotNone(m.inspect_project(self.root, True)['latest'])
        # A dangling link is a missing precondition, not a pass or a crash.
        (self.root / 'node_modules').unlink()
        (self.root / 'node_modules').symlink_to(shared / 'gone', target_is_directory=True)
        self.assertEqual(m.run_profile(self.root, config, 'quick'), 2)
        self.assertEqual(m.reports(self.root)[0]['checks'][0]['reason'], 'required-project-file-unavailable')
        for escape in ['../outside', '/etc']:
            with self.assertRaises(ValueError):
                self.config([{'id': 'deps', 'requires': [escape], 'argv': ['{python}', '-c', 'pass']}])

    def test_runner_changes_ship_under_a_new_version(self):
        version = lambda v: tuple(int(x) for x in v.split('.'))
        current = m.digest(SCRIPT.read_bytes())
        self.assertNotIn(m.VERSION, m.RELEASED_RUNNERS, 'bump VERSION: this version already shipped')
        self.assertNotIn(current, m.RELEASED_RUNNERS.values(), 'a released runner must not be relabelled')
        self.assertGreater(version(m.VERSION), max(map(version, m.RELEASED_RUNNERS)))
        self.assertEqual(m.LEGACY_RUNNER_HASHES, set(m.RELEASED_RUNNERS.values()))

    def test_every_released_runner_is_recognised_as_an_upgrade_source(self):
        # 1.1.0 was missing, so a 1.1.0 install without metadata read as a local edit.
        self.assertIn('78721b0393ec39d703e42046e539a1e8ecfb6592647cff450d82ec4a36988646', m.LEGACY_RUNNER_HASHES)
        plan = m.setup_plan(self.root); m.apply_setup(self.root, plan['revision'])
        (self.root / m.TESTER_META).unlink()
        with patch.object(m, 'LEGACY_RUNNER_HASHES', {m.digest((self.root / m.RUNNER).read_text())}), \
                patch.object(m, 'initial_files', lambda root: {**original_initial(root), m.RUNNER: '# newer runner\n'}):
            self.assertEqual(m.inspect_project(self.root)['installation'], 'needs-update')

    def test_history_is_append_only_and_stats_learn_failures_and_flakiness(self):
        toggle = Path(tempfile.mkdtemp(prefix='agentstoz-toggle-'))
        self.addCleanup(shutil.rmtree, toggle, True)
        flip = ("import pathlib,sys; p=pathlib.Path(sys.argv[1])/'seen'; first=not p.exists(); "
                "p.write_text('x'); raise SystemExit(1 if first else 0)")
        config = self.config([{'id': 'flip', 'argv': ['{python}', '-c', flip, str(toggle)], 'timeoutSeconds': 5},
                              {'id': 'steady', 'argv': ['{python}', '-c', 'pass'], 'timeoutSeconds': 5}])
        self.assertEqual(m.run_profile(self.root, config, 'quick'), 1)
        self.assertEqual(m.run_profile(self.root, config, 'quick'), 0)
        lines = (self.root / m.HISTORY).read_text().splitlines()
        self.assertEqual(len(lines), 4)
        self.assertEqual([json.loads(v)['id'] for v in lines], ['flip', 'steady', 'flip', 'steady'])
        stats = json.loads((self.root / m.STATS).read_text())['checks']
        self.assertEqual((stats['flip']['runs'], stats['flip']['passed'], stats['flip']['failed']), (2, 1, 1))
        # Same source and environment, different outcome: deterministic flakiness evidence.
        self.assertEqual(stats['flip']['flakySources'], 1)
        self.assertEqual(stats['flip']['flakyRate'], 1.0)
        self.assertEqual(stats['flip']['lastState'], 'passed')
        self.assertIsNotNone(stats['flip']['lastFailedAt'])
        self.assertEqual(stats['steady']['flakyRate'], 0)
        self.assertGreaterEqual(stats['steady']['averageSeconds'], 0)

    def test_history_retention_is_bounded_by_size_not_run_count(self):
        config = self.config()
        with patch.object(m, 'HISTORY_MAX_BYTES', 300):
            for _ in range(4):
                self.assertEqual(m.run_profile(self.root, config, 'quick'), 0)
        current, older = self.root / m.HISTORY, self.root / m.HISTORY_OLD
        self.assertTrue(older.exists())
        self.assertLessEqual(current.stat().st_size, 300 + 1000)
        stats = json.loads((self.root / m.STATS).read_text())['checks']['one']
        self.assertGreaterEqual(stats['runs'], 2)

    def test_reason_classes_separate_missing_tool_platform_input_and_failure(self):
        config = self.config([
            {'id': 'bad', 'argv': ['{python}', '-c', 'raise SystemExit(3)']},
            {'id': 'tool', 'argv': ['agentstoz-nonexistent-fixture-tool']},
            {'id': 'device', 'platforms': ['unavailable-os'], 'argv': ['no']},
            {'id': 'phone', 'argv': ['{python}', '-c', 'pass', '{env:AGENTSTOZ_MISSING_FIXTURE_INPUT}']},
            {'id': 'manual'},
            {'id': 'after', 'argv': ['{python}', '-c', 'pass'], 'needs': ['bad']},
            {'id': 'ok', 'argv': ['{python}', '-c', 'pass']},
        ])
        self.assertEqual(m.run_profile(self.root, config, 'quick'), 1)
        report = m.reports(self.root)[0]
        self.assertEqual({c['id']: c.get('reasonClass') for c in report['checks']},
                         {'bad': 'nonzero-exit', 'tool': 'missing-tool', 'device': 'not-applicable',
                          'phone': 'missing-input', 'manual': 'manual', 'after': 'prerequisite', 'ok': None})
        self.assertEqual(report['state'], 'failed')
        self.assertEqual(report['summary'], {'passed': 1, 'failed': 1, 'skipped': 1, 'missingTool': 1,
                                             'blocked': 3, 'interrupted': 0})
        self.assertIn('missing-tool', m.report_markdown(report))

    def test_run_retention_keeps_the_latest_run_of_every_profile(self):
        checks = [{'id': 'one', 'argv': ['{python}', '-c', 'pass'], 'timeoutSeconds': 3}]
        data = {'schemaVersion': 1, 'profiles': {'quick': ['one'], 'slow': ['one']}, 'checks': checks}
        (self.root / '.agentstoz').mkdir(exist_ok=True)
        (self.root / m.CONFIG).write_text(json.dumps(data))
        config = m.load_config(self.root)
        self.assertEqual(m.run_profile(self.root, config, 'slow'), 0)
        for _ in range(11):
            self.assertEqual(m.run_profile(self.root, config, 'quick'), 0)
        kept = m.reports(self.root)
        self.assertEqual(len(kept), 11)
        self.assertIn('slow', [r['profile'] for r in kept])

    def scenario(self, name, steps, layer='project', **extra):
        data = {'schemaVersion': 1, 'id': layer + '.' + name, 'title': name, 'intent': 'fixture ' + name,
                'safety': 'read-only', 'steps': steps, **extra}
        folder = self.root / '.agentstoz/scenarios' / layer
        folder.mkdir(parents=True, exist_ok=True)
        (folder / (name + '.json')).write_text(json.dumps(data))
        return data

    def test_scenario_lint_rejects_destructive_or_networked_steps(self):
        self.config()
        cmd = lambda *argv: [{'type': 'command', 'argv': list(argv)}]
        self.scenario('safe', cmd('{python}', '-c', 'pass'))
        unsafe = {'push': cmd('git', 'push'), 'deploy': cmd('bun', 'run', 'deploy:prod'), 'remove': cmd('rm', '-rf', 'x'),
                  'shell': cmd('sh', '-c', 'echo hi'), 'install': cmd('npm', 'install'), 'pip': cmd('{python}', '-m', 'pip', 'install', 'x'),
                  'curl': cmd('curl', 'https://example.com'), 'publish': cmd('cargo', 'publish'),
                  'remote': [{'type': 'http', 'method': 'GET', 'url': 'https://example.com/'}],
                  'post': [{'type': 'http', 'method': 'POST', 'url': 'http://127.0.0.1:1/'}]}
        for name, steps in unsafe.items():
            self.scenario(name, steps)
        folder = self.root / '.agentstoz/scenarios/project'
        (folder / 'renamed.json').write_text(json.dumps({**json.loads((folder / 'safe.json').read_text())}))
        (folder / 'bad-safety.json').write_text(json.dumps({'schemaVersion': 1, 'id': 'project.bad-safety', 'title': 't', 'intent': 'i',
                                                           'safety': 'anything', 'steps': cmd('{python}', '-c', 'pass')}))
        result = m.lint_scenarios(self.root)
        failing = {Path(e['file']).stem for e in result['errors']}
        self.assertEqual(failing, set(unsafe) | {'renamed', 'bad-safety'})
        self.assertIn('project.safe', result['valid'])
        scenarios, errors = m.load_scenarios(self.root)
        self.assertEqual([s['id'] for s in scenarios], ['project.safe'])

    def test_scenario_steps_and_assertions_report_honestly(self):
        config = self.config()
        self.scenario('hello', [{'type': 'command', 'argv': ['{python}', '-c', "print('HELLO world')"]}],
                      assertions=[{'outputContains': 'HELLO'}, {'outputNotMatches': '\\bfail'}, {'maxSeconds': 60}])
        self.scenario('miss', [{'type': 'command', 'argv': ['{python}', '-c', "print('other')"]}],
                      assertions=[{'outputContains': 'HELLO'}])
        self.scenario('exit', [{'type': 'command', 'argv': ['{python}', '-c', 'raise SystemExit(2)']}],
                      assertions=[{'exitCode': 2}])
        self.scenario('tool', [{'type': 'command', 'argv': ['agentstoz-nonexistent-fixture-tool']}])
        self.scenario('later', [{'type': 'command', 'argv': ['{python}', '-c', 'pass']}], needs=['project.miss'])
        code = m.run_scenarios(self.root, config, ['project.hello', 'project.miss', 'project.exit', 'project.tool', 'project.later'])
        self.assertEqual(code, 1)
        report = m.reports(self.root)[0]
        self.assertEqual(report['profile'], 'scenarios')
        got = {c['id']: (c['state'], c.get('reasonClass')) for c in report['checks']}
        self.assertEqual(got, {'project.hello': ('passed', None), 'project.miss': ('failed', 'assertion'),
                               'project.exit': ('passed', None), 'project.tool': ('blocked', 'missing-tool'),
                               'project.later': ('blocked', 'prerequisite')})
        failed = next(c for c in report['checks'] if c['id'] == 'project.miss')
        self.assertIn('outputContains', failed['reason'])
        self.assertEqual(json.loads((self.root / m.STATS).read_text())['checks']['project.miss']['failed'], 1)

    def test_http_step_reads_only_a_local_listener(self):
        import http.server, threading as th
        server = http.server.ThreadingHTTPServer(('127.0.0.1', 0), http.server.SimpleHTTPRequestHandler)
        thread = th.Thread(target=server.serve_forever, daemon=True); thread.start()
        self.addCleanup(server.server_close); self.addCleanup(server.shutdown)
        config = self.config()
        self.scenario('health', [{'type': 'http', 'method': 'GET', 'url': 'http://127.0.0.1:{env:AGENTSTOZ_FIXTURE_PORT}/'}],
                      assertions=[{'status': 200}])
        with patch.dict(os.environ, {'AGENTSTOZ_FIXTURE_PORT': str(server.server_address[1])}):
            self.assertEqual(m.run_scenarios(self.root, config, ['project.health']), 0)
        with patch.dict(os.environ, {'AGENTSTOZ_FIXTURE_PORT': ''}):
            self.assertEqual(m.run_scenarios(self.root, config, ['project.health']), 2)
        self.assertEqual(m.reports(self.root)[0]['checks'][0]['reasonClass'], 'missing-input')
        with self.assertRaises(ValueError):
            m.http_probe('http://example.com/', 'GET', 2)

    def test_auto_run_ranks_changes_and_skips_honestly_within_budget(self):
        config = self.config()
        (self.root / 'src').mkdir()
        for name in ('a', 'b'):
            (self.root / 'src' / (name + '.py')).write_text('value = 1\n')
        subprocess.run(['git', '-C', str(self.root), 'add', 'src'], check=True)
        subprocess.run(['git', '-C', str(self.root), '-c', 'user.name=F', '-c', 'user.email=f@example.invalid', 'commit', '-qm', 'src'], check=True)
        step = [{'type': 'command', 'argv': ['{python}', '-c', 'pass']}]
        self.scenario('a', step, paths=['src/a.py'], cost={'estimateSeconds': 1})
        self.scenario('b', step, paths=['src/b.py'], cost={'estimateSeconds': 1})
        self.scenario('slow', step, tags=['smoke'], cost={'estimateSeconds': 500})
        self.scenario('phone', step, safety='needs-device', cost={'estimateSeconds': 1})
        (self.root / 'src/a.py').write_text('value = 2\n')
        self.assertEqual(m.run_auto(self.root, config, budget=5), 0)
        report = m.reports(self.root)[0]
        self.assertEqual(report['profile'], 'auto')
        self.assertEqual(report['checks'][0]['id'], 'project.a')
        states = {c['id']: (c['state'], c.get('reasonClass')) for c in report['checks']}
        self.assertEqual(states['project.slow'], ('blocked', 'budget-skipped'))
        self.assertNotIn('project.phone', states)
        self.assertIn('project.phone', report['selection']['excluded'])
        self.assertEqual(report['outcome'], 'partial')
        self.assertEqual(report['state'], 'passed')
        self.assertIn('changed', report['selection']['ranked'][0]['why'])
        # A recent failure outranks an unchanged, never-failed scenario.
        stats = {'project.b': {'lastState': 'failed', 'flakyRate': 0}}
        ranked = m.rank_candidates(m.load_scenarios(self.root)[0], stats, [])
        self.assertEqual(ranked[0]['id'], 'project.b')

    def test_auto_run_with_nothing_runnable_is_not_a_pass(self):
        config = self.config()
        self.scenario('huge', [{'type': 'command', 'argv': ['{python}', '-c', 'pass']}], cost={'estimateSeconds': 900})
        self.assertEqual(m.run_auto(self.root, config, budget=1, include_profile=False), 2)
        self.assertEqual(m.reports(self.root)[0]['reason'], 'nothing-ran')

    def test_common_scenarios_ship_with_setup_and_find_real_problems(self):
        plan = m.setup_plan(self.root)
        paths = [c['path'] for c in plan['changes']]
        for scenario in m.COMMON_SCENARIOS:
            self.assertIn(m.common_scenario_path(scenario), paths)
        m.apply_setup(self.root, plan['revision'])
        self.assertEqual(m.lint_scenarios(self.root)['errors'], [])
        self.assertEqual(m.inspect_project(self.root)['installation'], 'ready')
        config = m.load_config(self.root)
        self.assertEqual(m.run_scenarios(self.root, config, ['common.conflict-markers']), 0)
        self.assertEqual(m.run_scenarios(self.root, config, ['common.python-syntax']), 2)
        self.assertEqual(m.reports(self.root)[0]['checks'][0]['reasonClass'], 'not-applicable')
        (self.root / 'broken.py').write_text('def broken(:\n')
        (self.root / 'merge.txt').write_text('a\n<<<<<<< HEAD\nb\n=======\nc\n>>>>>>> other\n')
        (self.root / 'bad.json').write_text('{bad')
        for scenario in ('common.python-syntax', 'common.conflict-markers', 'common.json-valid'):
            self.assertEqual(m.run_scenarios(self.root, config, [scenario]), 1, scenario)
        self.assertIn('broken.py', m.reports(self.root)[1]['checks'][0]['output'] + m.reports(self.root)[2]['checks'][0]['output'])
        # A locally edited common scenario is preserved by the next setup.
        edited = self.root / m.common_scenario_path(m.COMMON_SCENARIOS[0])
        edited.write_text(edited.read_text().replace('"risk": 2', '"risk": 3'))
        self.assertNotIn(m.common_scenario_path(m.COMMON_SCENARIOS[0]), [c['path'] for c in m.setup_plan(self.root)['changes']])
        self.assertTrue(m.scenario_pack_state(self.root)['modified'])

    def test_discover_only_proposes_and_accept_is_explicit(self):
        self.config()
        (self.root / 'package.json').write_text(json.dumps({'scripts': {
            'test': 'touch RAN', 'test:unit': 'touch RAN', 'lint': 'x', 'deploy': 'x', 'release:web': 'x',
            'test:e2e': 'echo "Error: no test specified" && exit 1', 'dev': 'x'}}))
        (self.root / 'bun.lock').write_text('')
        (self.root / 'tests').mkdir(); (self.root / 'src').mkdir()
        (self.root / 'tests/foo-bar.test.ts').write_text("test('x', () => { document.querySelector('[data-testid=\"covered\"]') })\n")
        (self.root / 'tests/other.test.ts').write_text('')
        (self.root / 'src/fooBar.ts').write_text('export const a = 1\n')
        (self.root / 'src/App.tsx').write_text('<div data-testid="covered"/><div data-testid="orphan-id"/>\n')
        subprocess.run(['git', '-C', str(self.root), 'add', '.'], check=True)
        subprocess.run(['git', '-C', str(self.root), '-c', 'user.name=F', '-c', 'user.email=f@example.invalid', 'commit', '-qm', 'p'], check=True)
        (self.root / 'src/fooBar.ts').write_text('export const a = 2\n')
        failing = {'schemaVersion': 1, 'runId': '20260914T000000Z-abcdef12', 'startedAt': '2026-09-14T00:00:00+00:00',
                   'state': 'failed', 'profile': 'quick', 'checks': [{'id': 'one', 'state': 'failed', 'output': 'FAIL tests/other.test.ts > x'}]}
        m.save_text(self.root, m.STATE + '/runs/' + failing['runId'] + '/report.json', json.dumps(failing))
        result = m.discover_scenarios(self.root)
        ids = [p['id'] for p in result['proposals']]
        self.assertFalse((self.root / 'RAN').exists())
        self.assertEqual(ids[0], 'project.regression-other-test')
        self.assertIn('project.file-foo-bar-test', ids)
        for expected in ('project.script-test', 'project.script-test-unit', 'project.script-lint'):
            self.assertIn(expected, ids)
        for denied in ('project.script-deploy', 'project.script-release-web', 'project.script-dev', 'project.script-test-e2e'):
            self.assertNotIn(denied, ids)
        regression = result['proposals'][0]
        self.assertEqual(regression['steps'][0]['argv'], ['bun', 'test', 'tests/other.test.ts'])
        self.assertTrue(regression['origin'].startswith('regression:'))
        gaps = json.loads((self.root / m.GAPS).read_text())
        self.assertIn('orphan-id', gaps['untestedTestIds'])
        self.assertNotIn('covered', gaps['untestedTestIds'])
        self.assertIn('src/fooBar.ts', gaps['uncoveredChanges'])
        self.assertEqual(m.discover_scenarios(self.root)['proposals'], result['proposals'], 'deterministic')
        self.assertFalse((self.root / '.agentstoz/scenarios/project').exists())
        m.accept_scenario(self.root, 'project.script-lint')
        accepted = self.root / '.agentstoz/scenarios/project/script-lint.json'
        self.assertTrue(accepted.is_file())
        self.assertEqual(m.lint_scenarios(self.root)['errors'], [])
        with self.assertRaises(ValueError):
            m.accept_scenario(self.root, 'project.script-lint')
        m.reject_scenario(self.root, 'project.script-test')
        again = [p['id'] for p in m.discover_scenarios(self.root)['proposals']]
        self.assertNotIn('project.script-test', again)
        self.assertNotIn('project.script-lint', again)

    def test_lint_rejects_scripts_run_without_the_run_keyword(self):
        # bun, yarn, pnpm, make and npm start run a script or target by name alone.
        for argv in (['bun', 'release'], ['yarn', 'publish:prod'], ['pnpm', 'db:reset'], ['make', 'release'],
                     ['npm', 'start'], ['npm', 'stop'], ['deno', 'task', 'deploy']):
            self.assertIsNotNone(m.unsafe_argv(argv), argv)
        for argv in (['bun', 'test'], ['make', 'test'], ['npm', 'test'], ['bun', 'run', 'typecheck'], ['bun', 'tests/check.ts']):
            self.assertIsNone(m.unsafe_argv(argv), argv)

    def test_discover_judges_the_package_script_body_not_only_its_name(self):
        self.config()
        (self.root / 'package.json').write_text(json.dumps({'scripts': {
            'test': 'bun test', 'test:smoke:vercel': 'TARGET=vercel node smoke.mjs', 'check': 'bun test && git push'}}))
        (self.root / 'bun.lock').write_text('')
        result = m.discover_scenarios(self.root)
        ids = [p['id'] for p in result['proposals']]
        self.assertIn('project.script-test', ids)
        self.assertNotIn('project.script-test-smoke-vercel', ids)
        self.assertNotIn('project.script-check', ids)
        self.assertEqual({d['id'] for d in result['gaps']['droppedUnsafe']},
                         {'project.script-test-smoke-vercel', 'project.script-check'})

    def test_auto_run_handoff_reproduces_manifest_checks_with_their_profile(self):
        config = self.config([{'id': 'bad', 'argv': ['{python}', '-c', 'raise SystemExit(1)'], 'timeoutSeconds': 5}])
        self.assertEqual(m.run_auto(self.root, config, budget=600), 1)
        report = m.reports(self.root)[0]
        handoff = m.handoff_markdown(report)
        self.assertIn('--profile quick --check bad', handoff)
        self.assertNotIn('--profile auto', handoff)

    def test_status_latest_is_a_profile_run_not_a_later_scenario_run(self):
        config = self.config([{'id': 'bad', 'argv': ['{python}', '-c', 'raise SystemExit(1)'], 'timeoutSeconds': 5}])
        self.assertEqual(m.run_profile(self.root, config, 'quick'), 1)
        self.scenario('ok', [{'type': 'command', 'argv': ['{python}', '-c', 'pass']}])
        self.assertEqual(m.run_scenarios(self.root, config, ['project.ok']), 0)
        self.assertEqual(m.run_auto(self.root, config, budget=600, include_profile=False), 0)
        latest = m.inspect_project(self.root)['latest']
        self.assertEqual((latest['profile'], latest['state']), ('quick', 'failed'))

    def test_python_syntax_probe_does_not_fail_a_project_needing_a_newer_python(self):
        (self.root / 'modern.py').write_text('def f(x):\n    match x:\n        case 1:\n            return 1\n')
        (self.root / 'pyproject.toml').write_text('[project]\nname = "x"\nrequires-python = ">=3.99"\n')
        with patch('sys.stdout'):
            self.assertEqual(m.probe(self.root, 'python-syntax'), m.NOT_APPLICABLE_EXIT)
        (self.root / 'pyproject.toml').write_text('[project]\nname = "x"\nrequires-python = ">=3.8, !=3.99"\n')
        self.assertEqual(m.declared_python_minimum(self.root), (3, 8))

    def test_repository_scenarios_are_valid_and_common_pack_is_current(self):
        repo = SCRIPT.parents[1]
        result = m.lint_scenarios(repo)
        self.assertEqual(result['errors'], [])
        for seed in ('project.typecheck', 'project.tester-unit', 'project.workroom-e2e', 'project.voice-media', 'project.onboarding-ui'):
            self.assertIn(seed, result['valid'])
        for scenario in m.COMMON_SCENARIOS:
            self.assertEqual((repo / m.common_scenario_path(scenario)).read_text(), m.common_scenario_text(scenario))

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


class PromotionCandidateTests(unittest.TestCase):
    """`scenarios promote` — 공통 계층으로 올릴 후보 모으기. **읽기 전용**이다."""

    def setUp(self):
        self.temp = tempfile.TemporaryDirectory(prefix="agentstoz-promote-test-")
        self.root = Path(self.temp.name).resolve()
        subprocess.run(["git", "init", "-q", str(self.root)], check=True)
        (self.root / ".gitignore").write_text(".agentstoz/maintainer/\n__pycache__/\n")

    def tearDown(self):
        self.temp.cleanup()

    def snapshot(self):
        return {str(p.relative_to(self.root)): p.stat().st_mtime_ns
                for p in sorted(self.root.rglob("*")) if p.is_file() and ".git/" not in str(p)}

    def scenario(self, name, argv):
        folder = self.root / ".agentstoz/scenarios/project"
        folder.mkdir(parents=True, exist_ok=True)
        (folder / (name + ".json")).write_text(json.dumps({
            "schemaVersion": 1, "id": "project." + name, "title": name, "intent": "x", "origin": "manual:test",
            "paths": ["**"], "safety": "read-only", "risk": 1, "cost": {"estimateSeconds": 1},
            "steps": [{"type": "command", "argv": argv, "timeoutSeconds": 10}],
        }), encoding="utf-8")

    def test_writes_nothing_and_never_invents_a_common_id(self):
        # 공통 계층이 전 프로젝트로 퍼지는 경로를 **하나**로 묶기 위해, 이 명령은 어떤 파일도 쓰지 않고
        # 후보 id 를 `candidate.*` 로만 낸다 — 이름과 승격 여부는 사람·AI가 저장소 커밋으로 정한다.
        self.scenario("portable", ["python3", "--version"])
        before = self.snapshot()
        result = m.promotion_candidates(self.root)
        self.assertEqual(result["writes"], [])
        self.assertEqual(self.snapshot(), before, "promote must not touch the project")
        for candidate in result["candidates"]:
            self.assertTrue(candidate["id"].startswith("candidate."), candidate["id"])
            self.assertFalse(candidate["id"].startswith("common."), candidate["id"])

    def test_separates_not_proven_yet_from_tied_to_this_project(self):
        # 「아직 여기서 증명되지 않았다」와 「증명됐지만 이 프로젝트에 묶여 있다」는 다른 답이다 —
        # 합치면 사람이 무엇을 할 수 있는지가 가려진다.
        self.scenario("portable", ["python3", "--version"])
        self.scenario("local", ["python3", "scripts/only-here.py"])
        found = {c["from"]: c for c in m.promotion_candidates(self.root)["candidates"]}
        self.assertIn("runs<3", found["project.portable"]["blockers"])
        self.assertNotIn("project-specific argv", found["project.portable"]["blockers"])
        self.assertIn("project-specific argv", found["project.local"]["blockers"])
        self.assertEqual(found["project.local"]["unportable"], ["scripts/only-here.py"])

    def test_common_scenarios_are_not_offered_for_promotion(self):
        # 공통 계층에 이미 있는 것은 후보가 아니다. 프로젝트 계층만 본다.
        result = m.promotion_candidates(self.root)
        self.assertEqual([c for c in result["candidates"] if c["from"].startswith("common.")], [])


class ChangedTestFileDiscoveryTests(unittest.TestCase):
    """A changed source file may only justify a test that could actually cover it.

    Measured 2026-10-06 on the 통역사 project: name fragments paired across ecosystems and
    across modules, so `ios/.../Fanout.swift` was offered as the reason to run
    `backend/tests/test_fanout_realtime.py`. Three of its four proposals were like this.
    """

    def setUp(self):
        self.temp = tempfile.TemporaryDirectory(prefix="agentstoz-discovery-test-")
        self.root = Path(self.temp.name).resolve()
        subprocess.run(["git", "init", "-q", str(self.root)], check=True)
        (self.root / ".gitignore").write_text(".agentstoz/maintainer/\n")
        (self.root / ".agentstoz").mkdir()
        (self.root / m.CONFIG).write_text(json.dumps(
            {"schemaVersion": 1, "profiles": {"quick": ["noop"]},
             "checks": [{"id": "noop", "argv": ["{python}", "-c", "pass"], "timeoutSeconds": 3}],
             "limits": ["No real device"]}))

    def tearDown(self):
        self.temp.cleanup()

    def write(self, rel, text="x\n"):
        path = self.root / rel
        path.parent.mkdir(parents=True, exist_ok=True)
        path.write_text(text)
        return path

    def commit(self):
        subprocess.run(["git", "-C", str(self.root), "add", "-A"], check=True)
        subprocess.run(["git", "-C", str(self.root), "-c", "user.name=Fixture",
                        "-c", "user.email=fixture@example.invalid", "commit", "-qm", "base"], check=True)

    def proposals(self):
        return {p["id"]: p for p in m.discover_scenarios(self.root)["proposals"]}

    def test_a_changed_source_in_another_language_or_module_is_not_a_reason(self):
        # The monorepo shape that produced the false pairs: one manifest per module.
        self.write("package.json", json.dumps({"name": "root"}))
        self.write("backend/pyproject.toml", "[project]\nname='backend'\n")
        self.write("frontend/package.json", json.dumps({"name": "frontend"}))
        self.write("ios/App/Package.swift", "// swift\n")
        self.write("backend/tests/test_fanout_realtime.py", "import unittest\n")
        self.write("backend/tests/test_quality_metrics.py", "import unittest\n")
        self.write("backend/tests/test_settings_keys.py", "import unittest\n")
        self.commit()
        # Now change exactly the files that were wrongly paired before.
        self.write("ios/App/Sources/Fanout.swift", "// changed\n")
        self.write("scripts/eval/metrics.py", "# changed\n")
        self.write("frontend/src/phone/settings.ts", "// changed\n")
        found = self.proposals()
        for ident in ("project.file-test-fanout-realtime", "project.file-test-quality-metrics",
                      "project.file-test-settings-keys"):
            self.assertNotIn(ident, found, f"{ident} paired across languages or modules")

    def test_the_ordinary_tests_next_to_src_pair_still_works(self):
        # One module, the common `tests/` ↔ `src/` split: both resolve to the project root.
        self.write("package.json", json.dumps({"name": "app", "devDependencies": {"vitest": "1"}}))
        self.write("tests/settings.test.ts", "// test\n")
        self.write("tests/test_parser.py", "import unittest\n")
        self.commit()
        self.write("src/settings.ts", "// changed\n")
        self.write("src/parser.py", "# changed\n")
        found = self.proposals()
        self.assertIn("project.file-settings-test", found, f"same-module web pair was dropped: {sorted(found)}")
        self.assertIn("project.file-test-parser", found, f"same-module python pair was dropped: {sorted(found)}")
        self.assertIn("src/settings.ts", found["project.file-settings-test"]["paths"])
        self.assertIn("src/parser.py", found["project.file-test-parser"]["paths"])

    def test_module_root_and_family_are_decided_in_one_place(self):
        self.write("backend/pyproject.toml", "[project]\nname='b'\n")
        self.write("package.json", json.dumps({"name": "root"}))
        cache = {}
        self.assertEqual(m.module_root(self.root, "backend/tests/test_a.py", cache), "backend")
        self.assertEqual(m.module_root(self.root, "scripts/eval/metrics.py", cache), "")
        self.assertEqual(m.language_family("a.swift"), None)
        self.assertEqual(m.language_family("a.tsx"), m.language_family("b.vue"))
        self.assertFalse(m.covers_changed_source(self.root, "backend/tests/test_a.py", "x/a.swift", cache))
        self.assertFalse(m.covers_changed_source(self.root, "backend/tests/test_a.py", "scripts/a.py", cache))
        self.assertTrue(m.covers_changed_source(self.root, "backend/tests/test_a.py", "backend/src/a.py", cache))
