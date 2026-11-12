// Cache identical already-signed sends; never inspect/export wallet keys.
const {createHash}=require('node:crypto'),original=globalThis.fetch,sent=new Map();
globalThis.fetch=async(url,options)=>{
 let rpc;try{rpc=JSON.parse(options?.body??'{}');}catch{}
 const target=new URL(String(url));
 if(target.origin!=='https://studio.genlayer.com'||target.pathname!=='/api'||rpc?.method!=='eth_sendRawTransaction')return original(url,options);
 if(rpc.params?.length!==1||!/^0x[0-9a-fA-F]+$/.test(rpc.params[0]))throw Error('Invalid signed payload');
 const key=createHash('sha256').update(rpc.params[0]).digest('hex');
 if(!sent.has(key))sent.set(key,(async()=>{const response=await original(url,options),body=await response.text();
  let p;try{p=JSON.parse(body);}catch{throw Error('Broadcast uncertain; inspect history');}
  if(/^0x[0-9a-fA-F]{64}$/.test(p.result??''))console.error('BROADCAST_HASH '+p.result);
  return {body,status:response.status,headers:{'content-type':'application/json'}};
 })());
 const result=await sent.get(key);return new Response(result.body,{status:result.status,headers:result.headers});
};
