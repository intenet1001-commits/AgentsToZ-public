/**
 * What the OPS voice model must know to orchestrate by speech. Spoken Korean names every AI and
 * project phonetically, so the model — not the resolver — maps 「클로드」 to claude and 「바이브2」
 * to vibe2. These strings are the single source for the provider instructions and tool texts.
 */

/** Spoken AI names → workroom agents. A registered project called 헤르메스 wins unless the AI is meant. */
export const VOICE_AGENT_NAME_GUIDANCE =
  '워크룸 AI 이름: 클로드=claude, 코덱스=codex, 안티그래비티·에이지와이(AGY)=agy, 헤르메스는 “헤르메스로 열어”, “헤르메스 AI”처럼 AI로 말할 때만 hermes입니다. '
  + '그 밖의 “헤르메스”는 같은 이름의 등록 프로젝트가 있으면 프로젝트 이름입니다. 사용자가 AI를 말하지 않으면 agent를 넣지 마세요 — 실행 중인 워크룸을 그대로 이어 씁니다.';

/** How a spoken 「<프로젝트> 열어」 shows a project, 「담당자 불러」 becomes a delegate, and what stays with OPS. */
export const VOICE_TARGET_CALL_GUIDANCE =
  '“<프로젝트> 열어”, “<프로젝트> 보여줘”는 resolve_target_alias로 확정한 뒤 open_project로 앱에 그 프로젝트 화면만 띄우세요(실행 없음). '
  + '“<프로젝트> 담당자 불러줘”, “<프로젝트> 담당자 연결해”, “<프로젝트> 불러줘”, “<프로젝트> 담당자”는 resolve_target_alias로 확정한 뒤 connect_project_delegate를 호출하세요. '
  + 'alias에는 “열어”, “불러줘” 같은 동사를 빼고 이름(필요하면 담당자)만 넣으세요. '
  + 'resolved:false이면 candidates에서 발음이 같은 정확한 이름(예: 바이브2 → vibe2)을 골라 그 이름으로 다시 resolve_target_alias를 호출하고, 확실하지 않으면 후보를 말해 사용자에게 확인하세요. '
  + '앱·폴더·대시보드를 여는 요청(“… 앱으로 열어”, “폴더 열어”, “대시보드 열어”)은 담당자 전환이 아니라 prepare_ops_instruction으로 OPS 워크룸에 넘기세요.';

/** Short form for tool `agent` fields. */
export const VOICE_AGENT_FIELD_DESCRIPTION = '워크룸 AI. 클로드=claude, 코덱스=codex, 헤르메스로·헤르메스 AI=hermes, 안티그래비티·에이지와이=agy.';

/**
 * Where this conversation is saved, so the model never tells the person the wrong place (it once said
 * a delegate talk "continues in the project" while every word was saved to OPS — VOC 2026-09-29).
 */
export const VOICE_OPS_RECORD_GUIDANCE =
  '음성 기록 위치: 총괄과 나눈 대화는 OPS 음성 세션에 저장되고, 프로젝트 담당자로 전환한 뒤의 대화는 그 프로젝트의 음성 세션에 저장됩니다. '
  + '총괄로 돌아오면 OPS 기록에 그 직접 대화가 어디에 저장됐는지 한 줄이 남습니다. 사용자는 화면 버튼으로도 대화 상대를 바꿀 수 있고, 그때는 “[화면 전환” 문맥이 전달됩니다. '
  + '저장 위치를 물으면 이 규칙대로 답하세요.';
export const VOICE_WORKROOM_RECORD_GUIDANCE = '음성 기록 위치: 이 대화는 이 프로젝트의 음성 세션에 저장됩니다.';
export const VOICE_NO_RECORD_GUIDANCE = '음성 기록: 사용자가 이 대화의 기록 저장을 껐습니다. 저장된다고 말하지 마세요.';

/**
 * Voice acts, not just talks (VOC 2026-09-30: 「음성으로 지시·동작이 작동해야 음성 세션의 의미가 있다」). The model once
 * answered 「저는 화면을 누를 수 없으니 초안을 확인하고 보내세요」 — it can, with the person's spoken yes.
 */
export const VOICE_ACTION_GUIDANCE =
  '총괄과 대화할 때(담당자로 전환하지 않았을 때) 음성으로 실제로 동작합니다: 지시 초안(prepare_*)을 만들면 내용을 한 문장으로 말하고 “보낼까요?”라고 물은 뒤, 사용자가 “응”, “보내”, “전송해”라고 하면 send_prepared_instruction으로 워크룸에 입력하세요. '
  + '사용자가 처음부터 “바로 보내”라고 했으면 확인 질문 없이 보내도 됩니다. 워크룸이 폴더 신뢰·승인·메뉴·y/n 질문을 띄워 입력을 거절하면 그 질문을 말하고, 사용자가 누를 답을 말하면 answer_workroom_prompt로 그 키를 누르세요. '
  + '사용자가 요청하지 않은 권한 승인은 누르지 마세요. “화면을 누를 수 없다”고 답하지 마세요. '
  + '초안 text는 사용자가 말한 언어 그대로 쓰세요(한국어로 말했으면 한국어). 영어로 번역하지 마세요 — 사람이 그 글을 읽고 확인합니다.';

/**
 * 담당자 mode is a relay (VOC 2026-09-30: 「프로젝트에게 지시하면 입력칸에 들어가고 전송이 되어야」). The host types what the
 * person says into the project AI's workroom; the voice model does not answer those words itself.
 */
export const VOICE_RELAY_GUIDANCE =
  '프로젝트 담당자로 전환하면(connect_project_delegate 또는 화면 버튼) 사용자의 말과 입력은 호스트가 그 워크룸 AI에 그대로 입력합니다(현재 세션에 전송과 같음). '
  + '그동안 당신은 그 말에 따로 답하거나 초안을 만들지 말고, 호스트가 보내는 “[워크룸 실제 출력 관찰 JSON]”을 짧게 요약해 말하세요. Gemini처럼 매 발화에 답해야 하면 “전달했어요” 한마디만 하세요. '
  + '사용자가 “아젠투지”나 “총괄”로 부르거나 “메인으로 돌아가”라고 하면 당신에게 하는 말입니다(총괄로 돌아가기, 다른 담당자 부르기 등). 담당자와 대화하는 동안에는 prepare_* 초안을 만들지 않습니다. 워크룸이 질문을 기다려 입력이 거절되면 그 질문과 선택지를 읽어 주고, 사용자가 고른 답을 answer_workroom_prompt로 누르세요.';

/**
 * Words meant for 아젠투지 itself while relaying (VOC 2026-09-30; relay review): 「아젠투지, 총괄로 돌아가」, 「메인으로 돌아가」.
 * Spoken transcripts vary — a filler first (「음, 아젠투지」), the name split (「아젠 투지」), or the address in a later
 * sentence — so each sentence is checked with fillers and spaces removed. 「총괄」 counts only as an address
 * (「총괄, …」 「총괄로 돌아가」), never inside a word (「총괄적으로」).
 */
/**
 * 담당자(릴레이) 모드에서 **총괄에게 말하는 명시적 표시**. 말로는 「아젠투지…」로 부르지만, 글로
 * 적을 때는 문장을 어떻게 시작했는지에 따라 판정이 갈려 불안하다 — `@@`는 프로젝트 호출(`@이름`)과도
 * 겹치지 않는다(VOC 2026-10-05: 「@@아젠투지 @테스트해보자」처럼 쓰고 싶다).
 * 표시는 **문장 맨 앞에서만** 인정하고, 뒤의 `@프로젝트`·`#언급`은 그대로 남긴다.
 */
// ⚠️ `\b`를 쓰지 말 것 — JS의 단어 경계는 `[A-Za-z0-9_]` 기준이라 한글 뒤에서는 경계가 생기지 않고
// 「@@아젠투지 테스트」가 통째로 안 걸린다. 끝이거나 구분자가 오는지 **전방탐색**으로 본다.
export const AGENTSTOZ_ADDRESS_MARKER=/^\s*@@\s*(?:아젠투지|에이전츠투지|에이전트투지|총괄|메인|agentstoz|agenttoz|ops)(?=$|[\s,:.!?·])[\s,:]*/i;
export function stripAgentsToZAddressMarker(text:string):{addressed:boolean;text:string}{
  const match=AGENTSTOZ_ADDRESS_MARKER.exec(text);
  return match?{addressed:true,text:text.slice(match[0].length)}:{addressed:false,text};
}
export function addressedToAgentsToZ(text:string):boolean{
  if(AGENTSTOZ_ADDRESS_MARKER.test(text))return true;
  return text.split(/[.!?。\n]+/).some(sentence=>{
    const start=sentence.trim().replace(/^(?:[\s"'「(\[,.~!?…]|음+|어+|아+(?=[\s,])|저기|저|hey)+/i,'');
    const compact=start.replace(/[\s,.'"「」()[\]~!?…]+/g,'').toLowerCase();
    return /^(아젠투지|에이전츠투지|에이전트투지|agentstoz|agenttoz|agentstozops)/.test(compact)
      ||/^총괄(?:님|아|야|,|\s|로|에게|한테|으로|$)/.test(start)||/^메인으로/.test(compact);
  });
}
