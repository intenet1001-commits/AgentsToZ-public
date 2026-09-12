export interface ProjectCreationIntentInput {hostId: string; controllerId: string; workspaceRootId: string; projectName: string}
export interface ProjectCreationIntent {key: string; actionId: string}
type IntentStorage = Pick<Storage, 'getItem' | 'setItem'>;

/** SHA-256 for metadata fingerprints. Also works on LAN HTTP, where SubtleCrypto is unavailable. */
export function projectCreationIntentFingerprint(text: string): string {
  const bytes = new TextEncoder().encode(text), length = Math.ceil((bytes.length + 9) / 64) * 64;
  const data = new Uint8Array(length); data.set(bytes); data[bytes.length] = 0x80;
  const view = new DataView(data.buffer); view.setUint32(length - 4, bytes.length * 8);
  const k = [0x428a2f98,0x71374491,0xb5c0fbcf,0xe9b5dba5,0x3956c25b,0x59f111f1,0x923f82a4,0xab1c5ed5,0xd807aa98,0x12835b01,0x243185be,0x550c7dc3,0x72be5d74,0x80deb1fe,0x9bdc06a7,0xc19bf174,0xe49b69c1,0xefbe4786,0x0fc19dc6,0x240ca1cc,0x2de92c6f,0x4a7484aa,0x5cb0a9dc,0x76f988da,0x983e5152,0xa831c66d,0xb00327c8,0xbf597fc7,0xc6e00bf3,0xd5a79147,0x06ca6351,0x14292967,0x27b70a85,0x2e1b2138,0x4d2c6dfc,0x53380d13,0x650a7354,0x766a0abb,0x81c2c92e,0x92722c85,0xa2bfe8a1,0xa81a664b,0xc24b8b70,0xc76c51a3,0xd192e819,0xd6990624,0xf40e3585,0x106aa070,0x19a4c116,0x1e376c08,0x2748774c,0x34b0bcb5,0x391c0cb3,0x4ed8aa4a,0x5b9cca4f,0x682e6ff3,0x748f82ee,0x78a5636f,0x84c87814,0x8cc70208,0x90befffa,0xa4506ceb,0xbef9a3f7,0xc67178f2];
  const h = [0x6a09e667,0xbb67ae85,0x3c6ef372,0xa54ff53a,0x510e527f,0x9b05688c,0x1f83d9ab,0x5be0cd19];
  const rotate = (x: number, n: number) => (x >>> n) | (x << (32 - n));
  for (let offset = 0; offset < length; offset += 64) {
    const w = new Int32Array(64);
    for (let i = 0; i < 64; i++) w[i] = i < 16 ? view.getInt32(offset + i * 4)
      : ((rotate(w[i-2]!,17)^rotate(w[i-2]!,19)^(w[i-2]!>>>10)) + w[i-7]! + (rotate(w[i-15]!,7)^rotate(w[i-15]!,18)^(w[i-15]!>>>3)) + w[i-16]!) | 0;
    let [a,b,c,d,e,f,g,q] = h as [number,number,number,number,number,number,number,number];
    for (let i = 0; i < 64; i++) {
      const t1 = (q + (rotate(e,6)^rotate(e,11)^rotate(e,25)) + ((e&f)^(~e&g)) + k[i]! + w[i]!) | 0;
      const t2 = ((rotate(a,2)^rotate(a,13)^rotate(a,22)) + ((a&b)^(a&c)^(b&c))) | 0;
      q=g;g=f;f=e;e=(d+t1)|0;d=c;c=b;b=a;a=(t1+t2)|0;
    }
    [a,b,c,d,e,f,g,q].forEach((value,i)=>{h[i]=(h[i]!+value)|0;});
  }
  return h.map(value=>(value>>>0).toString(16).padStart(8,'0')).join('');
}

/** Self-contained factory shared verbatim by bundled React and the static LAN script.
 * Only hashes and random request IDs are stored. No tokens, names, paths or account data.
 * Unknown outcomes are not aged out: a full registry refuses before any network send.
 */
export function createProjectCreationIntentStore(storage: IntentStorage, randomId: () => string,
  fingerprint: (text: string) => string = projectCreationIntentFingerprint) {
  const storageKey = 'agentstoz-project-create-intents-v1', limit = 32;
  const failed = () => new Error('프로젝트 생성 요청 기록을 저장하거나 확인하지 못했습니다. 브라우저 저장 공간과 기존 프로젝트 목록을 확인하세요.');
  function read(): Record<string, string> {
    try {
      const text = storage.getItem(storageKey); if (text === null) return {};
      if (text.length > 12_000) throw failed();
      const value = JSON.parse(text);
      if (!value || value.schemaVersion !== 1 || Object.keys(value).sort().join() !== 'entries,schemaVersion' || !value.entries || typeof value.entries !== 'object' || Array.isArray(value.entries)) throw failed();
      const entries = Object.entries(value.entries);
      if (entries.length > limit || entries.some(([key,id]) => !/^[a-f0-9]{64}$/.test(key) || typeof id !== 'string' || !/^[A-Za-z0-9_-]{8,100}$/.test(id))) throw failed();
      return {...value.entries};
    } catch { throw failed(); }
  }
  const save = (entries: Record<string, string>) => { try { storage.setItem(storageKey,JSON.stringify({schemaVersion:1,entries})); } catch { throw failed(); } };
  return {
    reserve(input: ProjectCreationIntentInput): ProjectCreationIntent {
      if (Object.values(input).some(value=>typeof value !== 'string'||!value||value.length>500)) throw failed();
      const key = fingerprint(JSON.stringify([input.hostId,input.controllerId,input.workspaceRootId,input.projectName.trim()]));
      const entries = read();
      if (entries[key]) return {key,actionId:entries[key]!};
      if (Object.keys(entries).length >= limit) throw new Error('미확정 프로젝트 생성 요청이 많습니다. 기존 요청의 결과를 먼저 확인하세요.');
      const actionId = randomId(); if (!/^[A-Za-z0-9_-]{8,100}$/.test(actionId)) throw failed();
      entries[key] = actionId; save(entries);
      return {key,actionId};
    },
    discardChangedInput(input: ProjectCreationIntentInput): void {
      const key = fingerprint(JSON.stringify([input.hostId,input.controllerId,input.workspaceRootId,input.projectName.trim()]));
      const entries = read(); if (!entries[key]) return;
      delete entries[key]; save(entries);
    },
    discardChangedIntent(intent: ProjectCreationIntent): void {
      const entries = read(); if (entries[intent.key] !== intent.actionId) return;
      delete entries[intent.key]; save(entries);
    },
    complete(intent: ProjectCreationIntent, confirmedActionId: string): void {
      if (confirmedActionId !== intent.actionId) return;
      const entries = read(); if (entries[intent.key] !== intent.actionId) return;
      delete entries[intent.key]; save(entries);
    },
  };
}
