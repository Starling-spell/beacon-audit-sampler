import fs from 'node:fs';
import crypto from 'node:crypto';
import dns from 'node:dns';
import assert from 'node:assert/strict';
import {abi} from 'genlayer-js';
dns.setDefaultResultOrder('ipv4first');
export const canonical=x=>x===null||typeof x!=='object'?JSON.stringify(x).replace(/[\u007f-\uffff]/g,c=>'\\u'+c.charCodeAt(0).toString(16).padStart(4,'0')):
 Array.isArray(x)?'['+x.map(canonical).join(',')+']':'{'+Object.keys(x).sort().map(k=>canonical(k)+':'+canonical(x[k])).join(',')+'}';
export const sha=x=>crypto.createHash('sha256').update(x).digest('hex');
export const digest=x=>sha(canonical(x));
export async function rpc(method,params){
 if(!['eth_chainId','eth_getTransactionByHash','gen_getContractCode','eth_getTransactionCount','sim_getTransactionsForAddress','gen_call'].includes(method))throw Error('Read-only RPC methods only');
 if(method==='gen_call'&&(params.length!==1||params[0]?.type!=='read'))throw Error('Only read-mode gen_call permitted');
 for(let attempt=0;attempt<3;attempt++)try{
  const r=await fetch('https://studio.genlayer.com/api',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({jsonrpc:'2.0',id:1,method,params}),signal:AbortSignal.timeout(20000)});
  if(!r.ok)throw Error('HTTP failure');const p=await r.json();
  if(p.error?.code===-32000&&p.error?.message==='execution failed'){
   const e=Error('Contract read reverted');e.code=-32000;e.details='execution failed';throw e;
  }
  if(p.error||p.result==null)throw Error('RPC failure');return p.result;
 }catch(e){if(e.code===-32000&&e.details==='execution failed')throw e;
  if(attempt===2)throw Error('Read-only RPC unavailable');await new Promise(r=>setTimeout(r,4000*(attempt+1)));}
}
export function jsonSafe(x){
 if(typeof x==='bigint'){if(x>BigInt(Number.MAX_SAFE_INTEGER)||x<BigInt(Number.MIN_SAFE_INTEGER))throw Error('Unsafe decoded integer');return Number(x);}
 if(x instanceof Map)return Object.fromEntries([...x].map(([k,v])=>[k,jsonSafe(v)]));
 if(Array.isArray(x))return x.map(jsonSafe);
 if(x&&typeof x==='object')return Object.fromEntries(Object.entries(x).map(([k,v])=>[k,jsonSafe(v)]));return x;
}
export async function read(address,functionName,args){
 // This Studio endpoint accepts raw calldata. Its long RLP-wrapped read path rejects >255-byte calls.
 // Encode with the pinned SDK but do not add the problematic RLP envelope. Never sign/send here.
 const data='0x'+Buffer.from(abi.calldata.encode(abi.calldata.makeCalldataObject(functionName,args,{}))).toString('hex');
 const result=await rpc('gen_call',[{type:'read',to:address,from:'0x'+'0'.repeat(40),data,transaction_hash_variant:'latest-nonfinal'}]);
 if(typeof result!=='string'||!/^(?:0x)?[0-9a-fA-F]*$/.test(result))throw Error('Unexpected read response');
 return jsonSafe(abi.calldata.decode(Uint8Array.from(Buffer.from(result.replace(/^0x/,''),'hex'))));
}
export async function receipt(hash,expected='SUCCESS',message,consensus='MAJORITY_AGREE'){
 let tx=await rpc('eth_getTransactionByHash',[hash]);
 const indexed=t=>t.status==='FINALIZED'&&t.result_name&&t.consensus_data?.leader_receipt?.some(x=>x.mode==='leader'&&x.execution_result);
 for(let i=0;!indexed(tx)&&i<30;i++){await new Promise(r=>setTimeout(r,4000));tx=await rpc('eth_getTransactionByHash',[hash]);}
 const leader=tx.consensus_data?.leader_receipt?.find(x=>x.mode==='leader');
 const raw=leader?.genvm_result?.stderr||leader?.result;
 const decoded=typeof raw!=='string'?'':(/^[A-Za-z0-9+/]*={0,2}$/.test(raw)&&raw.length%4===0?Buffer.from(raw,'base64').toString('utf8'):raw);
 const result={hash,address:tx.to_address??tx.to,status:tx.status,execution:leader?.execution_result,consensus:tx.result_name,
  ...(message?{expected_error_matched:decoded.includes(message)}:{})};
 if(consensus==='MAJORITY_DISAGREE'){
  const votes=Object.values(tx.consensus_data?.votes??{});
  if(expected!=='ERROR'||!message||tx.status!=='FINALIZED'||leader?.execution_result!=='ERROR'||tx.result_name!==consensus||!decoded.includes(message)||tx.leader_only!==false||!Number.isInteger(tx.num_of_initial_validators)||tx.num_of_initial_validators<3||votes.filter(x=>x==='disagree').length<2)throw Error('Failed-generation receipt unverified');
  return {...result,committed:false,leader_only:false,initial_validators:tx.num_of_initial_validators,agree_votes:votes.filter(x=>x==='agree').length,idle_votes:votes.filter(x=>x==='idle').length,disagree_votes:votes.filter(x=>x==='disagree').length,validator_execution_seen:tx.consensus_data.leader_receipt.some(x=>x.mode==='validator')};
 }
 if(tx.status==='FINALIZED'&&expected==='SUCCESS'&&leader?.execution_result==='SUCCESS'&&tx.result_name==='MAJORITY_DISAGREE')return {...result,committed:false};
 if(tx.status!=='FINALIZED'||leader?.execution_result!==expected||tx.result_name!=='MAJORITY_AGREE'||(message&&!decoded.includes(message)))throw Error('Receipt unverified');
 const votes=Object.values(tx.consensus_data?.votes??{}),agree=votes.filter(x=>x==='agree').length;
 if(tx.leader_only!==false||!Number.isInteger(tx.num_of_initial_validators)||tx.num_of_initial_validators<3||agree<2)throw Error('Independent voting metadata not established');
 return {...result,committed:expected==='SUCCESS',leader_only:false,initial_validators:tx.num_of_initial_validators,
  agree_votes:agree,idle_votes:votes.filter(x=>x==='idle').length,disagree_votes:votes.filter(x=>x==='disagree').length,
  validator_execution_seen:tx.consensus_data.leader_receipt.some(x=>x.mode==='validator')};
}
export async function source(address){
 const norm=x=>x.replace(/\r\n/g,'\n').trimEnd()+'\n';
 const actual=norm(Buffer.from(await rpc('gen_getContractCode',[address]),'base64').toString('utf8'));
 if(actual!==norm(fs.readFileSync('contracts/BeaconAuditSampler.py','utf8')))throw Error('Source mismatch');
 return {address,source_match:true,sha256:sha(actual)};
}
export async function denied(address,method,args){
 try{await read(address,method,args);return false;}catch(e){if(e.code===-32000&&e.details==='execution failed')return true;throw Error('Read failed without verified contract revert');}
}
