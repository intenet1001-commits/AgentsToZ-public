import {mkdirSync,mkdtempSync,chmodSync,writeFileSync,rmSync,openSync,closeSync} from 'node:fs';
import {join,resolve} from 'node:path';
import {inspectUnsignedArchive,sourceProvenance,unsignedArchiveArguments} from './ios-release-readiness';

if(process.argv.length !== 2) throw Error('Arguments are not supported; this command only makes a new unsigned local rehearsal.');
if(process.platform !== 'darwin') throw Error('Unsigned iOS archive requires macOS and full Xcode.');
const root=resolve(import.meta.dir,'../../..');
const base=join(root,'mobile/ios/build/unsigned-archives');mkdirSync(base,{recursive:true});
const output=mkdtempSync(join(base,'rehearsal-'));chmodSync(output,0o700);
const archive=join(output,'AgentsToZMobile-UNSIGNED.xcarchive'),derived=join(output,'DerivedData');
const args=unsignedArchiveArguments(join(root,'mobile/ios/AgentsToZMobile.xcodeproj'),archive,derived);
const provenance=sourceProvenance(root);
const logFD=openSync(join(output,'archive.log'),'wx',0o600);
console.log('무서명 iPhone용 Release archive를 생성합니다. 설치·TestFlight·업로드를 수행하지 않습니다.');
const child=Bun.spawn(args,{cwd:root,stdin:'ignore',stdout:logFD,stderr:logFD});
closeSync(logFD);
const timeout=setTimeout(()=>child.kill(),600_000);
let report:unknown;
try {
 const code=await child.exited;
 chmodSync(join(output,'archive.log'),0o600);
 if(code!==0)throw Error('UNSIGNED_ARCHIVE_BUILD_FAILED');
 const assessment=inspectUnsignedArchive(archive);
 report={createdAt:new Date().toISOString(),...assessment,provenance};
 writeFileSync(join(output,'readiness.json'),JSON.stringify(report,null,2)+'\n',{mode:0o600});
 if(!assessment.archiveValid)throw Error('UNSIGNED_ARCHIVE_VERIFICATION_FAILED');
 console.log(JSON.stringify({archive,report:join(output,'readiness.json'),archiveValid:true,testFlightReady:false,distributable:false,releaseGates:assessment.releaseGates},null,2));
}finally{
 clearTimeout(timeout);
 // Keep the reviewable archive/log/report. This directory was created by this run.
 rmSync(derived,{recursive:true,force:true});
}
