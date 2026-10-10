/**
 * Orders registered names by how much they sound like what was said.
 *
 * Voice transcribes English project names phonetically (「바이브2」 for vibe2, 「클로드」 for claude),
 * so the exact resolver misses them and hands the calling model a list of names to map from. On a
 * busy Mac that list is cut to fit a voice tool result, and vibe2 has to be on the page that is
 * sent (2026-09-29: ~140 projects pushed it out). This is only an ordering — it never picks a
 * project; the resolver stays exact and the model still confirms the name.
 */

// Revised Romanization, leaning toward how English loanwords are written in Hangul.
const INITIALS=['g','kk','n','d','tt','r','m','b','pp','s','ss','','j','jj','ch','k','t','p','h'];
const MEDIALS=['a','ae','ya','yae','eo','e','yeo','ye','o','wa','wae','oe','yo','u','wo','we','wi','yu','eu','ui','i'];
const FINALS=['','k','k','ks','n','nj','nh','t','l','lk','lm','lb','ls','lt','lp','lh','m','p','ps','t','t','ng','t','t','k','t','p','h'];
// Consonants Korean does not tell apart in loanwords share one class (b/p/f/v → ㅂ·ㅍ, g/k → ㄱ·ㅋ,
// d/t → ㄷ·ㅌ, j/z/ch → ㅈ·ㅊ, l/r → ㄹ). Vowels, w and y carry no class: they vary most in transcription.
const SOUNDS:Record<string,string>={b:'b',p:'b',f:'b',v:'b',g:'k',k:'k',d:'t',t:'t',s:'s',z:'j',j:'j',l:'l',r:'l',m:'m',n:'n',h:'h'};

function romanized(text:string):string{
  let out='';
  for(const character of text){
    const code=character.codePointAt(0)!-0xac00;
    out+=code>=0&&code<11172?INITIALS[Math.floor(code/588)]!+MEDIALS[Math.floor(code%588/28)]!+FINALS[code%28]!:character;
  }
  return out;
}

/** The consonant skeleton of a name as it sounds: 「바이브2」 and vibe2 are both b2. */
export function spokenKey(text:string):string{
  const latin=romanized(text.normalize('NFKC').toLowerCase())
    .replace(/ph/g,'f').replace(/ch/g,'j').replace(/sh/g,'s').replace(/ck/g,'k').replace(/x/g,'ks').replace(/q/g,'k')
    .replace(/c(?=[eiy])/g,'s').replace(/c/g,'k');
  let key='';
  for(const character of latin){
    if(/[0-9]/.test(character)){key+=character;continue;}
    const sound=SOUNDS[character];
    if(sound&&!key.endsWith(sound))key+=sound;
  }
  return key;
}

const flat=(value:string)=>value.normalize('NFKC').replace(/\s+/g,'').toLocaleLowerCase('ko-KR');
const numbers=(value:string)=>value.normalize('NFKC').match(/\d+/g)?.join(' ')??'';
const letters=(key:string)=>key.replace(/[0-9]/g,'');

/** Dice coefficient over adjacent pairs; a one-sound key only counts as the start of a longer one. */
function similarity(left:string,right:string):number{
  if(!left||!right)return 0;
  if(left===right)return 1;
  if(left.length<2||right.length<2){
    const [short,long]=left.length<right.length?[left,right]:[right,left];
    return long.startsWith(short)?2/(1+long.length):0;
  }
  const pairs=new Map<string,number>();
  for(let index=0;index<left.length-1;index++){const pair=left.slice(index,index+2);pairs.set(pair,(pairs.get(pair)??0)+1);}
  let shared=0;
  for(let index=0;index<right.length-1;index++){const pair=right.slice(index,index+2),count=pairs.get(pair)??0;if(count){shared++;pairs.set(pair,count-1);}}
  return 2*shared/(left.length+right.length-2);
}

/** How much any of `names` sounds like `spoken`: about 1 is the same sound, 0 nothing in common. */
export function spokenNameScore(spoken:string,names:readonly string[]):number{
  const heard=letters(spokenKey(spoken)),typed=flat(spoken),digits=numbers(spoken);
  let best=0;
  for(const name of names){
    const text=flat(name);
    // A typed or spoken part of a name ("vibe" in vibe2) is as good as the same sound.
    let score=Math.max(similarity(heard,letters(spokenKey(name))),typed&&text&&(text.includes(typed)||typed.includes(text))?0.9:0);
    // The number is what tells vibe2 from vibe3: the same number lifts a name, a different one lowers it.
    const own=numbers(name);
    if(digits)score+=own===digits?0.25:own?-0.25:0;
    best=Math.max(best,score);
  }
  return best;
}

/** Items most like `spoken` first; equally likely items keep their original order. Nothing is dropped. */
export function rankBySpokenName<T extends {name:string;aliases?:readonly string[]}>(spoken:string,items:readonly T[]):T[]{
  if(!spoken.trim())return [...items];
  return items.map((item,index)=>({item,index,score:spokenNameScore(spoken,[item.name,...(item.aliases??[])])}))
    .sort((left,right)=>right.score-left.score||left.index-right.index).map(entry=>entry.item);
}
