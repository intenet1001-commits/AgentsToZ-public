import {sha256} from '@noble/hashes/sha2.js';

/**
 * The one offline voice evaluation corpus.
 *
 * Two consumers read it and must not grow their own copies:
 *  - Korean accuracy experiments (conditions inside the product: noise reduction, transcription hints, …)
 *  - the product-vs-product benchmark (src/voiceRemoteBenchmark.ts), which needs ≥20 distinct KO/EN/mixed cases.
 *
 * Pure data and pure functions: no clock, filesystem, network or provider calls. Text never leaves this module
 * through the public case list — only hashes do (BENCHMARK.md: the manifest holds no raw text or audio).
 *
 * Bump VOICE_EVAL_CORPUS_VERSION whenever any item changes; the corpus hash changes anyway, the version is the
 * human-readable label a report quotes.
 */
export const VOICE_EVAL_CORPUS_VERSION = '2026-10-15.1';
export type VoiceEvalLang = 'ko'|'en'|'mixed';
export type VoiceEvalCategory = 'plain'|'numbers'|'negation'|'long-pause'|'interruption'|'names';
export type VoiceEvalTrapKind = 'negation-dropped'|'early-turn-end'|'misheard-digit'|'first-question';
export interface VoiceEvalSegment {text:string;pauseAfterMs?:number}
export interface VoiceEvalItem {
  id:string;lang:VoiceEvalLang;category:VoiceEvalCategory;
  segments:VoiceEvalSegment[];
  /** A second utterance played over the product's answer (barge-in), `afterResponseOnsetMs` after it starts speaking. */
  bargeIn?:{afterResponseOnsetMs:number;segments:VoiceEvalSegment[]};
  expected:{
    /** The number the final spoken answer must end with (see voiceEvalScoring: last-number rule). */
    answer:number;
    /** The spoken numbers, in order, that a relayed transcript must keep. */
    operands:number[];
    /** Term groups a relayed transcript must keep; any alternative in a group satisfies it (case-insensitive). */
    terms:string[][];
  };
  traps:{kind:VoiceEvalTrapKind;value:number}[];
}
export interface VoiceEvalCorpus {schemaVersion:1;version:string;items:VoiceEvalItem[]}

const s = (text:string, pauseAfterMs?:number):VoiceEvalSegment => pauseAfterMs===undefined?{text}:{text,pauseAfterMs};
type Spec = [id:string, category:VoiceEvalCategory, segments:VoiceEvalSegment[], answer:number, operands:number[],
  terms?:string[][], traps?:VoiceEvalItem['traps'], bargeIn?:VoiceEvalItem['bargeIn']];
function items(lang:VoiceEvalLang, specs:Spec[]):VoiceEvalItem[] {
  return specs.map(([id,category,segments,answer,operands,terms=[],traps=[],bargeIn]) => ({
    id,lang,category,segments,...(bargeIn?{bargeIn}:{}),expected:{answer,operands,terms},traps,
  }));
}
const NEG_KO = ['말고','아니고','아니라','빼고','하지 마'];
const barge = (text:string, afterResponseOnsetMs = 1500) => ({afterResponseOnsetMs, segments:[s(text)]});

export const VOICE_EVAL_CORPUS:VoiceEvalCorpus = {schemaVersion:1, version:VOICE_EVAL_CORPUS_VERSION, items:[
  ...items('ko', [
    ['ko-num-01','numbers',[s('칠 더하기 팔은?')],15,[7,8]],
    ['ko-num-02','numbers',[s('삼백이십일 더하기 백은?')],421,[321,100]],
    ['ko-num-03','numbers',[s('이천이십육 빼기 이천은?')],26,[2026,2000]],
    ['ko-num-04','numbers',[s('만 이천 더하기 삼천은?')],15000,[12000,3000]],
    ['ko-num-05','numbers',[s('열다섯에서 다섯을 빼면?')],10,[15,5]],
    ['ko-num-06','numbers',[s('스물하나 더하기 아홉은?')],30,[21,9]],
    ['ko-num-07','numbers',[s('십칠 더하기 일은?')],18,[17,1],[],[{kind:'misheard-digit',value:8}]],
    ['ko-num-08','numbers',[s('구 곱하기 육은?')],54,[9,6]],
    ['ko-num-09','numbers',[s('귤 세 개와 배 네 개는 모두 몇 개야?')],7,[3,4]],
    ['ko-num-10','numbers',[s('백 나누기 사는?')],25,[100,4]],
    ['ko-neg-01','negation',[s('팔 더하기 칠 말고 팔 빼기 칠은?')],1,[8,7,8,7],[NEG_KO],[{kind:'negation-dropped',value:15}]],
    ['ko-neg-02','negation',[s('육 더하기 이가 아니라 육 곱하기 이는?')],12,[6,2,6,2],[NEG_KO],[{kind:'negation-dropped',value:8}]],
    ['ko-neg-03','negation',[s('더하지 말고 빼 줘. 십 빼기 삼은?')],7,[10,3],[NEG_KO],[{kind:'negation-dropped',value:13}]],
    ['ko-pause-01','long-pause',[s('팔 더하기 칠에서',2500),s('삼을 빼면?')],12,[8,7,3],[],[{kind:'early-turn-end',value:15}]],
    ['ko-pause-02','long-pause',[s('이십에',3000),s('오를 더하면?')],25,[20,5],[],[{kind:'early-turn-end',value:20}]],
    ['ko-pause-03','long-pause',[s('구 곱하기 이를 한 다음에',2500),s('일을 빼면?')],17,[9,2,1],[],[{kind:'early-turn-end',value:18}]],
    ['ko-int-01','interruption',[s('일부터 열까지 천천히 세어 줘')],4,[1,10,2,2],[],[{kind:'first-question',value:10}],barge('멈추고, 이 더하기 이는?')],
    ['ko-int-02','interruption',[s('백부터 거꾸로 천천히 세어 줘')],8,[100,5,3],[],[],barge('그만, 오 더하기 삼은?',2000)],
    ['ko-names-01','names',[s('클로드에게 커밋 두 개, 코덱스에게 세 개를 맡기면 모두 몇 개야?')],5,[2,3],[['클로드','claude'],['코덱스','codex']]],
    ['ko-names-02','names',[s('헤르메스 세션 네 개 중 하나를 닫으면 몇 개 남아?')],3,[4,1],[['헤르메스','hermes']]],
    ['ko-names-03','names',[s('아젠투지 워크룸 여섯 개와 안티그래비티 워크룸 두 개는 합쳐서 몇 개야?')],8,[6,2],[['아젠투지','agentstoz'],['안티그래비티','antigravity']]],
    ['ko-plain-01','plain',[s('하나 더하기 하나는?')],2,[1,1]],
  ]),
  ...items('en', [
    ['en-num-01','numbers',[s('What is seven plus eight?')],15,[7,8]],
    ['en-num-02','numbers',[s('What is three hundred twenty-one plus one hundred?')],421,[321,100]],
    ['en-num-03','numbers',[s('Subtract two thousand from two thousand twenty-six.')],26,[2000,2026]],
    ['en-num-04','numbers',[s('What is nine times six?')],54,[9,6]],
    ['en-num-05','numbers',[s('Divide one hundred by four.')],25,[100,4]],
    ['en-num-06','numbers',[s('Add twelve and nineteen.')],31,[12,19]],
    ['en-num-07','numbers',[s('What is fifteen minus four?')],11,[15,4]],
    ['en-num-08','numbers',[s('Multiply eleven by three.')],33,[11,3]],
    ['en-num-09','numbers',[s('What is forty plus sixty?')],100,[40,60]],
    ['en-num-10','numbers',[s('What do you get when you add five hundred and five to five?')],510,[505,5]],
    ['en-neg-01','negation',[s('Not eight plus seven, but eight minus seven. What is it?')],1,[8,7,8,7],[['not']],[{kind:'negation-dropped',value:15}]],
    ['en-neg-02','negation',[s('Do not add them; multiply six by two.')],12,[6,2],[['not',"don't"]],[{kind:'negation-dropped',value:8}]],
    ['en-neg-03','negation',[s("Don't subtract. Ten plus three, please.")],13,[10,3],[["don't",'do not','not']],[{kind:'negation-dropped',value:7}]],
    ['en-pause-01','long-pause',[s('Take twenty and add five,',2500),s('then subtract three.')],22,[20,5,3],[],[{kind:'early-turn-end',value:25}]],
    ['en-pause-02','long-pause',[s('Start with nine,',3000),s('and double it.')],18,[9],[],[{kind:'early-turn-end',value:9}]],
    ['en-pause-03','long-pause',[s('Multiply four by five,',2500),s('then add one.')],21,[4,5,1],[],[{kind:'early-turn-end',value:20}]],
    ['en-int-01','interruption',[s('Count slowly from one to ten.')],4,[1,10,2,2],[],[{kind:'first-question',value:10}],barge('Stop. What is two plus two?')],
    ['en-int-02','interruption',[s('Count down slowly from fifty.')],8,[50,3,5],[],[],barge('Wait, what is three plus five?',2000)],
    ['en-names-01','names',[s('Claude has two commits and Codex has three. How many in total?')],5,[2,3],[['claude','클로드'],['codex','코덱스']]],
    ['en-names-02','names',[s('Hermes opened four sessions and closed one. How many are open?')],3,[4,1],[['hermes','헤르메스']]],
    ['en-names-03','names',[s('AgentsToZ runs six workrooms and Antigravity runs two. How many altogether?')],8,[6,2],[['agentstoz','아젠투지'],['antigravity','안티그래비티']]],
    ['en-plain-01','plain',[s('What is one plus one?')],2,[1,1]],
  ]),
  ...items('mixed', [
    ['mx-num-01','numbers',[s('commit 세 개랑 push 네 개면 합쳐서 몇 개야?')],7,[3,4],[['commit','커밋'],['push','푸시']]],
    ['mx-num-02','numbers',[s('TestFlight build 712 다음 번호는?')],713,[712],[['testflight','테스트플라이트']]],
    ['mx-num-03','numbers',[s('worktree 네 개에서 하나를 지우면 몇 개야?')],3,[4,1],[['worktree','워크트리']]],
    ['mx-num-04','numbers',[s('PR 다섯 개 중에 두 개를 merge하면 몇 개 남아?')],3,[5,2],[['merge','머지']]],
    ['mx-num-05','numbers',[s('port 3001에 1을 더하면?')],3002,[3001,1],[['port','포트']]],
    ['mx-num-06','numbers',[s('OpenAI 요청 seven 개와 Gemini 요청 eight 개는 모두 몇 개?')],15,[7,8],[['openai','오픈에이아이'],['gemini','제미나이']]],
    ['mx-num-07','numbers',[s('tab 열두 개 중 세 개를 닫으면?')],9,[12,3],[['tab','탭']]],
    ['mx-num-08','numbers',[s('issue 스무 개에서 다섯 개를 close하면?')],15,[20,5],[['close','클로즈','닫']]],
    ['mx-neg-01','negation',[s('push 말고 pull 횟수만 세 줘. push 세 번, pull 두 번이야.')],2,[3,2],[['말고','not']],[{kind:'negation-dropped',value:3}]],
    ['mx-neg-02','negation',[s('merge 말고 rebase 개수만 알려 줘. merge 네 개, rebase 한 개.')],1,[4,1],[['말고','not']],[{kind:'negation-dropped',value:4}]],
    ['mx-neg-03','negation',[s('Claude 세션은 빼고 Codex 세션 수만. Claude 둘, Codex 다섯.')],5,[2,5],[['빼고','말고','except']],[{kind:'negation-dropped',value:7}]],
    ['mx-pause-01','long-pause',[s('commit 열 개에서',2500),s('세 개를 revert하면?')],7,[10,3],[],[{kind:'early-turn-end',value:10}]],
    ['mx-pause-02','long-pause',[s('build 넘버 이백에',3000),s('five를 더하면?')],205,[200,5],[],[{kind:'early-turn-end',value:200}]],
    ['mx-pause-03','long-pause',[s('worker 셋으로 시작해서',2500),s('둘을 더 추가하면?')],5,[3,2],[],[{kind:'early-turn-end',value:3}]],
    ['mx-int-01','interruption',[s('one부터 ten까지 영어로 천천히 세어 줘')],7,[1,10,3,4],[],[{kind:'first-question',value:10}],barge('stop, 삼 더하기 사는?')],
    ['mx-int-02','interruption',[s('TestFlight 빌드 목록을 처음부터 읽어 줘')],9,[7,2],[],[],barge('잠깐, build 칠 더하기 이는?',2000)],
    ['mx-names-01','names',[s('Antigravity 워크룸 두 개랑 Hermes 워크룸 세 개 합치면?')],5,[2,3],[['antigravity','안티그래비티'],['hermes','헤르메스']]],
    ['mx-names-02','names',[s('OPS에서 Codex 세션 여섯 개 중 두 개를 종료하면?')],4,[6,2],[['ops','옵스'],['codex','코덱스']]],
    ['mx-names-03','names',[s('agy로 연 workroom 하나와 Claude로 연 workroom 넷은 모두 몇 개?')],5,[1,4],[['agy','에이지와이'],['claude','클로드']]],
    ['mx-plain-01','plain',[s('Realtime API로 일 더하기 일은?')],2,[1,1],[['realtime','리얼타임']]],
    ['mx-plain-02','plain',[s('Gemini 모델 두 개와 OpenAI 모델 하나면 총 몇 개?')],3,[2,1],[['gemini','제미나이'],['openai','오픈에이아이']]],
  ]),
]};

/** Sorted-key JSON; array order is preserved (it is part of the meaning). */
export function canonicalJson(value:unknown):string {
  if(Array.isArray(value))return '['+value.map(canonicalJson).join(',')+']';
  if(value!==null&&typeof value==='object')return '{'+Object.keys(value as object).sort()
    .filter(k=>(value as Record<string,unknown>)[k]!==undefined)
    .map(k=>JSON.stringify(k)+':'+canonicalJson((value as Record<string,unknown>)[k])).join(',')+'}';
  return JSON.stringify(value);
}
export function sha256Hex(data:string|Uint8Array):string {
  const bytes=typeof data==='string'?new TextEncoder().encode(data):data;
  return Array.from(sha256(bytes),b=>b.toString(16).padStart(2,'0')).join('');
}
export function corpusHash(corpus:VoiceEvalCorpus):string {return sha256Hex(canonicalJson(corpus));}
/** The facts a scorer checks, bound to the case id so two cases never share a digest. Text is not part of it. */
export function expectedFacts(item:VoiceEvalItem) {
  return {schema:'agentstoz-voice-eval-facts-v1',caseId:item.id,lang:item.lang,
    answer:item.expected.answer,operands:item.expected.operands,
    terms:item.expected.terms.map(group=>group.map(t=>t.toLowerCase())),traps:item.traps};
}
export function expectedFactsHash(item:VoiceEvalItem):string {return sha256Hex(canonicalJson(expectedFacts(item)));}
/** Every spoken text of an item, in playback order. */
export function itemTexts(item:VoiceEvalItem):string[] {
  return [...item.segments.map(x=>x.text),...(item.bargeIn?.segments.map(x=>x.text)??[])];
}

const ID=/^[a-zA-Z][a-zA-Z0-9_-]{0,79}$/;
const TRAP_KINDS:readonly VoiceEvalTrapKind[]=['negation-dropped','early-turn-end','misheard-digit','first-question'];
const fail=(reason:string):never=>{throw new Error('VOICE_EVAL_CORPUS_INVALID: '+reason);};
function segmentsValid(segments:VoiceEvalSegment[], where:string){
  if(!Array.isArray(segments)||!segments.length)fail(where+' has no segments');
  for(const x of segments){
    if(typeof x.text!=='string'||!x.text.trim()||x.text.length>400)fail(where+' has an empty or long segment');
    if(x.pauseAfterMs!==undefined&&(!Number.isInteger(x.pauseAfterMs)||x.pauseAfterMs<0||x.pauseAfterMs>10_000))fail(where+' pause out of range');
  }
}
const distinctKey=(item:VoiceEvalItem)=>itemTexts(item).join('').normalize('NFKC').toLowerCase().replace(/[^\p{L}\p{N}]+/gu,'');
/** Throws on any drift from the contract the two consumers rely on. */
export function validateVoiceEvalCorpus(corpus:VoiceEvalCorpus):VoiceEvalCorpus {
  if(corpus.schemaVersion!==1||typeof corpus.version!=='string'||!corpus.version)fail('header');
  const ids=new Set<string>(),texts=new Set<string>(),counts={ko:0,en:0,mixed:0};
  for(const item of corpus.items){
    if(!ID.test(item.id)||ids.has(item.id))fail('id '+item.id);
    ids.add(item.id);
    if(!(item.lang in counts))fail(item.id+' lang');
    counts[item.lang]++;
    segmentsValid(item.segments,item.id);
    if(item.bargeIn){
      segmentsValid(item.bargeIn.segments,item.id+' barge-in');
      const at=item.bargeIn.afterResponseOnsetMs;
      if(!Number.isInteger(at)||at<200||at>10_000)fail(item.id+' barge-in offset');
    }
    if(item.category==='interruption'&&!item.bargeIn)fail(item.id+' interruption without barge-in');
    if(item.category==='long-pause'&&!item.segments.some(x=>(x.pauseAfterMs??0)>=2000))fail(item.id+' long pause shorter than 2 s');
    const {answer,operands,terms}=item.expected;
    if(!Number.isSafeInteger(answer)||answer<0)fail(item.id+' answer');
    if(!operands.every(n=>Number.isSafeInteger(n)&&n>=0))fail(item.id+' operands');
    if(!operands.length&&!terms.length)fail(item.id+' has no expected facts');
    if(terms.some(group=>!group.length||group.some(t=>typeof t!=='string'||!t.trim())))fail(item.id+' terms');
    for(const trap of item.traps)if(!TRAP_KINDS.includes(trap.kind)||!Number.isSafeInteger(trap.value)||trap.value===answer)fail(item.id+' trap');
    const key=distinctKey(item);
    if(texts.has(key))fail(item.id+' duplicates another item text');
    texts.add(key);
  }
  for(const [lang,n] of Object.entries(counts))if(n<20)fail('fewer than 20 '+lang+' items');
  return corpus;
}

export interface PublicVoiceCase {id:string;domain:'voice';language:VoiceEvalLang;inputHash:string;expectedFactsHash:string}
/**
 * The benchmark's case list: ids and digests only. `inputHashes` maps case id → sha256 of the exact rendered audio
 * the operator plays (one clip per case); distinct audio is required, as the evaluator rejects duplicate inputs.
 */
export function publicBenchmarkCases(corpus:VoiceEvalCorpus, inputHashes:ReadonlyMap<string,string>):PublicVoiceCase[] {
  validateVoiceEvalCorpus(corpus);
  const seen=new Set<string>();
  return corpus.items.map(item=>{
    const inputHash=inputHashes.get(item.id);
    if(!inputHash||!/^[a-f0-9]{64}$/.test(inputHash))return fail(item.id+' has no rendered input hash');
    if(seen.has(inputHash))fail(item.id+' shares its audio hash with another case');
    seen.add(inputHash);
    return {id:item.id,domain:'voice' as const,language:item.lang,inputHash,expectedFactsHash:expectedFactsHash(item)};
  });
}
