#!/usr/bin/env bun
/**
 * Seal a voice/remote benchmark protocol from an operator spec (src/voiceBenchmarkProtocol.ts).
 * Offline: no network, provider or host calls. Writes protocol.json as a manifest with zero trials (mode 0600,
 * refuses to overwrite) and prints only the fingerprint, spec hash and counts.
 *
 *   bun scripts/voice-benchmark-protocol.ts --spec <spec.json> --out <protocol.json>
 *
 * Keep the spec file with the run: its hash records the overbooking factor the protocol itself has no field for.
 */
import {chmodSync, readFileSync, writeFileSync} from 'node:fs';
import {benchmarkSpecHash, buildBenchmarkProtocol, type BenchmarkProtocolSpec} from '../src/voiceBenchmarkProtocol';
import {fingerprintBenchmarkProtocol} from '../src/voiceRemoteBenchmark';

export async function main(args:string[], print:(line:string)=>void=line=>console.log(line)):Promise<number> {
  const at=(name:string)=>{const i=args.indexOf(name);return i>=0?args[i+1]:undefined;};
  const specPath=at('--spec'),out=at('--out');
  if(!specPath||!out){print('usage: bun scripts/voice-benchmark-protocol.ts --spec <spec.json> --out <protocol.json>');return 64;}
  try{
    const spec=JSON.parse(readFileSync(specPath,'utf8')) as BenchmarkProtocolSpec;
    const protocol=buildBenchmarkProtocol(spec);
    writeFileSync(out,JSON.stringify({schemaVersion:1,protocol,trials:[]},null,2)+'\n',{mode:0o600,flag:'wx'});
    chmodSync(out,0o600);
    print(JSON.stringify({fingerprint:fingerprintBenchmarkProtocol(protocol),specHash:benchmarkSpecHash(spec),
      cases:protocol.cases.length,groups:protocol.groups.length,plannedPairs:protocol.groups.reduce((n,g)=>n+g.pairs.length,0)}));
    return 0;
  }catch(error){
    // Codes only: spec contents are not echoed.
    print(JSON.stringify({error:error instanceof Error&&/^[A-Z_]+$/.test(error.message)?error.message:'INVALID_BENCHMARK_SPEC'}));
    return 65;
  }
}
if(import.meta.main)process.exitCode=await main(process.argv.slice(2));
