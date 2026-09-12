import {inspectUnsignedArchive} from './ios-release-readiness';
if(process.argv.length!==3)throw Error('Usage: bun mobile/ios/scripts/verify-archive.ts <local.xcarchive>');
const report=inspectUnsignedArchive(process.argv[2]!);
console.log(JSON.stringify(report,null,2));
if(!report.archiveValid)process.exitCode=1;
