import { MemorySessionStore } from '../src/memorySessionStore';
import { afterEach, describe, expect, test } from "bun:test";
import { appendFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { prepareProjectMemorySession, initializeProjectMemory } from "../project-memory-server";
import { writeMemoryDocumentTransaction, memoryDocumentRecoveryStatus, MEMORY_DOCUMENT_PENDING } from "../src/memoryDocumentTransaction";
import { acquireWorkspaceLease } from "../src/workspaceLease";
import { resolveAppDataDir } from "../src/appDataDir";
import { startTestApiServer } from "./startTestApiServer";

const roots: string[] = [];
const children: Bun.Subprocess[] = [];

afterEach(async () => {
  for (const child of children.splice(0)) {
    try { child.kill(); } catch {}
    await child.exited.catch(() => undefined);
  }
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

async function post(baseUrl: string, path: string, body: unknown, headers: Record<string, string> = {}) {
  const response = await fetch(`${baseUrl}${path}`, {
    method: "POST",
    headers: { "Content-Type": "application/json", ...headers },
    body: JSON.stringify(body),
  });
  return { response, body: await response.json() as any };
}

async function fixture() {
  const home = realpathSync(mkdtempSync(join(tmpdir(), "agentstoz-service-api-")));
  roots.push(home);
  const project = join(home, "projects", "study-finance");
  mkdirSync(project, { recursive: true });
  Bun.spawnSync(["git", "init", "-q"], { cwd: project });
  const memory = initializeProjectMemory({
    folderPath: project,
    projectName: "Study Finance",
    autoBackup: false,
  });
  const apiEnv = {
    ...process.env,
    HOME: home,
    APPDATA: join(home, "AppData", "Roaming"),
    XDG_CONFIG_HOME: join(home, ".config"),
  };
  const appData = resolveAppDataDir(process.platform, apiEnv, home);
  mkdirSync(appData, { recursive: true });
  writeFileSync(join(appData, "ports.json"), JSON.stringify([{
    id: "study-finance-id",
    name: "Study Finance",
    folderPath: project,
  }]));
  const { baseUrl, child } = await startTestApiServer({
    cwd: join(import.meta.dir, ".."),
    env: apiEnv,
  });
  children.push(child);
  return { appData, baseUrl, memory, project };
}

describe("USE service memory HTTP API", () => {
  test("is read-only on status and creates one stable local memory only on ensure", async () => {
    const { appData, baseUrl, memory, project } = await fixture();
    const serviceRoot = join(appData, "service-memories");

    const before = await post(baseUrl, "/api/service-memory/status", {
      portId: "study-finance-id",
      serviceKey: "default",
    });
    expect(before.response.status).toBe(200);
    expect(before.body.serviceMemory).toEqual({ exists: false, ready: false, record: null, problem: null });
    expect(existsSync(serviceRoot)).toBe(false);

    const bootstrapBefore = await post(baseUrl, "/api/buzz-agent-bootstrap/status", {
      scope: "service",
      portId: "study-finance-id",
      deviceName: "Test Mac",
    });
    expect(bootstrapBefore.response.status).toBe(200);
    expect(bootstrapBefore.body.serviceMemory).toBeNull();
    expect(bootstrapBefore.body.instructions).toBeNull();
    expect(existsSync(serviceRoot)).toBe(false);

    const created = await post(baseUrl, "/api/service-memory/ensure", {
      portId: "study-finance-id",
      serviceKey: "default",
      displayName: "study_finance",
    });
    expect(created.response.status).toBe(200);
    expect(created.body.created).toBe(true);
    expect(created.body.project).toMatchObject({
      projectId: "study-finance-id",
      canonicalPath: project,
      memoryId: memory.config!.memoryId,
    });
    expect(created.body.serviceMemory).toMatchObject({
      exists: true,
      ready: true,
      record: {
        role: "use",
        linkedProjectMemoryId: memory.config!.memoryId,
        linkedCanonicalPath: project,
      },
    });

    const serviceMemoryId = created.body.serviceMemory.record.serviceMemoryId as string;
    const sourcePath = created.body.serviceMemory.record.sourcePath as string;
    appendFileSync(sourcePath, "\nValidated use note.\n");

    const reused = await post(baseUrl, "/api/service-memory/ensure", {
      portId: "study-finance-id",
      serviceKey: "default",
      displayName: "study_finance",
    });
    expect(reused.response.status).toBe(200);
    expect(reused.body.created).toBe(false);
    expect(reused.body.serviceMemory.record.serviceMemoryId).toBe(serviceMemoryId);
    expect(readFileSync(sourcePath, "utf8")).toContain("Validated use note.");

    const bootstrapAfter = await post(baseUrl, "/api/buzz-agent-bootstrap/status", {
      scope: "service",
      portId: "study-finance-id",
      deviceName: "Test Mac",
    });
    expect(bootstrapAfter.response.status).toBe(200);
    expect(bootstrapAfter.body.serviceMemory.serviceMemoryId).toBe(serviceMemoryId);
    expect(bootstrapAfter.body.instructions).toContain("DEV_HANDOFF");
    expect(bootstrapAfter.body.instructions).toContain(sourcePath);
  }, 30_000);

  test("rejects unregistered projects and remote web origins without creating memory", async () => {
    const { appData, baseUrl } = await fixture();
    const missing = await post(baseUrl, "/api/service-memory/ensure", { portId: "missing-id" });
    expect(missing.response.status).toBe(404);
    expect(missing.body.code).toBe("PROJECT_NOT_REGISTERED");

    const denied = await post(baseUrl, "/api/service-memory/ensure", {
      portId: "study-finance-id",
    }, { Origin: "https://attacker.example" });
    expect(denied.response.status).toBe(403);
    expect(denied.body.code).toBe("LOCAL_API_ORIGIN_DENIED");
    expect(existsSync(join(appData, "service-memories"))).toBe(false);
  }, 30_000);
});


test("document recovery HTTP route verifies registration and workspace ownership before resuming", async () => {
  const { appData, baseUrl, memory, project } = await fixture();
  const root = realpathSync(project);
  const context = { root, memoryId: memory.config!.memoryId, primaryPath: ".agent-memory/CORE.md", safePath: (path: string) => join(root, path) };
  const before = readFileSync(join(root, context.primaryPath), "utf8");
  const after = `${before}\nRecovered document fixture\n`;
  expect(() => writeMemoryDocumentTransaction(context, [
    { path: ".agent-memory/notes/recovery.md", content: "fixture" },
    { path: context.primaryPath, content: after },
  ], { afterFile: () => { throw new Error("interrupted"); } })).toThrow("interrupted");
  const body = { folderPath: project, transactionId: memoryDocumentRecoveryStatus(context).transactionId };
  const route = "/api/project-memory/document-recovery";
  const lease = await acquireWorkspaceLease({ workspacePath: project, appDataDir: appData });
  try {
    const blocked = await post(baseUrl, route, body);
    expect(blocked.response.status).toBe(409);
    expect(blocked.body.code).toBe("WORKSPACE_LEASE_BUSY");
  } finally { lease.release(); }
  const portsFile = join(appData, "ports.json");
  const registered = readFileSync(portsFile, "utf8");
  writeFileSync(portsFile, "[]");
  expect((await post(baseUrl, route, body)).response.status).toBe(409);
  expect(readFileSync(join(root, context.primaryPath), "utf8")).toBe(before);
  expect(existsSync(join(root, MEMORY_DOCUMENT_PENDING))).toBe(true);
  writeFileSync(portsFile, registered);
  expect((await post(baseUrl, route, { ...body, transactionId: "stale" })).response.status).toBe(409);
  const recovered = await post(baseUrl, route, body);
  expect(recovered.response.status).toBe(200);
  expect(recovered.body).toEqual({ success: true, documentRecovered: true, sessionCompletionVerified: false });
  expect(readFileSync(join(root, context.primaryPath), "utf8")).toBe(after);
  expect(existsSync(join(root, MEMORY_DOCUMENT_PENDING))).toBe(false);
}, 30_000);


test("session recovery API validates registration and reports verified local completion", async () => {
  const {appData,baseUrl,memory,project}=await fixture();
  const root=realpathSync(project);
  const store=new MemorySessionStore(join(appData,"memory-session-recovery.sqlite"));
  const plan=prepareProjectMemorySession({root,memoryPath:memory.memoryPath!,next:"# Project Core Memory\nRecovered session\n",narrative:"Recovered session",agent:"codex",autoBackup:false});
  store.prepare(plan);
  const status=await post(baseUrl,"/api/project-memory/detect",{folderPath:project});
  expect(status.body.sessionRecovery).toEqual({id:plan.id,phase:"document"});
  expect(JSON.stringify(status.body.sessionRecovery)).not.toContain("Recovered session");
  const lease=await acquireWorkspaceLease({workspacePath:project,appDataDir:appData});
  try {
    const busy=await post(baseUrl,"/api/project-memory/session-recovery",{folderPath:project,saveId:plan.id});
    expect(busy.body.code).toBe("WORKSPACE_LEASE_BUSY");
  } finally {lease.release();}
  const guarded=await post(baseUrl,"/api/project-memory/mark-remembered",{folderPath:project});
  expect(guarded.response.ok).toBe(false);
  expect(store.status(root)?.phase).toBe("document");
  const recovered=await post(baseUrl,"/api/project-memory/session-recovery",{folderPath:project,saveId:plan.id});
  expect(recovered.response.status).toBe(200);
  expect(recovered.body).toMatchObject({success:true,localSaved:true,sessionCompletionVerified:true,remoteBackedUp:false,backupSkipped:true});
  expect(store.status(root)).toBeNull();
  const repeated=await post(baseUrl,"/api/project-memory/session-recovery",{folderPath:project,saveId:plan.id});
  expect(repeated.response.status).toBe(200);
  expect(repeated.body.alreadyRecovered).toBe(true);
},30_000);

test('V2 session recovery uses the bound receipt path and never resets its AI attempt',async()=>{
  const {MemorySaveStore}=await import('../src/memorySaveStore');
  const {saveDigest}=await import('../src/memorySaveContract');
  const {appData,baseUrl,memory,project}=await fixture(),root=realpathSync(project);
  const sessions=new MemorySessionStore(join(appData,'memory-session-recovery.sqlite'));
  const saves=new MemorySaveStore(join(appData,'memory-save-v2.sqlite'));
  const source=saves.observe({agent:'codex',instanceId:'fixture',sessionId:'fixture-session',turnId:'turn',startByte:0,endByte:1,
    sourceDigest:saveDigest('source'),memoryId:memory.config!.memoryId,policyEpoch:1,completedAt:1,coverageKind:'complete-turn'});
  const job=saves.reserve(memory.config!.memoryId,1,[source]);
  const {createHash}=await import('node:crypto');
  const beforeHash=createHash('sha256').update(readFileSync(memory.memoryPath!)).digest('hex');
  const attemptId=saves.beginAttempt(job.saveId,job.coverageDigest,{inputDigest:saveDigest('input'),beforeHash,providerBindingDigest:saveDigest('provider')});
  const plan=prepareProjectMemorySession({root,memoryPath:memory.memoryPath!,next:'# Project Core Memory\nVerified V2 recovery\n',narrative:'Fixture recovery',agent:'codex',autoBackup:false,saveV2:{saveId:job.saveId,attemptId}});
  sessions.prepare(plan);
  const wrong=await post(baseUrl,'/api/project-memory/session-recovery',{folderPath:root,saveId:'wrong-plan'});
  expect(wrong.response.status).toBe(409);expect(saves.get(job.saveId).phase).toBe('summarizing');
  const recovered=await post(baseUrl,'/api/project-memory/session-recovery',{folderPath:root,saveId:plan.id});
  expect(recovered.response.status).toBe(200);expect(recovered.body).toMatchObject({localSaved:true,sessionCompletionVerified:true,backupSkipped:true});
  expect(saves.get(job.saveId)).toMatchObject({phase:'local-saved',attemptId});expect(sessions.status(root)).toBeNull();
  expect(readFileSync(memory.memoryPath!,'utf8')).toContain('Verified V2 recovery');
  expect((await post(baseUrl,'/api/project-memory/session-recovery',{folderPath:root,saveId:plan.id})).body.alreadyRecovered).toBe(true);
  expect(()=>saves.beginAttempt(job.saveId,job.coverageDigest,{inputDigest:saveDigest('input'),beforeHash,providerBindingDigest:saveDigest('provider')})).toThrow('RECOVERY_REQUIRED');
},30_000);
