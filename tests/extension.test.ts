import test from "node:test";
import assert from "node:assert/strict";
import { chmodSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { createServer, type Server } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";

type Harness = {
  handlers: Map<string, (...args: any[]) => any>;
  commands: Map<string, (args: string, ctx: any) => Promise<void>>;
  notices: string[];
  messages: string[];
  socketCommands: string[];
  callLog: string;
  shadowLog: string;
  logPath: string;
  ctx: any;
  shutdown: () => Promise<void>;
};

let sequence=0;
async function makeHarness(status: "connected" | "disconnected", mode: "observe" | "recover", failFirst: number, failFrom = 0, waitMs = 0): Promise<Harness> {
  const dir=mkdtempSync(join(tmpdir(),"pi-guard-integration-"));
  const socketCommands:string[]=[];
  const server:Server=createServer((conn)=>conn.once("data",(data)=>{
    socketCommands.push(data.toString());
    conn.end(`${status} pid=123 up=1s\n`);
  }));
  await new Promise<void>((resolve,reject)=>server.listen(join(dir,"svc.sock"),resolve).once("error",reject));
  const callLog=join(dir,"curl-calls");
  const shadowLog=join(dir,"shadowrocket-calls");
  const logPath=join(dir,"proxy-guard.log");
  writeFileSync(logPath,"prior log\n",{mode:0o644});
  const curl=join(dir,"curl");
  writeFileSync(curl,`#!/bin/sh
printf '%s\\n' curl >> "$FAKE_CALL_LOG"
count=$(wc -l < "$FAKE_CALL_LOG" | tr -d ' ')
if [ "$count" -le "$FAKE_FAIL_FIRST" ] || { [ "$FAKE_FAIL_FROM" -gt 0 ] && [ "$count" -ge "$FAKE_FAIL_FROM" ]; }; then printf '000'; exit 28; fi
case " $* " in *"__down"*) printf '200 65536';; *) printf '204';; esac
`);
  chmodSync(curl,0o755);
  for (const program of ["shortcuts","open"]) {
    const path=join(dir,program);
    writeFileSync(path,`#!/bin/sh\nprintf '%s\\n' ${program} >> "$FAKE_SHADOW_LOG"\nexit 1\n`);
    chmodSync(path,0o755);
  }
  const backup={...process.env};
  Object.assign(process.env,{
    PATH:dir+":"+process.env.PATH,
    SAKAMOTO_DIR:dir,
    PI_PROXY_GUARD_BACKEND:"sakamoto",
    PI_PROXY_GUARD_API_URL:"https://user:private-test-token@api.test.invalid/v1?key=private-test-token",
    PI_PROXY_GUARD_PROXY:"http://user:private-test-token@127.0.0.1:2334",
    PI_PROXY_GUARD_SAKAMOTO_MODE:mode,
    PI_PROXY_GUARD_SAKAMOTO_WAIT_MS:String(waitMs),
    PI_PROXY_GUARD_PROBE_ATTEMPTS:"2",
    PI_PROXY_GUARD_PROBE_GAP_MS:"0",
    PI_PROXY_GUARD_BACKOFF_MS:"0",
    PI_PROXY_GUARD_RECHECK_DELAY_MS:"0",
    PI_PROXY_GUARD_WATCHDOG_MS:"0",
    PI_PROXY_GUARD_NOTIFY:"0",
    PI_PROXY_GUARD_LOG:logPath,
    FAKE_CALL_LOG:callLog,
    FAKE_SHADOW_LOG:shadowLog,
    FAKE_FAIL_FIRST:String(failFirst),
    FAKE_FAIL_FROM:String(failFrom),
  });
  const handlers=new Map<string,(...args:any[])=>any>();
  const commands=new Map<string,(args:string,ctx:any)=>Promise<void>>();
  const notices:string[]=[];
  const messages:string[]=[];
  const pi={
    on:(name:string,fn:(...args:any[])=>any)=>{handlers.set(name,fn);return ()=>{};},
    registerCommand:(name:string,def:{handler:(args:string,ctx:any)=>Promise<void>})=>{commands.set(name,def.handler);},
    sendUserMessage:(text:string)=>{messages.push(text);},
  };
  try {
    const extension=await import(`../extensions/proxy-guard.ts?integration=${++sequence}`);
    extension.default(pi);
    const ctx={hasUI:true,ui:{notify:(text:string)=>notices.push(text)},model:{baseUrl:"https://api.test.invalid/v1"},isIdle:()=>true};
    await handlers.get("session_start")?.({},ctx);
    return {handlers,commands,notices,messages,socketCommands,callLog,shadowLog,logPath,ctx,shutdown:async()=>{
      await handlers.get("session_shutdown")?.();
      await new Promise<void>((resolve)=>server.close(()=>resolve()));
      rmSync(dir,{recursive:true,force:true});
      for (const key of Object.keys(process.env)) if (!(key in backup)) delete process.env[key];
      Object.assign(process.env,backup);
    }};
  } catch(err) {
    await new Promise<void>((resolve)=>server.close(()=>resolve()));
    rmSync(dir,{recursive:true,force:true});
    for (const key of Object.keys(process.env)) if (!(key in backup)) delete process.env[key];
    Object.assign(process.env,backup);
    throw err;
  }
}
function boundary(errorMessage:string) {
  return {outcome:"error",context:{canContinue:false,contextMessages:[{role:"assistant",errorMessage}]}};
}
function lines(path:string):number {try{return readFileSync(path,"utf8").trim().split("\n").filter(Boolean).length;}catch{return 0;}}

test("status hides URL credentials and sakamoto API remains private",async()=>{
  const h=await makeHarness("connected","observe",0);
  try {
    await h.commands.get("proxyguard")?.("status",h.ctx);
    const status=h.notices.at(-1)??"";
    assert.ok(status.includes("backend=sakamoto") && status.includes("sakamotoMode=observe"));
    assert.ok(!status.includes("private-test-token"));
    assert.ok(!readFileSync(h.logPath,"utf8").includes("private-test-token"));
    assert.equal(statSync(h.logPath).mode & 0o777, 0o600);
    assert.ok(status.includes("shortcut=\"disabled\""));
    assert.equal(lines(h.shadowLog),0);
  } finally {await h.shutdown();}
});

test("quota errors never probe or invoke Shadowrocket",async()=>{
  const h=await makeHarness("connected","recover",0);
  try {
    const result=await h.handlers.get("agent_before_settle")?.(boundary("HTTP 429 rate limit"),h.ctx);
    assert.equal(result,undefined);
    assert.equal(lines(h.callLog),0);
    assert.equal(lines(h.shadowLog),0);
    assert.ok(h.notices.some((x)=>x.includes("Provider/account error")));
  } finally {await h.shutdown();}
});

test("disconnected sakamoto is never started by the extension",async()=>{
  const h=await makeHarness("disconnected","recover",0);
  try {
    const result=await h.handlers.get("agent_before_settle")?.(boundary("ECONNRESET"),h.ctx);
    assert.equal(result,undefined);
    assert.equal(lines(h.callLog),0);
    assert.deepEqual(h.socketCommands,["status\n"]);
    assert.equal(lines(h.shadowLog),0);
  } finally {await h.shutdown();}
});

test("observe mode stays paused on confirmed proxy failure",async()=>{
  const h=await makeHarness("connected","observe",5);
  try {
    const result=await h.handlers.get("agent_before_settle")?.(boundary("Stream ended without finish_reason"),h.ctx);
    assert.equal(result,undefined);
    assert.equal(lines(h.callLog),2);
    assert.equal(lines(h.shadowLog),0);
    assert.ok(h.notices.some((x)=>x.includes("Observe-only mode")));
  } finally {await h.shutdown();}
});

test("a single post-failover success cannot resume Pi",async()=>{
  const h=await makeHarness("connected","recover",2,5);
  try {
    const result=await h.handlers.get("agent_before_settle")?.(boundary("ECONNRESET"),h.ctx);
    assert.equal(result,undefined);
    assert.equal(h.messages.length,0);
    assert.equal(lines(h.shadowLog),0);
    assert.ok(h.notices.some((x)=>x.includes("still down")));
  } finally {await h.shutdown();}
});

test("a broken chained path stays paused rather than cycling nodes",async()=>{
  const h=await makeHarness("connected","recover",100);
  try {
    const result=await h.handlers.get("agent_before_settle")?.(boundary("Stream ended without finish_reason"),h.ctx);
    assert.equal(result,undefined);
    assert.equal(h.messages.length,0);
    assert.equal(lines(h.shadowLog),0);
    assert.ok(h.socketCommands.length>0 && h.socketCommands.every((command)=>command==="status\n"));
    assert.ok(h.notices.some((x)=>x.includes("still down")));
  } finally {await h.shutdown();}
});

test("session shutdown prevents a stale recovery continuation",async()=>{
  const h=await makeHarness("connected","recover",2,0,100);
  try {
    const pending=h.handlers.get("agent_before_settle")?.(boundary("ECONNRESET"),h.ctx);
    await new Promise((resolve)=>setTimeout(resolve,30));
    await h.handlers.get("session_shutdown")?.();
    assert.equal(await pending,undefined);
    assert.equal(h.messages.length,0);
    assert.equal(lines(h.shadowLog),0);
  } finally {await h.shutdown();}
});

test("recover waits for watcher, verifies deep path and then continues",async()=>{
  const h=await makeHarness("connected","recover",2);
  try {
    const result=await h.handlers.get("agent_before_settle")?.(boundary("Retry failed after 5 attempts"),h.ctx);
    assert.equal(result?.continue,true);
    assert.equal(result?.entries?.[0]?.type,"custom_message");
    assert.ok(lines(h.callLog)>=4);
    assert.equal(lines(h.shadowLog),0);
    assert.ok(h.socketCommands.every((command)=>command==="status\n"));
    assert.equal(h.messages.length,0);
  } finally {await h.shutdown();}
});
