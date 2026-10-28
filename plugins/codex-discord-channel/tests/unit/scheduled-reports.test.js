
'use strict';
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');
const { sendDiscordReplyOnce, receiptPath } = require('../../src/reply-delivery');
const root = path.join(require('node:os').tmpdir(), 'cdc-scheduled-reports');
fs.mkdirSync(root, { recursive: true });
function fixture(t) {
  const dir = fs.mkdtempSync(path.join(root, 'case-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const config = { paths: { stateDir: dir, replyReceiptDir: path.join(dir, 'reply-receipts') } };
  fs.writeFileSync(path.join(dir, 'scheduled-reports.json'), JSON.stringify({version:1, reports:{hourly:{enabled:true,channelId:'c1',replyTo:'m1',intervalMinutes:60,startsAt:'2026-10-28T00:00:00.000Z'}}}));
  return config;
}
const slot = (hour) => ({ id:'hourly', occurrence:`2026-10-28T${hour}:00:00.000Z` });
let clock = Date.parse('2026-10-28T15:05:00.000Z');
const now = () => clock;
const args = (hour) => ({channelId:'c1',replyTo:'m1',scheduledReport:slot(hour)});
const confirm = async (_target,_prepared,sent) => sent;
test('ordinary source reply stays once-only while distinct scheduled hours each send once',async t=>{
 clock=Date.parse('2026-10-28T15:05:00.000Z');const config=fixture(t);const sent=[];const options={config,deps:{now},confirmer:confirm,sender:async(target,_prepared,nonce)=>{sent.push({target,nonce});return {channelId:target.channelId,messageId:`o${sent.length}`};}};
 await sendDiscordReplyOnce({...options,args:{channelId:'c1',replyTo:'m1'},content:'source reply'});
 const old=fs.readFileSync(receiptPath(config,'c1','m1'));
 const a=await sendDiscordReplyOnce({...options,args:args('15'),content:'hour15'});
 const duplicate=await sendDiscordReplyOnce({...options,args:args('15'),content:'changed retry must not post'});
 clock=Date.parse('2026-10-28T16:05:00.000Z');const b=await sendDiscordReplyOnce({...options,args:args('16'),content:'hour16'});
 const ordinary=await sendDiscordReplyOnce({...options,args:{channelId:'c1',replyTo:'m1'},content:'ordinary retry'});
 assert.equal(a.duplicateSuppressed,false);assert.equal(b.duplicateSuppressed,false);assert.equal(duplicate.messageId,a.messageId);assert.equal(ordinary.reason,'source_message_already_replied');
 assert.equal(sent.length,3);assert.equal(new Set(sent.map(x=>x.nonce.nonce)).size,3);assert(sent.every(x=>x.nonce.enforceNonce===true));
 assert.deepEqual(fs.readFileSync(receiptPath(config,'c1','m1')),old);
 assert(sent.every(x=>x.target.replyTo==='m1'));
});
test('concurrent duplicate scheduled occurrence posts once',async t=>{
 clock=Date.parse('2026-10-28T16:05:00.000Z');const config=fixture(t);let count=0;const options={args:args('16'),config,content:'same report',deps:{now},confirmer:confirm,sender:async()=>{count++;await new Promise(r=>setTimeout(r,10));return {channelId:'c1',messageId:'one'};}};
 const results=await Promise.all([sendDiscordReplyOnce(options),sendDiscordReplyOnce(options)]);
 assert.equal(count,1);assert.equal(results.filter(x=>x.duplicateSuppressed).length,1);
});
test('scheduled send keeps uncertainty and reconciles exact occurrence without another POST',async t=>{
 clock=Date.parse('2026-10-28T16:05:00.000Z');const config=fixture(t);let count=0;const options={args:args('16'),config,content:'hour16',deps:{now},sender:async()=>{count++;return {channelId:'c1',messageId:'existing'};}};
 await assert.rejects(sendDiscordReplyOnce({...options,confirmer:async()=>{throw new Error('readback failed');}}),/readback failed/);
 const retry=await sendDiscordReplyOnce({...options,confirmer:confirm,reconciler:async(_target,_prepared,receipt)=>{assert.equal(receipt.outboundMessageId,'existing');return {found:true,channelId:'c1',messageId:'existing'};}});
 assert.equal(count,1);assert.equal(retry.reconciled,true);
});
test('unknown schedule, wrong target, future or off-cadence occurrence and followup never POST',async t=>{
 clock=Date.parse('2026-10-28T16:05:00.000Z');const config=fixture(t);let count=0;const base={config,content:'x',deps:{now},confirmer:confirm,sender:async()=>{count++;throw new Error('must not send');}};
 for(const request of [{...args('16'),channelId:'other'},{...args('16'),replyTo:'other'},{...args('16'),scheduledReport:{...slot('16'),id:'unknown'}},args('17'),args('14'),{...args('16'),scheduledReport:{...slot('16'),occurrence:'2026-10-28T16:30:00.000Z'}},{...args('16'),followup:true}]) await assert.rejects(sendDiscordReplyOnce({...base,args:request}),/authorized|followup|stale/);
 fs.rmSync(path.join(config.paths.stateDir,'scheduled-reports.json'));
 await assert.rejects(sendDiscordReplyOnce({...base,args:args('16')}),/authority is unavailable/);
 assert.equal(count,0);
});

test('actual MCP send path retains exact parent bot body nonce readback for each report hour', async t => {
  const { callTool, toolList } = require('../../src/mcp-server');
  const config=fixture(t);const messages=new Map([['m1',{id:'m1',channelId:'c1'}]]);const posts=[];
  const channel={messages:{fetch:async id=>messages.get(id)},send:async payload=>{
    const message={id:`out${posts.length+1}`,channelId:'c1',content:payload.content,reference:{messageId:payload.reply.messageReference},nonce:payload.nonce,author:{id:'bot1'}};
    messages.set(message.id,message);posts.push(payload);return message;
  }};
  const context={config,discordState:{client:{user:{id:'bot1'},channels:{fetch:async()=>channel}}}};
  const realNow=Date.now;Date.now=()=>Date.parse('2026-10-28T16:05:00.000Z');t.after(()=>{Date.now=realNow;});
  const request={...args('16'),content:'actual MCP report'};
  const first=await callTool(context,'discord_channel_send',request);
  const duplicate=await callTool(context,'discord_channel_send',request);
  assert.equal(posts.length,1);assert.equal(first.structuredContent.duplicateSuppressed,false);assert.equal(duplicate.structuredContent.messageId,first.structuredContent.messageId);
  assert.equal(messages.get(first.structuredContent.messageId).reference.messageId,'m1');assert.equal(posts[0].enforceNonce,true);
  assert(toolList().find(x=>x.name==='discord_channel_send').inputSchema.properties.scheduledReport);
});
