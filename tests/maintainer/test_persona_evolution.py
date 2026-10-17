"""Growing project-owned personas: candidates, real evidence, CAS and crash receipts."""
import importlib.util
import json
import pathlib
import subprocess
import sys
import tempfile
import unittest
from unittest.mock import patch

SCRIPT=pathlib.Path(__file__).resolve().parents[2]/'scripts/agentstoz-maintainer.py'
spec=importlib.util.spec_from_file_location('persona_evolution_runner',SCRIPT)
m=importlib.util.module_from_spec(spec);spec.loader.exec_module(m)

class Evolution(unittest.TestCase):
    def setUp(self):
        self.temp=tempfile.TemporaryDirectory();self.root=pathlib.Path(self.temp.name)
        (self.root/'.agentstoz').mkdir();(self.root/'src').mkdir()
        self.marker=self.root/'ran'
        self.config={'schemaVersion':1,'profiles':{'quick':['voice']},'checks':[
            {'id':'voice','argv':[sys.executable,'-c',f'from pathlib import Path;Path({str(self.marker)!r}).write_text("ran")'],
             'covers':['음성 창으로 요청하기'],'paths':['src/voice.ts'],'evidence':'rendered-browser'},
            {'id':'other','argv':[sys.executable,'-c','pass'],'covers':['프로젝트 조회'],'paths':['src/other.ts']}]}
        (self.root/m.CONFIG).write_text(json.dumps(self.config))
        (self.root/'src/voice.ts').write_text('old');(self.root/'.gitignore').write_text('.agentstoz/maintainer/\nran\n')
        for args in [['init','-q'],['add','.'],['-c','user.name=Fixture','-c','user.email=fixture@example.invalid','commit','-qm','Fixture']]:
            subprocess.run(['git',*args],cwd=self.root,check=True,stdout=subprocess.DEVNULL)
        (self.root/'src/voice.ts').write_text('new feature')
    def tearDown(self):self.temp.cleanup()
    def candidate(self):
        result=m.discover_personas(self.root);self.assertEqual(len(result['candidates']),1)
        return result['candidates'][0],result['context']['revision']
    def accept(self,c,r,goal='여러 창에서 음성 요청을 하는 사람',checks=None):
        return m.review_persona(self.root,c['id'],r,goal,checks or ['voice'])
    def test_discovery_is_contextual_and_never_runs_or_activates(self):
        c,r=self.candidate();self.assertEqual(c['evidence']['changedPaths'],['src/voice.ts'])
        self.assertFalse(self.marker.exists());self.assertFalse((self.root/m.PERSONA_CATALOG).exists())
        self.assertEqual(m.discover_personas(self.root)['candidates'][0]['id'],c['id'])
    def test_approval_connects_real_checks_and_only_a_run_produces_a_verdict(self):
        c,r=self.candidate();result=self.accept(c,r)
        self.assertIsNone(result['verdict']);self.assertFalse(self.marker.exists())
        p=m.load_personas(self.root)[1][0];self.assertEqual(p['tests'][0]['check'],'voice');self.assertEqual(p['tests'][0]['kind'],'screen')
        run=m.run_personas(self.root);self.assertEqual(run['code'],0);self.assertTrue(self.marker.exists())
        self.assertEqual(run['verdicts'][0]['verdict'],'PASS')
    def test_stale_context_does_not_modify_catalog(self):
        c,r=self.candidate();(self.root/'src/voice.ts').write_text('changed again')
        with self.assertRaisesRegex(ValueError,'context changed'):self.accept(c,r)
        self.assertFalse((self.root/m.PERSONA_CATALOG).exists())
        fresh=m.discover_personas(self.root);self.assertNotEqual(fresh['context']['revision'],r)
    def test_retired_check_candidate_can_be_rejected_at_the_current_context(self):
        c,r=self.candidate();self.config['checks'].pop(0);self.config['profiles']['quick']=['other']
        (self.root/m.CONFIG).write_text(json.dumps(self.config))
        fresh=m.discover_personas(self.root);self.assertNotEqual(fresh['context']['revision'],r)
        self.assertEqual(fresh['candidates'][0]['contextRevision'],r)
        self.assertFalse(m.review_persona(self.root,c['id'],fresh['context']['revision'],reject=True)['accepted'])
        self.assertFalse((self.root/m.PERSONA_CATALOG).exists());self.assertEqual(m.persona_evolution(self.root)['candidates'],[])
    def test_unknown_or_empty_evidence_never_activates(self):
        c,r=self.candidate()
        for ids in [[],['missing'],['voice','voice']]:
            with self.assertRaises(ValueError):m.review_persona(self.root,c['id'],r,'확인할 사용자',ids)
        self.assertFalse((self.root/m.PERSONA_CATALOG).exists())
    def test_duplicate_user_goal_extends_existing_role_and_preserves_other_roles(self):
        catalog={'schemaVersion':1,'personas':[{'id':'reader','goal':'여러 창에서 음성 요청을 하는 사람','tests':[{'check':'other'}]},
                                                {'id':'other-role','goal':'다른 기능을 쓰는 사람','tests':[{'check':'other'}]}]}
        (self.root/m.PERSONA_CATALOG).write_text(json.dumps(catalog));c,r=self.candidate();result=self.accept(c,r)
        self.assertEqual(result['mode'],'extended');self.assertEqual(result['personaId'],'reader')
        saved=json.loads((self.root/m.PERSONA_CATALOG).read_text());self.assertEqual(len(saved['personas']),2)
        self.assertEqual(saved['personas'][1],catalog['personas'][1]);self.assertEqual(len(saved['personas'][0]['tests']),2)
    def test_lost_response_replays_receipt_without_rewriting_catalog(self):
        c,r=self.candidate();self.accept(c,r);before=(self.root/m.PERSONA_CATALOG).stat().st_mtime_ns
        self.assertTrue(self.accept(c,r)['replayed']);self.assertEqual((self.root/m.PERSONA_CATALOG).stat().st_mtime_ns,before)
    def test_accepted_custom_goal_does_not_regrow_duplicate_roles_on_source_change(self):
        c,r=self.candidate();self.accept(c,r)
        (self.root/'src/voice.ts').write_text('new code still covered by accepted user goal')
        self.assertEqual(m.discover_personas(self.root)['candidates'],[])
        catalog=json.loads((self.root/m.PERSONA_CATALOG).read_text())
        catalog['personas'][0]['tests']=[{'check':'other'}]
        (self.root/m.PERSONA_CATALOG).write_text(json.dumps(catalog))
        next_candidate,revision=self.candidate();self.assertEqual(next_candidate['goal'],catalog['personas'][0]['goal'])
        self.assertEqual(self.accept(next_candidate,revision)['mode'],'extended')
    def test_crash_after_catalog_commit_recovers_by_hash_without_adding_another_role(self):
        c,r=self.candidate();save=m.save_text
        def fail(root,relative,text):
            if relative.endswith(c['id']+'.json') and json.loads(text).get('state')=='committed':raise OSError('crash after catalog')
            return save(root,relative,text)
        with patch.object(m,'save_text',side_effect=fail):
            with self.assertRaises(OSError):self.accept(c,r)
        with self.assertRaisesRegex(ValueError,'exact original review'):
            self.accept(c,r,goal='different request must not replace the uncertain receipt')
        result=self.accept(c,r);self.assertTrue(result['replayed']);self.assertEqual(len(m.load_personas(self.root)[1]),1)
        self.assertEqual(m.persona_evolution(self.root)['candidates'],[])
    def test_rejection_is_not_a_verdict_and_new_relevant_code_can_propose_again(self):
        c,r=self.candidate();self.assertIsNone(m.review_persona(self.root,c['id'],r,reject=True)['verdict'])
        self.assertEqual(m.discover_personas(self.root)['candidates'],[])
        (self.root/'src/voice.ts').write_text('another relevant feature after rejection')
        self.assertEqual(len(m.discover_personas(self.root)['candidates']),1)
    def test_symlink_and_future_proposals_fail_closed(self):
        c,r=self.candidate();target=self.root/m.PERSONA_CATALOG;target.symlink_to(self.root/'external.json')
        with self.assertRaises(ValueError):self.accept(c,r)
        target.unlink();(self.root/m.PERSONA_EVOLUTION).write_text('{"schemaVersion":999,"candidates":[]}')
        with self.assertRaises(ValueError):m.discover_personas(self.root)
    def test_malformed_candidate_evidence_is_rejected_without_catalog_write(self):
        c,r=self.candidate();state=json.loads((self.root/m.PERSONA_EVOLUTION).read_text())
        state['candidates'][0]['checkIds']=[]
        (self.root/m.PERSONA_EVOLUTION).write_text(json.dumps(state))
        with self.assertRaisesRegex(ValueError,'candidate checks'):self.accept(c,r)
        self.assertFalse((self.root/m.PERSONA_CATALOG).exists())
    def test_real_run_collects_candidates_but_leaves_catalog_absent(self):
        result=subprocess.run([sys.executable,str(SCRIPT),'run','--root',str(self.root),'--profile','quick'],capture_output=True,text=True)
        self.assertEqual(result.returncode,0,result.stderr);self.assertTrue(self.marker.exists())
        self.assertEqual(len(m.persona_evolution(self.root)['candidates']),1);self.assertFalse((self.root/m.PERSONA_CATALOG).exists())

if __name__=='__main__':unittest.main()
