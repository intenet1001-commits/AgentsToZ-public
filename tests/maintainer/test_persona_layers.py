"""Common perspectives are templates; project journeys and real checks own verdicts."""
import importlib.util
import json
from pathlib import Path
import subprocess
import sys
import tempfile
import unittest
from unittest.mock import patch

SCRIPT = Path(__file__).resolve().parents[2] / 'scripts/agentstoz-maintainer.py'
spec = importlib.util.spec_from_file_location('persona_layers_runner', SCRIPT)
m = importlib.util.module_from_spec(spec)
spec.loader.exec_module(m)


class PersonaLayers(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.root = Path(self.temp.name).resolve()
        subprocess.run(['git', 'init', '-q', str(self.root)], check=True)
        (self.root / '.gitignore').write_text('.agentstoz/maintainer/\n__pycache__/\nran\n')
        subprocess.run(['git', '-C', str(self.root), 'add', '.gitignore'], check=True)
        subprocess.run(['git', '-C', str(self.root), '-c', 'user.name=Fixture', '-c', 'user.email=fixture@example.invalid', 'commit', '-qm', 'Fixture'], check=True)
        (self.root / '.agentstoz').mkdir()
        (self.root / m.CONFIG).write_text(json.dumps({'schemaVersion': 1, 'profiles': {'quick': ['search']}, 'checks': [
            {'id': 'search', 'argv': ['{python}', '-c', 'from pathlib import Path;Path("ran").write_text("ran")'], 'covers': ['프로젝트 찾기']}
        ]}))
        self.install()

    def tearDown(self):
        self.temp.cleanup()

    def install(self):
        plan = m.setup_plan(self.root)
        return m.apply_setup(self.root, plan['revision'])

    def create(self, **changes):
        values = {'template_id': 'first-time-user', 'revision': m.persona_evolution(self.root)['context']['revision'],
                  'goal': '새 Mac에서 첫 프로젝트를 찾는다', 'check_ids': ['search'],
                  'situation': '처음 설치한 Mac에서 프로젝트 이름만 알고 있다',
                  'journey': ['프로젝트 목록을 연다', '이름을 검색한다', '프로젝트를 연다'],
                  'success_criteria': ['검색 결과에서 원하는 프로젝트를 구분할 수 있다']}
        values.update(changes)
        return m.create_persona(self.root, **values)

    def test_common_install_is_not_catalog_activation_or_test_execution(self):
        pack = m.persona_evolution(self.root)['commonPersonas']
        self.assertEqual(pack['state'], 'ready')
        self.assertEqual([p['id'] for p in pack['templates']], ['first-time-user', 'regular-user', 'returning-user'])
        self.assertFalse((self.root / m.PERSONA_CATALOG).exists())
        self.assertFalse((self.root / 'ran').exists())
        self.assertEqual(m.persona_summary(self.root)['state'], 'none')

    def test_project_inherits_common_perspective_and_keeps_its_own_journey(self):
        result = self.create()
        self.assertIsNone(result['verdict'])
        self.assertFalse((self.root / 'ran').exists())
        persona = m.load_personas(self.root)[1][0]
        self.assertEqual(persona['template']['id'], 'first-time-user')
        self.assertEqual(persona['journey'][1], '이름을 검색한다')
        brief = m.persona_brief(self.root, result['personaId'])['brief']
        for text in ['처음 사용자', '처음 설치한 Mac', '이름을 검색한다', '원하는 프로젝트를 구분']:
            self.assertIn(text, brief)
        self.assertEqual(m.run_personas(self.root)['code'], 0)
        self.assertTrue((self.root / 'ran').exists())

    def test_update_preserves_project_catalog_and_checks_byte_for_byte(self):
        self.create()
        before = [(self.root / p).read_bytes() for p in (m.PERSONA_CATALOG, m.CONFIG)]
        newer = [{**p, 'perspective': p['perspective'] + ' · 공통 개선'} for p in m.COMMON_PERSONAS]
        with patch.object(m, 'COMMON_PERSONAS', newer), patch.object(m, 'COMMON_PERSONA_PACK_VERSION', '1.1.0'):
            self.install()
            self.assertEqual(m.persona_evolution(self.root)['commonPersonas']['version'], '1.1.0')
            self.assertIn('공통 개선', m.load_personas(self.root)[1][0]['template']['perspective'])
        self.assertEqual(before, [(self.root / p).read_bytes() for p in (m.PERSONA_CATALOG, m.CONFIG)])

    def test_locally_edited_common_template_is_preserved_and_reported(self):
        path = self.root / m.common_persona_path(m.COMMON_PERSONAS[0])
        value = json.loads(path.read_text()); value['perspective'] = '로컬에서 편집한 관점'
        path.write_text(json.dumps(value, ensure_ascii=False)); before = path.read_bytes()
        self.install()
        self.assertEqual(path.read_bytes(), before)
        self.assertEqual(m.persona_evolution(self.root)['commonPersonas']['state'], 'modified')
        self.assertIn(str(path.relative_to(self.root)), m.persona_pack_state(self.root)['modified'])

    def test_stale_template_review_and_unknown_or_empty_evidence_do_not_create(self):
        revision = m.persona_evolution(self.root)['context']['revision']
        path = self.root / m.common_persona_path(m.COMMON_PERSONAS[0])
        value = json.loads(path.read_text()); value['perspective'] += ' 최신 내용'
        path.write_text(json.dumps(value, ensure_ascii=False))
        with self.assertRaisesRegex(ValueError, 'context changed'):
            self.create(revision=revision)
        for changes in [{'template_id': 'unknown'}, {'check_ids': []}, {'check_ids': ['missing']}, {'journey': []}, {'success_criteria': []}]:
            with self.subTest(changes=changes), self.assertRaises(ValueError):
                self.create(**changes)
        self.assertFalse((self.root / m.PERSONA_CATALOG).exists())

    def test_replay_and_crash_recovery_do_not_duplicate_or_erase_custom_fields(self):
        revision = m.persona_evolution(self.root)['context']['revision']
        original = m.save_text
        def crash(root, relative, text):
            if relative.startswith(m.PERSONA_REVIEWS) and json.loads(text).get('state') == 'committed':
                raise OSError('lost receipt')
            return original(root, relative, text)
        with patch.object(m, 'save_text', side_effect=crash), self.assertRaises(OSError):
            self.create(revision=revision)
        self.assertTrue(self.create(revision=revision)['replayed'])
        self.assertTrue(self.create(revision=revision)['replayed'])
        self.assertEqual(len(m.load_personas(self.root)[1]), 1)
        self.assertEqual(m.load_personas(self.root)[1][0]['journey'][1], '이름을 검색한다')

    def test_template_update_marks_old_verdict_as_requiring_a_new_run(self):
        self.create(); m.run_personas(self.root)
        self.assertEqual(m.persona_summary(self.root)['latest']['verdicts'][0]['freshness'], 'current')
        path = self.root / m.common_persona_path(m.COMMON_PERSONAS[0])
        value = json.loads(path.read_text()); value['perspective'] += ' 새로운 공통 기준'
        path.write_text(json.dumps(value, ensure_ascii=False))
        self.assertEqual(m.persona_summary(self.root)['latest']['verdicts'][0]['freshness'], 'definition-changed')
        m.run_personas(self.root)
        self.assertEqual(m.persona_summary(self.root)['latest']['verdicts'][0]['freshness'], 'current')

    def test_common_templates_never_provide_commands_or_accept_foreign_ids(self):
        path = self.root / m.common_persona_path(m.COMMON_PERSONAS[0])
        for patch_value in [{'argv': ['echo', 'unsafe']}, {'id': 'regular-user'}, {'schemaVersion': 999}]:
            value = dict(m.COMMON_PERSONAS[0]); value.update(patch_value)
            path.write_text(json.dumps(value))
            with self.assertRaises(ValueError):
                self.create()

    def test_cli_lists_templates_and_creates_only_the_reviewed_project_extension(self):
        prefix = [sys.executable, '-B', str(SCRIPT), 'personas']
        suffix = ['--root', str(self.root), '--json']
        listed = subprocess.run(prefix + ['templates'] + suffix, capture_output=True, text=True)
        self.assertEqual(listed.returncode, 0, listed.stderr)
        self.assertEqual(len(json.loads(listed.stdout)['templates']), 3)
        revision = m.persona_evolution(self.root)['context']['revision']
        created = subprocess.run(prefix + ['create', 'regular-user'] + suffix + ['--revision', revision,
            '--goal', 'repeat a project task', '--situation', 'an existing task is available',
            '--journey-step', 'find the task', '--success-criterion', 'keep the previous input',
            '--evidence-check', 'search'], capture_output=True, text=True)
        self.assertEqual(created.returncode, 0, created.stderr)
        self.assertTrue(json.loads(created.stdout)['accepted'])
        self.assertFalse((self.root / 'ran').exists())

    def test_newer_pack_is_not_downgraded_by_an_older_app(self):
        self.create()
        before = (self.root / m.PERSONA_CATALOG).read_bytes()
        metadata = json.loads((self.root / m.TESTER_META).read_text())
        metadata['personaPack']['version'] = '999.0.0'
        (self.root / m.TESTER_META).write_text(json.dumps(metadata))
        self.assertEqual(m.inspect_project(self.root)['installation'], 'unsupported')

        with self.assertRaisesRegex(ValueError, 'Newer'):
            self.install()
        with self.assertRaisesRegex(ValueError, 'Newer'):
            self.create(goal='another goal')
        self.assertEqual((self.root / m.PERSONA_CATALOG).read_bytes(), before)
        metadata['personaPack']['version'] = m.COMMON_PERSONA_PACK_VERSION
        metadata['personaPack']['hashes'] = []
        (self.root / m.TESTER_META).write_text(json.dumps(metadata))
        self.assertEqual(m.inspect_project(self.root)['installation'], 'unsupported')

    def test_invalid_persona_catalog_does_not_hide_other_project_checks(self):
        self.create()
        duplicate = self.root / m.PERSONA_LEGACY_CATALOG
        duplicate.parent.mkdir(parents=True)
        duplicate.write_bytes((self.root / m.PERSONA_CATALOG).read_bytes())
        status = m.inspect_project(self.root)
        self.assertEqual(status['installation'], 'ready')
        self.assertEqual(status['personas']['state'], 'invalid')
        self.assertIn('Two persona catalogs', status['personas']['problem'])
        self.assertEqual(m.run_profile(self.root, m.load_config(self.root), 'quick'), 0)

    def test_large_inherited_context_cannot_cut_mandatory_brief_instructions(self):
        path = self.root / m.common_persona_path(m.COMMON_PERSONAS[0])
        template = json.loads(path.read_text())
        template.update(title='가' * 500, perspective='나' * 500, situation='다' * 500)
        path.write_text(json.dumps(template, ensure_ascii=False))
        long = ['라' * 299] * 16
        (self.root / m.PERSONA_CATALOG).write_text(json.dumps({'schemaVersion': 1, 'personas': [{
            'id': 'long-context', 'extends': 'first-time-user', 'goal': '마' * 500, 'situation': '바' * 500,
            'journey': long, 'successCriteria': long,
            'tests': [{'argv': ['{python}', '-c', 'pass'], 'kind': 'contract', 'name': f't{i}'} for i in range(32)],
            'explore': {'successCriteria': long, 'forbidden': long, 'surfaces': long}}]}, ensure_ascii=False))
        brief = m.persona_brief(self.root, 'long-context')['brief']
        self.assertLessEqual(len(brief.encode('utf-8')), m.PERSONA_BRIEF_BYTES)
        for text in [*m.DEFAULT_FORBIDDEN, '실제 화면', '회귀 테스트', 'PASS/FAIL로 보고하지 마세요', '## 보고 형식', 'regressionTest:']:
            self.assertIn(text, brief)


if __name__ == '__main__':
    unittest.main()
