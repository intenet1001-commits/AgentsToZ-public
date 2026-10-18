"""Domain actors are evidence-backed drafts, not three hardcoded personas or passes."""
import json
import pathlib
import unittest
from unittest.mock import patch
import test_persona_evolution as fixture
m=fixture.m

class ContextualPersonas(unittest.TestCase):
    setUp=fixture.Evolution.setUp
    tearDown=fixture.Evolution.tearDown
    def propose(self, role='증권사 직원', checks=None, **changes):
        if not (self.root/'README.md').exists():
            (self.root/'README.md').write_text('Project stakeholder context')
            with (self.root/'.gitignore').open('a') as stream:stream.write('README.md\n')
        data=dict(revision=m.persona_context(self.root)[0]['revision'],role=role,
                  reason='프로젝트 문서에서 직원의 승인 여정을 다룬다',goal='같은 과제를 완료한다',
                  situation='권한이 있는 직원으로 시작한다',journey=['업무를 조회한다','승인 조건을 확인한다'],
                  criteria=['허용된 업무만 완료 표시한다'],sources=['README.md'],check_ids=[] if checks is None else checks)
        data.update(changes)
        state=self.last=m.propose_persona(self.root,**data)
        return state['candidates'][-1],state['context']['revision']
    def accept(self,c,r,checks=None):
        return m.review_persona(self.root,c['id'],r,c['goal'],['voice'] if checks is None else checks)
    def test_missing_checks_are_visible_drafts_and_never_activate_or_run(self):
        c,r=self.propose();self.assertEqual(c['checkIds'],[]);self.assertIsNone(c['evidence']['check'])
        self.assertEqual(c['profile']['role'],'증권사 직원');self.assertFalse(self.marker.exists())
        self.assertIsNone(m.run_personas(self.root));self.assertFalse((self.root/m.PERSONA_CATALOG).exists())
        with self.assertRaisesRegex(ValueError,'actual checks'):self.accept(c,r,[])
        self.assertFalse((self.root/m.PERSONA_CATALOG).exists())
    def test_novice_and_expert_can_have_same_goal_without_being_merged(self):
        c,r=self.propose(role='게임 초보자',checks=['voice'],criteria=['도움말을 읽고 완료한다']);self.accept(c,r)
        c,r=self.propose(role='프로게이머',checks=['voice'],criteria=['도움말 없이 완료한다']);self.accept(c,r)
        roles=m.load_personas(self.root)[1];self.assertEqual(len(roles),2)
        self.assertEqual([p['role'] for p in roles],['게임 초보자','프로게이머'])
        self.assertNotEqual(roles[0]['successCriteria'],roles[1]['successCriteria'])
        self.assertEqual(len(m.run_personas(self.root)['verdicts']),2)
    def test_same_actor_and_goal_can_have_distinct_situations_and_scenarios(self):
        c,r=self.propose(role='보안 운영자',checks=['voice'],situation='정상 업무 중');self.accept(c,r)
        c,r=self.propose(role='보안 운영자',checks=['other'],situation='접속 실패 후 복구 중',journey=['오류를 확인한다','복구 절차를 따른다']);self.accept(c,r,['other'])
        roles=m.load_personas(self.root)[1];self.assertEqual(len(roles),2)
        self.assertEqual(roles[0]['role'],roles[1]['role']);self.assertEqual(roles[0]['goal'],roles[1]['goal'])
        self.assertNotEqual(roles[0]['journey'],roles[1]['journey'])
    def test_role_journey_reason_and_sources_survive_review_and_brief(self):
        c,r=self.propose(role='감독기관 검토자',checks=['other']);result=self.accept(c,r,['other'])
        stored=json.loads((self.root/m.PERSONA_CATALOG).read_text())['personas'][0]
        self.assertEqual(stored['journey'],c['profile']['journey']);self.assertEqual(stored['sourcePaths'],['README.md'])
        brief=m.persona_brief(self.root,result['personaId'])['brief'];self.assertIn('감독기관 검토자',brief);self.assertIn(stored['reason'],brief)
        self.assertTrue(self.accept(c,r,['other'])['replayed']);self.assertEqual(len(m.load_personas(self.root)[1]),1)
        state=m.propose_persona(self.root,m.persona_context(self.root)[0]['revision'],**{k:c['profile'][k] for k in ['role','reason','situation','journey']},goal=c['goal'],criteria=c['profile']['successCriteria'],sources=['README.md'],check_ids=['other'])
        self.assertEqual(state['candidates'],[])
    def test_source_outside_git_changes_blocks_review_but_can_be_rejected(self):
        c,r=self.propose(checks=['voice']);(self.root/'README.md').write_text('new stakeholder context')
        with self.assertRaisesRegex(ValueError,'source context changed'):self.accept(c,r)
        current=m.persona_context(self.root)[0]['revision']
        self.assertFalse(m.review_persona(self.root,c['id'],current,reject=True)['accepted'])
    def test_candidate_retries_are_stable_and_changed_context_is_separate(self):
        c,r=self.propose();again,_=self.propose();self.assertEqual(c['id'],again['id']);self.assertEqual(len(m.persona_evolution(self.root)['candidates']),1)
        changed,_=self.propose(criteria=['다른 성공 기준']);self.assertNotEqual(c['id'],changed['id'])
        self.assertEqual(len(m.persona_evolution(self.root)['candidates']),2)
    def test_source_traversal_secrets_symlinks_and_unknown_checks_are_rejected(self):
        for paths in [[],['../outside'],['/tmp/outside'],['C:/outside'],['.env'],['README.md','README.md']]:
            with self.assertRaises((ValueError,OSError)):self.propose(sources=paths)
        (self.root/'link.md').symlink_to(self.root/'src/voice.ts')
        with self.assertRaises(ValueError):self.propose(sources=['link.md'])
        with self.assertRaisesRegex(ValueError,'configured checks'):self.propose(checks=['missing'])
        self.assertFalse((self.root/m.PERSONA_CATALOG).exists());self.assertFalse(self.marker.exists())
    def test_candidate_budget_is_checked_without_losing_earlier_drafts(self):
        c,r=self.propose()
        state=m.persona_evolution(self.root);state['candidates']=[{**c,'id':'role-'+str(i)} for i in range(64)]
        (self.root/m.PERSONA_EVOLUTION).write_text(json.dumps({'schemaVersion':1,'candidates':state['candidates']}))
        with self.assertRaisesRegex(ValueError,'budget'):self.propose(role='새 역할')
        self.assertEqual(len(m.persona_evolution(self.root)['candidates']),64)
    def discovered(self,count,revision=None):
        """Fill the proposal list the way an older runner could: discovered drafts only."""
        # The template is this context's own discovered draft, never a leftover from earlier rows.
        (self.root/m.PERSONA_EVOLUTION).unlink(missing_ok=True)
        c=m.discover_personas(self.root)['candidates'][0]
        self.assertTrue(c['id'].startswith('context-'))
        rows=[{**c,'id':f'context-{i:02d}',**({'contextRevision':revision} if revision else {})} for i in range(count)]
        (self.root/m.PERSONA_EVOLUTION).write_text(json.dumps({'schemaVersion':1,'candidates':rows}))
        return c
    def test_discovered_drafts_cannot_use_up_the_role_budget(self):
        self.discovered(64)
        c,_=self.propose(role='새 역할')
        state=m.persona_evolution(self.root)['candidates']
        self.assertIn(c['id'],[x['id'] for x in state]);self.assertLessEqual(len(state),m.PERSONA_CANDIDATE_MAX)
        self.assertEqual(sum(x['id'].startswith('context-') for x in state),m.DISCOVERED_CANDIDATE_MAX)
        self.assertFalse((self.root/m.PERSONA_CATALOG).exists());self.assertFalse(self.marker.exists())
    def test_role_proposals_have_their_own_bounded_budget(self):
        self.assertEqual(m.DISCOVERED_CANDIDATE_MAX+m.PROPOSED_CANDIDATE_MAX,m.PERSONA_CANDIDATE_MAX)
        for i in range(m.PROPOSED_CANDIDATE_MAX):self.propose(role=f'역할 {i}')
        with self.assertRaisesRegex(ValueError,'budget'):self.propose(role='한 명 더')
        self.assertEqual(len(m.persona_evolution(self.root)['candidates']),m.PROPOSED_CANDIDATE_MAX)
        found=m.discover_personas(self.root)['candidates']
        self.assertEqual(sum(x['id'].startswith('context-') for x in found),1)
    def test_stale_discovered_drafts_make_room_for_current_ones_but_current_drafts_stay(self):
        stale='0'*64
        fresh=self.discovered(64,revision=stale)
        result=m.discover_personas(self.root);rows=result['candidates']
        self.assertIn(fresh['id'],[x['id'] for x in rows])
        self.assertEqual(len(rows),m.DISCOVERED_CANDIDATE_MAX);self.assertEqual(result['additionalCandidates'],0)
        self.assertEqual(sum(x['contextRevision']==stale for x in rows),m.DISCOVERED_CANDIDATE_MAX-1)
        # Nothing was reviewed: no receipt, no catalog, no run.
        self.assertFalse((self.root/m.PERSONA_REVIEWS).exists());self.assertFalse((self.root/m.PERSONA_CATALOG).exists())
        # Current drafts are never dropped to make room for more discovered drafts.
        current=self.discovered(m.DISCOVERED_CANDIDATE_MAX)
        self.assertEqual(current['id'],fresh['id'])
        kept=[x['id'] for x in m.persona_evolution(self.root)['candidates']]
        self.assertTrue(all(x['contextRevision']==current['contextRevision']!=stale for x in m.persona_evolution(self.root)['candidates']))
        self.assertNotIn(current['id'],kept)
        again=m.discover_personas(self.root)
        self.assertEqual([x['id'] for x in again['candidates']],kept)
        self.assertNotIn(current['id'],[x['id'] for x in again['candidates']])
        self.assertEqual(again['additionalCandidates'],1)
    def test_propose_drops_stale_drafts_first_and_reports_how_many(self):
        stale='0'*64
        self.discovered(m.PERSONA_CANDIDATE_MAX,revision=stale)
        self.propose(role='새 역할')
        # An agent's proposal that removes drafts says so; the human review never loses them silently.
        self.assertEqual(self.last['droppedCandidates'],m.PERSONA_CANDIDATE_MAX-m.DISCOVERED_CANDIDATE_MAX)
        rows=self.last['candidates']
        self.assertEqual(sum(x['contextRevision']==stale for x in rows),m.DISCOVERED_CANDIDATE_MAX)
        self.assertFalse((self.root/m.PERSONA_REVIEWS).exists())
        # Nothing over budget: nothing removed, nothing reported.
        self.propose(role='두 번째 역할')
        self.assertNotIn('droppedCandidates',self.last)
        self.assertEqual(sum(x['contextRevision']==stale for x in self.last['candidates']),m.DISCOVERED_CANDIDATE_MAX)
    def test_propose_reports_current_drafts_it_removed(self):
        self.discovered(m.PERSONA_CANDIDATE_MAX)
        self.propose(role='새 역할')
        self.assertEqual(self.last['droppedCandidates'],m.PERSONA_CANDIDATE_MAX-m.DISCOVERED_CANDIDATE_MAX)
    def test_review_names_the_discovered_budget(self):
        self.assertEqual(m.persona_evolution(self.root)['discoveredLimit'],m.DISCOVERED_CANDIDATE_MAX)
    def test_shared_instructions_require_both_sets_and_active_agent_context(self):
        self.assertIn('without waiting for a separate persona-testing request',m.TESTER_INSTRUCTIONS)
        self.assertIn('personas propose',m.TESTER_INSTRUCTIONS)
        self.assertIn('no separate instruction or additional model call',m.TESTER_INSTRUCTIONS)
        self.assertIn('missing catalog',m.TESTER_INSTRUCTIONS)
