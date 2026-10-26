#!/usr/bin/env bun
/** Explicit unpublished test package. Never installs or publishes, and never changes build numbers. */
import {copyFileSync,existsSync,writeFileSync} from 'node:fs';import {join} from 'node:path';
if(process.platform!=='darwin'||process.arch!=='arm64')throw new Error('This embedded Chromium build is currently validated on Apple Silicon macOS only.');
if(!process.env.CEF_PATH||!existsSync(process.env.CEF_PATH))throw new Error('Set CEF_PATH to the official downloaded CEF SDK cache. CMake 3.x and Ninja must be on PATH.');
async function run(argv:string[]){const p=Bun.spawn(argv,{cwd:import.meta.dir,env:process.env,stdout:'inherit',stderr:'inherit'});if(await p.exited!==0)throw new Error(`${argv[0]} failed.`);}
console.log('Creating a LOCAL TEST ONLY package; no installation, version stamping, signing for distribution or deployment.');
await run(['bun','run','build:sidecar']);await run(['bun','run','build']);
await run(['cargo','build','--locked','--manifest-path','native/workroom-browser/Cargo.toml','--bins']);
await run(['cargo','build','--locked','--manifest-path','src-tauri/Cargo.toml','--features','embedded-browser,tauri/custom-protocol']);
await run([join(import.meta.dir,'native/workroom-browser/target/debug/bundle-workroom-browser')]);
copyFileSync(join(process.env.CEF_PATH,'156.0.7/cef_macos_aarch64/CREDITS.html'),join(import.meta.dir,'output/workroom-browser-native/app.app/Contents/Resources/Chromium-CREDITS.html'));
writeFileSync(join(import.meta.dir,'output/workroom-browser-native/app.app/Contents/Resources/LOCAL-TEST-ONLY.json'),JSON.stringify({purpose:'unpublished-local-test',installed:false,productionSigned:false,notarized:false,createdAt:new Date().toISOString()},null,2));
