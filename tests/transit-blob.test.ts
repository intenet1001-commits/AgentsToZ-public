import {describe,expect,test} from 'bun:test';
import {
  decryptTransitBlob, decryptVocImage, encryptTransitBlob, encryptVocImage, isTransitObjectPath, isVocTransitObjectPath,
  TRANSIT_GCM_OVERHEAD_BYTES, TRANSIT_OBJECT_MAX_BYTES, transitObjectPath, VOC_MAX_IMAGE_BYTES, vocTransitObjectPath,
} from '../src/vocAttachments';
import {WORKROOM_REMOTE_ATTACHMENT_MAX_BYTES} from '../src/workroomRemoteAttachmentProtocol';
import {fetchTransitBlob} from '../src/vocRemoteReceive.server';

/**
 * w13: the phone's workroom attachments reuse the VOC transit (one fresh AES-256-GCM key per object, ciphertext only in
 * the private bucket). The VOC names stay as wrappers and must produce byte-identical envelopes.
 */
const PNG=new Uint8Array([0x89,0x50,0x4e,0x47,0x0d,0x0a,0x1a,0x0a,1,2,3,4,5,6,7,8]);

describe('transit blob crypto', () => {
  test('the numbers come from the bucket: 10 MiB object, 28 bytes of nonce and tag', () => {
    expect(TRANSIT_OBJECT_MAX_BYTES).toBe(10_485_760);
    expect(TRANSIT_GCM_OVERHEAD_BYTES).toBe(28);
    expect(WORKROOM_REMOTE_ATTACHMENT_MAX_BYTES).toBe(10_485_732);
  });

  test('round trip at the largest plaintext; one byte more is refused before encrypting', async () => {
    const plain=new Uint8Array(WORKROOM_REMOTE_ATTACHMENT_MAX_BYTES);for(let i=0;i<plain.length;i+=4096)plain[i]=i&255;
    const sealed=await encryptTransitBlob(plain,WORKROOM_REMOTE_ATTACHMENT_MAX_BYTES);
    expect(sealed.ciphertext.byteLength).toBe(TRANSIT_OBJECT_MAX_BYTES);
    expect(sealed.bytes).toBe(WORKROOM_REMOTE_ATTACHMENT_MAX_BYTES);
    const opened=await decryptTransitBlob(sealed.ciphertext,sealed.key,WORKROOM_REMOTE_ATTACHMENT_MAX_BYTES);
    expect(opened.byteLength).toBe(plain.byteLength);expect(Buffer.from(opened).equals(Buffer.from(plain))).toBe(true);
    let randomCalls=0;const original=crypto.getRandomValues.bind(crypto);
    (crypto as any).getRandomValues=(array:Uint8Array)=>{randomCalls++;return original(array);};
    try{
      await expect(encryptTransitBlob(new Uint8Array(WORKROOM_REMOTE_ATTACHMENT_MAX_BYTES+1),WORKROOM_REMOTE_ATTACHMENT_MAX_BYTES)).rejects.toThrow('TRANSIT_BLOB_TOO_LARGE');
      await expect(encryptTransitBlob(new Uint8Array(0),WORKROOM_REMOTE_ATTACHMENT_MAX_BYTES)).rejects.toThrow('TRANSIT_BLOB_TOO_LARGE');
    }finally{(crypto as any).getRandomValues=original;}
    expect(randomCalls).toBe(0);
    // A ciphertext of exactly the object limit opens; one byte more is refused before any key is imported.
    const longer=new Uint8Array(sealed.ciphertext.byteLength+1);longer.set(sealed.ciphertext);
    await expect(decryptTransitBlob(longer,sealed.key,WORKROOM_REMOTE_ATTACHMENT_MAX_BYTES)).rejects.toThrow('TRANSIT_CIPHERTEXT_SIZE');
    await expect(decryptTransitBlob(sealed.ciphertext,sealed.key.slice(0,-4),WORKROOM_REMOTE_ATTACHMENT_MAX_BYTES)).rejects.toThrow('TRANSIT_KEY_INVALID');
  });

  test('the VOC wrappers keep their limits and error codes', async () => {
    await expect(encryptVocImage(new Uint8Array(VOC_MAX_IMAGE_BYTES+1))).rejects.toThrow('VOC_IMAGE_TOO_LARGE');
    await expect(encryptVocImage(new Uint8Array(0))).rejects.toThrow('VOC_IMAGE_TOO_LARGE');
    const sealed=await encryptVocImage(PNG);
    const longer=new Uint8Array(VOC_MAX_IMAGE_BYTES+28+1);
    await expect(decryptVocImage(longer,sealed.key)).rejects.toThrow('VOC_CIPHERTEXT_SIZE');
    await expect(decryptVocImage(sealed.ciphertext,'AAAA')).rejects.toThrow('VOC_KEY_INVALID');
    expect(await decryptVocImage(sealed.ciphertext,sealed.key)).toEqual(PNG);
  });

  test('a seeded encryptVocImage still produces the envelope recorded from the code before w13', async () => {
    // Recorded with the pre-w13 src/vocAttachments.ts (c717e681): key first, then nonce, from getRandomValues.
    let counter=0;const original=crypto.getRandomValues.bind(crypto);
    (crypto as any).getRandomValues=(array:Uint8Array)=>{for(let i=0;i<array.length;i++)array[i]=(counter++*37+11)&255;return array;};
    let sealed;try{sealed=await encryptVocImage(PNG);}finally{(crypto as any).getRandomValues=original;}
    expect({ciphertext:Buffer.from(sealed.ciphertext).toString('hex'),key:sealed.key,sha256:sealed.sha256,bytes:sealed.bytes}).toEqual({
      ciphertext:'abd0f51a3f6489aed3f81d4210cf806111ba981c8cb8046081be69459aafc2a954c0a49a14bf4775903cbc1b',
      key:'CzBVep_E6Q4zWH2ix-wRNluApcrvFDleg6jN8hc8YYY',
      sha256:'42eb69ec379e5a1308558dac560940d96ab5a0981bfc10b6df218611eacfba9a',
      bytes:16,
    });
  });

  test('transit object paths are the VOC paths under neutral names', () => {
    const host='11111111-2222-4333-8444-555555555555',uid='aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee',object='12345678-1234-4234-8234-123456789abc';
    expect(transitObjectPath(host,uid,object)).toBe(vocTransitObjectPath(host,uid,object));
    expect(isTransitObjectPath(`${host}/${uid}/${object}.bin`,host)).toBe(true);
    expect(isTransitObjectPath(`${host}/${uid}/${object}.bin`,'99999999-2222-4333-8444-555555555555')).toBe(false);
    expect(isTransitObjectPath).toBe(isVocTransitObjectPath);
  });

  test('a download reads at most the declared ciphertext (VOC codes kept): a longer body is cut off', async () => {
    const sealed=await encryptVocImage(PNG);
    let pulled=0;
    const padded=new Uint8Array(sealed.ciphertext.byteLength+64*1024);padded.set(sealed.ciphertext);
    const fetchImpl=(async()=>{let at=0;return new Response(new ReadableStream<Uint8Array>({pull(c){if(at>=padded.byteLength){c.close();return;}const piece=padded.subarray(at,at+512);at+=piece.byteLength;pulled+=piece.byteLength;c.enqueue(piece);}}));}) as unknown as typeof fetch;
    const input={supabaseUrl:'https://example-project.supabase.co',path:transitObjectPath('11111111-2222-4333-8444-555555555555','aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee',crypto.randomUUID()),
      token:'signed-token-'+'x'.repeat(30),key:sealed.key,sha256:sealed.sha256,bytes:sealed.bytes,maxPlainBytes:VOC_MAX_IMAGE_BYTES,fetchImpl};
    await expect(fetchTransitBlob(input)).rejects.toMatchObject({code:'VOC_DOWNLOAD_TOO_LARGE'});
    expect(pulled).toBeLessThanOrEqual(sealed.ciphertext.byteLength+3*512);
    // The exact object still opens.
    const exact=(async()=>new Response(sealed.ciphertext as BodyInit)) as unknown as typeof fetch;
    expect(Buffer.from(await fetchTransitBlob({...input,fetchImpl:exact})).equals(Buffer.from(PNG))).toBe(true);
    await expect(fetchTransitBlob({...input,bytes:VOC_MAX_IMAGE_BYTES+1,fetchImpl:exact})).rejects.toMatchObject({code:'VOC_DOWNLOAD_TOO_LARGE'});
  });
});
