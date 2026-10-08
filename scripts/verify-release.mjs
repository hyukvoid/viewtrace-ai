/** Installed-tarball boundary tests. Runtime package never imports workspace/dev dependencies. */
import assert from 'node:assert/strict';
import {spawn} from 'node:child_process';
import {mkdtemp,readFile,writeFile,mkdir,stat,readdir,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join,resolve,dirname} from 'node:path';
import {fileURLToPath} from 'node:url';
import {createHash} from 'node:crypto';
import {chromium} from '@playwright/test';
const repo=resolve(dirname(fileURLToPath(import.meta.url)),'..');
const scratch=await mkdtemp(join(tmpdir(),'viewtrace RC 한글 공백 '));
const install=join(scratch,'clean install'),data=join(scratch,'자료 data');
const npm=process.env.npm_execpath;
assert.ok(npm,'invoke this gate with npm run verify:release');
const execute=(file,args,options={})=>new Promise((done,reject)=>{
 const child=spawn(file,args,{cwd:options.cwd??repo,env:{...process.env,...options.env},stdio:['ignore','pipe','pipe'],windowsHide:true,windowsVerbatimArguments:options.verbatim});
 let stdout='',stderr='';const timer=setTimeout(()=>child.kill('SIGKILL'),options.timeout??120000);
 child.stdout.on('data',c=>stdout+=c);child.stderr.on('data',c=>stderr+=c);
 child.on('error',reject);child.on('close',code=>{clearTimeout(timer);done({code,stdout,stderr})});
});
let cli,browser;
const run=(args,options)=>execute(process.execPath,[cli,...args],options);
const ok=async(args,options)=>{const r=await run(args,options);assert.equal(r.code,0,r.stderr+'\n'+r.stdout);return r.stdout};
try{
 const packed=await execute(process.execPath,[npm,'pack','--ignore-scripts','--json','--pack-destination',scratch]);
 assert.equal(packed.code,0,packed.stderr);
 const pack=JSON.parse(packed.stdout)[0];
 const filenames=pack.files.map(f=>f.path);
 for(const p of ['LICENSE','README.md','SECURITY.md','dist/src/viewtrace/cli.js','dist/src/viewtrace/native.js','dist/src/viewtrace/hooks.js','ui/viewtrace/app.js','ui/viewtrace/index.html'])assert.ok(filenames.includes(p),`missing packed asset ${p}`);
 assert.ok(filenames.every(p=>!/(^|\/)(?:docs\/milestones|\.team-harness|_outputs|\.env|auth\.json|credentials\.json|test\/)/.test(p)),'local/private/test artifacts must not ship');
 const tarball=join(scratch,pack.filename);
 const installed=await execute(process.execPath,[npm,'install','--offline','--ignore-scripts','--omit=dev','--no-audit','--no-fund','--prefix',install,tarball],{cwd:scratch});
 assert.equal(installed.code,0,installed.stderr);
 const packageRoot=join(install,'node_modules/agent-pigeon');cli=join(packageRoot,'dist/src/viewtrace/cli.js');
 const pkg=JSON.parse(await readFile(join(packageRoot,'package.json'),'utf8'));
 assert.deepEqual(pkg.dependencies??{},{});assert.equal(pkg.license,'MIT');
 assert.equal((await ok(['--version'])).trim(),pkg.version);assert.match(await ok(['--help']),/ViewTrace AI/);
 const legacy=await execute(process.execPath,[join(packageRoot,'dist/src/cli.js'),'--help']);assert.equal(legacy.code,0,legacy.stderr);
 // Exercise npm's installed executable shim as well as its JS entrypoint.
 const bin=join(install,'node_modules/.bin',process.platform==='win32'?'viewtrace.cmd':'viewtrace');
 const binVersion=process.platform==='win32'?await execute(process.env.ComSpec??'cmd.exe',['/d','/s','/c',`""${bin}" --version"`],{verbatim:true}):await execute(bin,['--version']);
 assert.equal(binVersion.code,0,binVersion.stderr);assert.equal(binVersion.stdout.trim(),pkg.version);
 const adapter=JSON.parse(await ok(['adapters','--json']));assert.equal(adapter.find(a=>a.adapterId==='codex').exactAssociation,'PARTIAL');
 const ready=join(scratch,'producer-ready.json');
 const producer=join(scratch,'producer 한글 공백.mjs');
 await writeFile(producer,`import {writeFileSync} from 'node:fs';import {spawn} from 'node:child_process';
const argv=process.argv.slice(2);const hold=argv[0]==='--hold';
if(!hold && JSON.stringify(argv)!==process.env.VIEWTRACE_RC_ARGV)process.exit(12);
const runId=process.env.VIEWTRACE_RUN_ID,at=new Date().toISOString();const send=o=>console.log(JSON.stringify({schemaVersion:1,runId,occurredAt:at,adapterId:'viewtrace-reference-jsonl',adapterVersion:'1.2.0',...o}));
send({recordKind:'run',lifecycle:'RUNNING'});
send({recordKind:'event',eventId:'real-argv',type:'SEARCH',origin:{producer:'release-launcher'},source:{sourceId:'argv-source',kind:'TOOL_RESULT'},provenance:{category:'VIEWTRACE_OBSERVED',observed:{toolCallId:'argv-call'}},payload:{type:'SEARCH',query:argv.join(' | '),results:[]}});
if(hold){const descendant=spawn(process.execPath,['-e',"process.on('SIGINT',()=>{});setInterval(()=>{},1000)"],{stdio:'ignore'});process.on('SIGINT',()=>{});writeFileSync(${JSON.stringify(ready)},JSON.stringify({pid:process.pid,descendantPid:descendant.pid}));setInterval(()=>{},1000)}
else{send({recordKind:'answer',receiptVersion:1,receiptId:'rc-receipt-'+runId,agentId:'reference',agentSessionId:'rc-session',turnId:runId,answerId:'rc-answer',answer:'Public RC answer',hashVersion:'sha256-sanitized-nfc-lf-v1',answerHash:'${createHash('sha256').update('Public RC answer').digest('hex')}',final:true,timestamp:at,eventIds:['real-argv']})}
`);
 await ok(['up','--data-root',data,'--report-port','0','--json']);
 const argv=['space argument','한글 경로','literal & pipe | caret ^','quote "inside"','trailing\\','%VIEWTRACE_RC_EXPANSION%','bang !'];
 const normal=JSON.parse((await ok(['run','--data-root',data,'--json','--',process.execPath,producer,...argv],{env:{VIEWTRACE_RC_ARGV:JSON.stringify(argv),VIEWTRACE_RC_EXPANSION:'MUST_NOT_EXPAND'}})).trim().split('\n').at(-1));
 assert.equal(normal.completeness,'COMPLETE');assert.equal(normal.eventsAccepted,1);
 if(process.platform==='win32'){
  const cmd=join(scratch,'producer 한글 공백.cmd');await writeFile(cmd,`@"${process.execPath}" "${producer}" %*\r\n`);
  const safeArgv=argv.slice(0,5);
  const r=await ok(['run','--data-root',data,'--json','--',cmd,...safeArgv],{env:{VIEWTRACE_RC_ARGV:JSON.stringify(safeArgv)}});
  assert.equal(JSON.parse(r.trim().split('\n').at(-1)).completeness,'COMPLETE');
  const blocked=await run(['run','--data-root',data,'--',cmd,...argv]);assert.equal(blocked.code,2);assert.match(blocked.stderr,/unsupported/);
 }
 // Real native fixtures through the installed public CLI; originals stay byte-identical.
 for(const [id,file,version] of [['codex','codex-normal.jsonl','0.160.1'],['claude-code','claude-normal-user.jsonl','2.1.121']]){
  const input=join(repo,'fixtures/viewtrace/native',file),before=await readFile(input);
  const out=JSON.parse(await ok(['ingest',input,'--adapter',id,'--agent-version',version,'--run-id',`run-rc-${id}`,'--data-root',data,'--json']));
  assert.equal(out.runs[0].eventsAccepted,4);assert.ok(out.replayChecks.every(c=>c.verified));assert.deepEqual(await readFile(input),before);
 }
 const replay=JSON.parse(await ok(['replay','run-rc-claude-code','--data-root',data,'--json']));
 const receipt=replay.records.map(r=>r.record).find(r=>r.recordKind==='answer');assert.ok(receipt);assert.equal(receipt.turnId,undefined);
 const exact=JSON.parse(await ok(['--receipt',receipt.receiptId,'--data-root',data,'--json']));assert.equal(exact.resolution.status,'matched');
 const picker=JSON.parse(await ok(['--agent','claude-code','--session',receipt.agentSessionId,'--data-root',data,'--json']));assert.equal(picker.resolution.status,'uncertain');assert.equal(new URL(picker.url).pathname,'/');
 const analysis=JSON.parse(await ok(['analyze',receipt.runId,'--answer',receipt.answerId,'--data-root',data,'--json']));assert.equal(analysis.inputRevision.recordCount,4);
 browser=await chromium.launch();const page=await browser.newPage();const errors=[];const external=[];
 page.on('pageerror',e=>errors.push(e.message));page.on('request',r=>{const u=new URL(r.url());if(u.protocol.startsWith('http')&&u.hostname!=='127.0.0.1')external.push(u.origin)});
 await page.goto(exact.url);await page.locator('#answer-summary').waitFor({state:'visible'});await page.locator('#raw-events article').first().waitFor({state:'visible'});
 assert.equal(await page.locator('#raw-events article').count(),4);assert.deepEqual(errors,[]);assert.deepEqual(external,[]);
 await page.goto(picker.url);await page.getByRole('heading',{name:'Choose a saved answer or trace'}).waitFor();
 // Installed project opt-in creates/removes only its own files; agent config is byte-identical.
 const project=join(scratch,'project 한글 공백');await mkdir(join(project,'.claude'),{recursive:true});const original='{"permissions":{"allow":[]}}\r\n';await writeFile(join(project,'.claude/settings.local.json'),original);
 await ok(['capture','install','--adapter','claude-code','--project',project,'--data-root',data]);
 await ok(['capture','uninstall','--adapter','claude-code','--project',project]);assert.equal(await readFile(join(project,'.claude/settings.local.json'),'utf8'),original);
 // Actual terminal CTRL_C_EVENT/PTY Ctrl+C, child cancellation and cleanup.
 const control=process.platform==='win32'?await execute('powershell.exe',['-NoProfile','-ExecutionPolicy','Bypass','-File',join(repo,'scripts/verify-windows-console.ps1'),'-Node',process.execPath,'-Cli',cli,'-DataRoot',data,'-Producer',producer,'-Ready',ready],{timeout:80000}):
  await execute('python3',[join(repo,'scripts/verify-posix-console.py'),process.execPath,cli,data,producer,ready],{timeout:80000});
 assert.equal(control.code,0,control.stderr+'\n'+control.stdout);assert.match(control.stdout,/"consoleCtrlC"\s*:\s*true/);assert.match(control.stdout,/"lifecycle":"CANCELLED"/);
 const cancelled=JSON.parse(await readFile(ready,'utf8'));
 for(const pid of [cancelled.pid,cancelled.descendantPid]){
  // A terminated orphan may briefly remain a zombie until the OS reaps it.
  let gone=false;
  for(let attempt=0;attempt<50;attempt++){
   try{process.kill(pid,0)}catch{gone=true;break}
   await new Promise(r=>setTimeout(r,100));
  }
  assert.ok(gone,'cancelled producer and descendant must be gone');
 }
 const info=JSON.parse(await readFile(join(data,'service.json'),'utf8'));
 const mutation=async(path,body)=>{const r=await fetch(`http://127.0.0.1:${info.reportPort}${path}`,{method:'POST',headers:{'Authorization':`Bearer ${info.reportToken}`,'Content-Type':'application/json'},body:JSON.stringify(body)});assert.equal(r.status,200);return r.json()};
 await mutation(`/api/runs/${receipt.runId}/keep`,{keep:true});
 await ok(['keep','run-rc-codex','--data-root',data]);
 await ok(['prune','--before','2099-01-01T00:00:00Z','--data-root',data]);assert.equal(JSON.parse(await ok(['--receipt',receipt.receiptId,'--data-root',data,'--json'])).resolution.status,'matched');
 await ok(['delete',receipt.runId,'--data-root',data]);assert.notEqual(JSON.parse(await ok(['--receipt',receipt.receiptId,'--data-root',data,'--json'])).resolution.status,'matched');
 if(process.platform!=='win32'){
  for(const name of ['viewtrace.db','service.json'])assert.equal((await stat(join(data,name))).mode&0o777,0o600);
  assert.equal((await stat(data)).mode&0o777,0o700);
  const denied=join(scratch,'denied');await mkdir(denied,{mode:0o500});const fail=await run(['ingest',join(repo,'fixtures/viewtrace/research-normal.jsonl'),'--data-root',denied]);assert.equal(fail.code,1,'filesystem denial must fail honestly');
 }else{
  const acl=await execute('icacls.exe',[data]);assert.equal(acl.code,0,acl.stderr);assert.ok(!/Everyone:\([^)]*F\)/i.test(acl.stdout),'do not grant Everyone full control');
  const winPaths=JSON.parse(await ok(['replay','run-rc-codex','--data-root',data.toUpperCase(),'--json']));assert.equal(winPaths.run.runId,'run-rc-codex','Windows drive/path case must resolve consistently');
  const filesystem=await execute('powershell.exe',['-NoProfile','-ExecutionPolicy','Bypass','-File',join(repo,'scripts/verify-windows-filesystem.ps1'),'-Node',process.execPath,'-Cli',cli,'-Scratch',scratch,'-Fixture',join(repo,'fixtures/viewtrace/research-normal.jsonl')]);
  assert.equal(filesystem.code,0,filesystem.stderr+'\n'+filesystem.stdout);assert.match(filesystem.stdout,/"actualUncHistoryRead":true/);
 }
 await ok(['down','--data-root',data]);assert.equal((await run(['status','--data-root',data])).code,1);
 console.log(JSON.stringify({releaseGate:'PASS',platform:process.platform,arch:process.arch,node:process.version,package:pkg.name,version:pkg.version,runtimeDependencies:0,packedAssets:filenames.length,cleanOfflineInstall:true,nativeFixtureReplay:true,installedBrowser:true,externalBrowserRequests:0,realConsoleCtrlC:true,processTreeCleanup:true,argv:true,permissions:true}));
}finally{
 await browser?.close();if(cli)await run(['down','--data-root',data]).catch(()=>{});
 await rm(scratch,{recursive:true,force:true});
}
