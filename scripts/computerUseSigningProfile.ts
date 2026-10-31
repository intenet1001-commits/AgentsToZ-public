import {CONTROL_BUNDLE_ID,CONTROL_TEAM_ID} from './computerUseControlBundle';

/** Only metadata and public certificate digests leave the decoder; certificate bytes never enter logs or errors. */
export function readComputerUseSigningProfileMetadata(decoded:string){
  const projected=Bun.spawnSync(['python3','-c',
    "import sys,plistlib,json,hashlib; p=plistlib.loads(sys.stdin.buffer.read()); k=['TeamIdentifier','Entitlements','ProvisionsAllDevices','ProvisionedDevices']; q={s:p[s] for s in k if s in p}; q['ExpirationDate']=p.get('ExpirationDate').isoformat()+'Z' if p.get('ExpirationDate') else None; c=p.get('DeveloperCertificates'); assert isinstance(c,list) and len(c)>0 and all(isinstance(x,bytes) and len(x)>0 for x in c); q['DeveloperCertificateSHA1']=[hashlib.sha1(x).hexdigest().upper() for x in c]; print(json.dumps(q))"],
    {stdin:Buffer.from(decoded),stdout:'pipe',stderr:'pipe'});
  if(projected.exitCode!==0)throw Error('Could not read the Control provisioning profile metadata or certificate list');
  return JSON.parse(projected.stdout.toString()) as unknown;
}

/** Resolve names to one valid identity and pass its exact fingerprint to codesign, so a later ambiguous name cannot select another certificate. */
export function resolveControlSigningIdentityFingerprint(identity:string, listing:string):string {
  const candidates=new Set<string>();
  const wanted=identity.trim();
  if(!wanted || wanted!==identity)throw Error('Choose one exact Control signing identity or certificate fingerprint');
  for(const line of listing.split(/\r?\n/u)){
    const entry=line.match(/^\s*\d+\)\s+([a-f0-9]{40})\s+"([^"\r\n]+)"\s*$/iu);
    if(!entry)continue;
    if((/^[a-f0-9]{40}$/iu.test(wanted)&&entry[1]!.toUpperCase()===wanted.toUpperCase())||entry[2]===wanted)candidates.add(entry[1]!.toUpperCase());
  }
  if(candidates.size!==1)throw Error('Control signing identity is unavailable or ambiguous; select one valid certificate fingerprint');
  return [...candidates][0]!;
}

/** Metadata and certificate membership only; Apple/OS trust, installed validation, TCC and human approval remain separate. */
export function assertComputerUseSigningProfile(value:unknown,signingFingerprint:string,now=Date.now()){
  if(!value||typeof value!=='object'||Array.isArray(value))throw Error('Control provisioning profile metadata is invalid');
  const p=value as Record<string,any>,ent=p.Entitlements,id=CONTROL_TEAM_ID+'.'+CONTROL_BUNDLE_ID;
  if(!Array.isArray(p.TeamIdentifier)||p.TeamIdentifier.length!==1||p.TeamIdentifier[0]!==CONTROL_TEAM_ID)throw Error('Control provisioning profile must belong to the configured Developer ID team');
  if(!ent||typeof ent!=='object'||Array.isArray(ent)||ent['com.apple.application-identifier']!==id
    ||ent['com.apple.developer.team-identifier']!==CONTROL_TEAM_ID)throw Error('A dedicated AgentsToZ Control App ID profile is required; the Screen profile cannot be reused');
  if(p.ProvisionsAllDevices!==true||p.ProvisionedDevices!==undefined||ent['get-task-allow']===true||ent['com.apple.security.get-task-allow']===true)throw Error('Control requires a Developer ID distribution profile, not a development or device-bound profile');
  // Profiles describe allowed entitlements: Apple's team wildcard authorizes the app's exact group.
  // The signed binary still requests only `id` in controlEntitlements(), never the profile's wildcard.
  const groups=ent['keychain-access-groups'];
  if(!Array.isArray(groups)||!groups.every(g=>typeof g==='string')
    ||!groups.some(g=>g===id||g===CONTROL_TEAM_ID+'.*'))throw Error('Control provisioning profile does not grant its own approval keychain group');
  const expiry=typeof p.ExpirationDate==='string'?Date.parse(p.ExpirationDate):NaN;
  if(!Number.isFinite(expiry)||expiry<=now)throw Error('Control provisioning profile is expired or has no valid expiration');
  const certs=p.DeveloperCertificateSHA1;
  if(!/^[A-F0-9]{40}$/u.test(signingFingerprint)||!Array.isArray(certs)||!certs.length||!certs.every(c=>typeof c==='string'&&/^[A-F0-9]{40}$/u.test(c)))throw Error('Control provisioning profile certificate metadata is invalid');
  if(!certs.includes(signingFingerprint))throw Error('The selected signing certificate is not included in the Control provisioning profile; no build was started');
  return {bundleId:CONTROL_BUNDLE_ID,teamId:CONTROL_TEAM_ID,expiresAt:new Date(expiry).toISOString()};
}

/** Decode the exact bytes that will later be embedded. The temporary input is not written to disk or included in errors. */
export function decodeControlSigningProfile(profile:Buffer):string {
  const decoded=Bun.spawnSync(['/usr/bin/security','cms','-D','-i','/dev/stdin'],{stdin:profile,stdout:'pipe',stderr:'pipe'});
  if(decoded.exitCode!==0)throw Error('Could not decode the Control provisioning profile');
  return decoded.stdout.toString();
}

/** Admission returns the same byte snapshot that was decoded. No certificate or profile contents are logged. */
export function prepareControlSigningProfile(profile:Buffer,identity:string,dependencies:{decode:(bytes:Buffer)=>string; listIdentities:()=>string}={
  decode:decodeControlSigningProfile,
  listIdentities:()=>{
    const result=Bun.spawnSync(['/usr/bin/security','find-identity','-v','-p','codesigning'],{stdout:'pipe',stderr:'pipe'});
    if(result.exitCode!==0)throw Error('Could not inspect the explicitly selected Control signing identity');
    return result.stdout.toString();
  },
},now=Date.now()) {
  const profileBytes=Buffer.from(profile);
  const decoded=dependencies.decode(profileBytes);
  const signingFingerprint=resolveControlSigningIdentityFingerprint(identity,dependencies.listIdentities());
  assertComputerUseSigningProfile(readComputerUseSigningProfileMetadata(decoded),signingFingerprint,now);
  return {profileBytes,signingFingerprint};
}
