import {canonicalJson, sha256Hex, type VoiceEvalItem, type VoiceEvalTrapKind} from './voiceEvalCorpus';

/**
 * The one number normalizer and answer scorer for offline voice evaluation (Korean experiments and the
 * product benchmark both use it). Pure and deterministic.
 *
 * Recognised forms, in order of appearance:
 *  - digits, with valid thousands commas ("2,026"), optionally followed by Korean units ("2만 5천" → 25000)
 *  - Sino-Korean numerals (영 일 이 … 구, 십 백 천 만 억; "삼백이십일" → 321, "만 이천" → 12000)
 *  - native Korean numerals (하나 … 아흔아홉; attributive 한/두/세/네/스무 only before a counter: "세 개")
 *  - English number words ("three hundred twenty-one", "two thousand twenty six")
 *
 * Korean is ambiguous ("이" is also a particle, "네" also means yes, "천천히" means slowly), so a Korean numeral
 * only counts at the start of a word and only when the rest of that word is a known particle/copula or a counter.
 * The particle must also agree with the numeral's final sound (은/는, 이/가, 을/를, 과/와, 이랑/랑, 으로 only after
 * a vowel-less ending), so "사과" (apple), "사이" and "일가" are words, not 4/4/1. A single Sino digit does not take
 * a native-usage counter ("이번" = this time, "일시" = date), Korean counts those natively ("두 번", "세 개");
 * multi-syllable Sino numbers still do ("삼십 개"). This trades a little recall for not inventing numbers; the
 * corpus texts are all recognised (tested).
 *
 * SCORING RULE — the LAST number in the FINAL non-empty response transcript is the answer. A model that restates
 * the question before answering ("7 더하기 8은 15입니다") is still scored on 15. A model that answers and then
 * restates an operand afterwards is scored wrong; that is a known, documented limit of the rule.
 */
export const VOICE_EVAL_SCORER_VERSION = 2;
export interface SpokenNumber {value:number;index:number}
export type AnswerVerdict = 'correct'|'wrong'|'no-answer'|`trap:${VoiceEvalTrapKind}`;
export interface DeliveredScore {
  verdict:'exact'|'missing-number'|'missing-term'|'empty';missingOperands:number[];missingTerms:string[][];
}

const SINO_DIGITS:Record<string,number> = {일:1,이:2,삼:3,사:4,오:5,육:6,칠:7,팔:8,구:9};
const SINO_SMALL:Record<string,number> = {십:10,백:100,천:1000};
const SINO_BIG:Record<string,number> = {만:10_000,억:100_000_000};
const NATIVE_TENS:[string,number][] = [['열',10],['스물',20],['스무',20],['서른',30],['마흔',40],['쉰',50],['예순',60],['일흔',70],['여든',80],['아흔',90]];
const NATIVE_UNITS:[string,number,boolean][] = [['하나',1,false],['둘',2,false],['셋',3,false],['넷',4,false],['다섯',5,false],
  ['여섯',6,false],['일곱',7,false],['여덟',8,false],['아홉',9,false],['한',1,true],['두',2,true],['세',3,true],['네',4,true]];
/** Particles and copulas that may follow a numeral inside the same word. */
export const KOREAN_NUMBER_SUFFIXES:readonly string[] = ['은','는','이','가','을','를','과','와','에','에서','에다','에다가','에게',
  '으로','로','도','만','까지','부터','이랑','랑','하고','이고','이며','이면','면','이나','나','의','보다','입니다','이에요','예요',
  '이요','요','이야','야','이다','이죠','죠','이네요','네요','인가요','이니까','니까','짜리','째'];
export const KOREAN_COUNTERS:readonly string[] = ['개','번','명','가지','살','시','마리','권','잔','대','장','줄','단계'];
/** Counters a single Sino digit may take; every other counter is used with native numerals ("두 번", not "이번"). */
export const SINO_DIGIT_COUNTERS:readonly string[] = ['단계'];
/** Particles that only follow a final consonant / only follow a vowel (the other member of each pair). */
const AFTER_CONSONANT_ONLY:readonly string[] = ['은','이','을','과','이랑','으로'];
const AFTER_VOWEL_ONLY:readonly string[] = ['는','가','를','와','랑'];
const EN_UNITS:Record<string,number> = {one:1,two:2,three:3,four:4,five:5,six:6,seven:7,eight:8,nine:9};
const EN_TEENS:Record<string,number> = {ten:10,eleven:11,twelve:12,thirteen:13,fourteen:14,fifteen:15,sixteen:16,seventeen:17,eighteen:18,nineteen:19};
const EN_TENS:Record<string,number> = {twenty:20,thirty:30,forty:40,fifty:50,sixty:60,seventy:70,eighty:80,ninety:90};
const EN_SCALES:Record<string,number> = {thousand:1000,million:1_000_000};

export const VOICE_EVAL_SCORER_HASH = sha256Hex(canonicalJson({scorer:'agentstoz-voice-eval-scorer',version:VOICE_EVAL_SCORER_VERSION,
  rule:'last-number-in-final-response',suffixes:KOREAN_NUMBER_SUFFIXES,counters:KOREAN_COUNTERS,sinoDigitCounters:SINO_DIGIT_COUNTERS,
  afterConsonantOnly:AFTER_CONSONANT_ONLY,afterVowelOnly:AFTER_VOWEL_ONLY}));

/** A whole-string Sino-Korean numeral, or null when it is not well formed (units must strictly descend). */
function sinoValue(text:string):{value:number;endsBig:boolean}|null {
  if(text==='영'||text==='공')return {value:0,endsBig:false};
  let total=0,section=0,pending:number|null=null,lastSmall=Infinity,lastBig=Infinity,endsBig=false;
  for(const ch of text){
    endsBig=false;
    if(ch in SINO_DIGITS){if(pending!==null)return null;pending=SINO_DIGITS[ch]!;}
    else if(ch in SINO_SMALL){
      const u=SINO_SMALL[ch]!;if(u>=lastSmall)return null;
      section+=(pending??1)*u;pending=null;lastSmall=u;
    }else if(ch in SINO_BIG){
      const u=SINO_BIG[ch]!;if(u>=lastBig)return null;
      const part=section+(pending??0);
      total+=(part||1)*u;section=0;pending=null;lastSmall=Infinity;lastBig=u;endsBig=true;
    }else return null;
  }
  if(!text)return null;
  return {value:total+section+(pending??0),endsBig};
}
function nativeValue(text:string):{value:number;attributive:boolean}|null {
  let rest=text,value=0,attributive=false,matched=false;
  for(const [word,n] of NATIVE_TENS)if(rest.startsWith(word)){value+=n;rest=rest.slice(word.length);matched=true;attributive=word==='스무';break;}
  if(rest&&!(value&&attributive)){
    let unit=false;
    for(const [word,n,attr] of NATIVE_UNITS)if(rest===word){value+=n;rest='';matched=true;attributive=attr;unit=true;break;}
    if(!unit)return null;
  }
  return matched&&!rest?{value,attributive}:null;
}
/** Does the last syllable of `head` end in a consonant (batchim)? */
const endsInConsonant=(head:string)=>{const code=head.codePointAt(head.length-1)!-0xac00;return code>=0&&code<11172&&code%28!==0;};
/** A particle/copula that may follow `head`; without `head` the allomorph is not checked (counters vary). */
const suffixOk=(rest:string,head?:string)=>{
  if(rest==='')return true;
  if(!KOREAN_NUMBER_SUFFIXES.includes(rest))return false;
  if(head===undefined)return true;
  return !(endsInConsonant(head)?AFTER_VOWEL_ONLY:AFTER_CONSONANT_ONLY).includes(rest);
};
const counterWord=(word:string,counters:readonly string[]=KOREAN_COUNTERS)=>
  counters.some(c=>word.startsWith(c)&&suffixOk(word.slice(c.length),c));

interface Token {kind:'digits'|'hangul'|'latin'|'space'|'hyphen'|'other';text:string;index:number}
function tokenize(text:string):Token[] {
  const tokens:Token[]=[];
  for(const m of text.normalize('NFC').matchAll(/(\d+(?:,\d{3})*)|([가-힣]+)|([A-Za-z]+)|(\s+)|(-)|([\s\S])/gu)){
    const kind=m[1]?'digits':m[2]?'hangul':m[3]?'latin':m[4]?'space':m[5]?'hyphen':'other';
    tokens.push({kind,text:m[0],index:m.index!});
  }
  return tokens;
}
/** Every recognised number with the offset where it starts, in order. */
export function extractSpokenNumbers(text:string):SpokenNumber[] {
  const tokens=tokenize(text),out:(SpokenNumber&{bigUnit:number})[]=[];
  const prevKind=(i:number)=>tokens[i-1]?.kind;
  const nextWord=(i:number)=>{let j=i+1;if(tokens[j]?.kind!=='space')return null;j++;return tokens[j]?.kind==='hangul'?tokens[j]!:null;};
  // Merge "만 이천" / "2만 5천": a group ending in a big unit followed (after a space) by a smaller group.
  const push=(n:SpokenNumber&{bigUnit:number},separatedBySpaceOnly:boolean)=>{
    const prev=out.at(-1);
    if(prev&&separatedBySpaceOnly&&prev.bigUnit&&n.value<prev.bigUnit){prev.value+=n.value;prev.bigUnit=n.bigUnit&&n.bigUnit<prev.bigUnit?n.bigUnit:0;return;}
    out.push(n);
  };
  let lastEnd=-1;
  for(let i=0;i<tokens.length;i++){
    const t=tokens[i]!;
    const afterSpace=lastEnd>=0&&tokens.slice(lastEnd+1,i).every(x=>x.kind==='space')&&i>lastEnd+1;
    if(t.kind==='digits'){
      let value=Number(t.text.replaceAll(',','')),bigUnit=0;
      const next=tokens[i+1];
      if(next?.kind==='hangul'){
        let mult=1,k=0;
        for(const ch of next.text){if(ch in SINO_BIG||ch==='천'||ch==='백'){mult*=SINO_BIG[ch]??SINO_SMALL[ch]!;k++;}else break;}
        if(k){value*=mult;if(mult>=10_000)bigUnit=mult>=100_000_000?100_000_000:10_000;i++;}
      }
      if(Number.isSafeInteger(value)){push({value,index:t.index,bigUnit},afterSpace);lastEnd=i;}
      continue;
    }
    if(t.kind==='hangul'){
      const start=i===0||['space','other','hyphen'].includes(prevKind(i)!);
      if(!start)continue;
      const w=t.text;let best:{len:number;value:number;bigUnit:number}|null=null;
      for(let len=w.length;len>=1&&!best;len--){
        const head=w.slice(0,len),rest=w.slice(len);
        const sino=sinoValue(head);
        const sinoCounters=head.length===1&&head in SINO_DIGITS?SINO_DIGIT_COUNTERS:KOREAN_COUNTERS;
        if(sino&&(suffixOk(rest,head)||counterWord(rest,sinoCounters))){best={len,value:sino.value,bigUnit:sino.endsBig?(head.endsWith('억')?100_000_000:10_000):0};break;}
        const native=nativeValue(head);
        if(native){
          const ok=native.attributive?counterWord(rest)||(rest===''&&!!nextWord(i)&&counterWord(nextWord(i)!.text)):suffixOk(rest,head)||counterWord(rest);
          if(ok){best={len,value:native.value,bigUnit:0};break;}
        }
      }
      if(best){push({value:best.value,index:t.index,bigUnit:best.bigUnit},afterSpace);lastEnd=i;}
      continue;
    }
    if(t.kind==='latin'){
      // English number words: a run of number words joined by spaces or hyphens.
      let current=0,total=0,last:'unit'|'teen'|'tens'|'hundred'|'scale'|null=null,j=i,end=i,used=false;
      const flush=()=>{if(used){push({value:total+current,index:tokens[i]!.index,bigUnit:0},false);lastEnd=end;}};
      for(;j<tokens.length;j++){
        const x=tokens[j]!;
        if(x.kind==='space'||x.kind==='hyphen')continue;
        if(x.kind!=='latin')break;
        const w=x.text.toLowerCase();
        if(w==='and'&&(last==='hundred'||last==='scale')){
          let k=j+1;while(tokens[k]&&(tokens[k]!.kind==='space'))k++;
          const n=tokens[k]?.kind==='latin'?tokens[k]!.text.toLowerCase():'';
          if(n in EN_UNITS||n in EN_TEENS||n in EN_TENS)continue;
          break;
        }
        if(w==='zero'){if(used)break;used=true;end=j;j++;break;}
        if(w in EN_UNITS){if(last==='unit'||last==='teen')break;current+=EN_UNITS[w]!;last='unit';}
        else if(w in EN_TEENS){if(last&&last!=='hundred'&&last!=='scale')break;current+=EN_TEENS[w]!;last='teen';}
        else if(w in EN_TENS){if(last&&last!=='hundred'&&last!=='scale')break;current+=EN_TENS[w]!;last='tens';}
        else if(w==='hundred'){if(last==='hundred'||last==='tens')break;current=(current||1)*100;last='hundred';}
        else if(w in EN_SCALES){if(last==='scale'&&!current)break;total+=(current||1)*EN_SCALES[w]!;current=0;last='scale';}
        else break;
        used=true;end=j;
      }
      flush();
      i=Math.max(i,end);
      continue;
    }
  }
  return out.map(({value,index})=>({value,index}));
}
export function normalizeSpokenNumbers(text:string):number[] {return extractSpokenNumbers(text).map(n=>n.value);}

/** Score the final spoken response of a case. */
export function scoreAnswer(finalOutputTranscripts:readonly string[], item:VoiceEvalItem):AnswerVerdict {
  const final=[...finalOutputTranscripts].reverse().find(t=>typeof t==='string'&&t.trim());
  if(!final)return 'no-answer';
  const answer=normalizeSpokenNumbers(final).at(-1);
  if(answer===undefined)return 'wrong';
  if(answer===item.expected.answer)return 'correct';
  const trap=item.traps.find(t=>t.value===answer);
  return trap?`trap:${trap.kind}`:'wrong';
}
const squash=(text:string)=>text.normalize('NFKC').toLowerCase().replace(/\s+/g,'');
/** Score the exact text typed into a workroom in relay mode: every operand in order, and every term group. */
export function scoreDelivered(text:string, item:VoiceEvalItem):DeliveredScore {
  if(typeof text!=='string'||!text.trim())return {verdict:'empty',missingOperands:[...item.expected.operands],missingTerms:item.expected.terms.map(g=>[...g])};
  const numbers=normalizeSpokenNumbers(text),missingOperands:number[]=[];
  let at=0;
  for(const operand of item.expected.operands){
    const found=numbers.indexOf(operand,at);
    if(found<0)missingOperands.push(operand);else at=found+1;
  }
  const flat=squash(text);
  const missingTerms=item.expected.terms.filter(group=>!group.some(term=>flat.includes(squash(term)))).map(g=>[...g]);
  const verdict=missingOperands.length?'missing-number':missingTerms.length?'missing-term':'exact';
  return {verdict,missingOperands,missingTerms};
}
