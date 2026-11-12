// Windows-native HTTPS for this Studio endpoint when Node's network path fails.
// Request/response bodies stay on pipes; never log them or export wallet keys.
const {spawn}=require('node:child_process');
const original=globalThis.fetch;
const script=String.raw`
$ErrorActionPreference='Stop'
try {
 $inputData=[Console]::In.ReadToEnd() | ConvertFrom-Json
 $request=[System.Net.HttpWebRequest]::Create($inputData.url)
 $request.Method=$inputData.method
 $request.Timeout=20000
 $request.ReadWriteTimeout=20000
 foreach($header in $inputData.headers.PSObject.Properties) {
  if($header.Name -eq 'content-type') {$request.ContentType=[string]$header.Value}
  elseif($header.Name -eq 'accept') {$request.Accept=[string]$header.Value}
  elseif($header.Name -eq 'user-agent') {$request.UserAgent=[string]$header.Value}
  else {$request.Headers[$header.Name]=[string]$header.Value}
 }
 if($inputData.body) {
  $bytes=[Convert]::FromBase64String($inputData.body)
  $request.ContentLength=$bytes.Length
  $stream=$request.GetRequestStream();$stream.Write($bytes,0,$bytes.Length);$stream.Dispose()
 }
 try {$response=$request.GetResponse()}
 catch [System.Net.WebException] {if(!$_.Exception.Response){throw};$response=$_.Exception.Response}
 $memory=New-Object System.IO.MemoryStream
 $response.GetResponseStream().CopyTo($memory)
 $result=@{status=[int]$response.StatusCode;body=[Convert]::ToBase64String($memory.ToArray());content_type=$response.ContentType}
 $response.Dispose();$memory.Dispose()
 [Console]::Out.Write(($result | ConvertTo-Json -Compress))
} catch {[Console]::Error.Write('Native HTTPS failed; inspect history before retrying a write');exit 1}
`;
globalThis.fetch=async(input,options={})=>{
 const url=new URL(typeof input==='string'||input instanceof URL?String(input):input.url);
 const studio=url.origin==='https://studio.genlayer.com'&&url.pathname==='/api';
 if(!studio)return original(input,options);
 const method=(options.method||'GET').toUpperCase();
 if(method!=='POST')throw Error('Unexpected native HTTP method');
 return new Promise((resolve,reject)=>{
  const child=spawn('powershell.exe',['-NoProfile','-NonInteractive','-EncodedCommand',Buffer.from(script,'utf16le').toString('base64')],{windowsHide:true,stdio:['pipe','pipe','pipe']});
  const chunks=[];let size=0,done=false;
  const finish=(error,value)=>{if(done)return;done=true;clearTimeout(timer);options.signal?.removeEventListener('abort',abort);error?reject(error):resolve(value);};
  const abort=()=>{child.kill();finish(Error('Native HTTPS aborted; inspect write history'));};
  const timer=setTimeout(abort,30000);options.signal?.addEventListener('abort',abort,{once:true});
  child.stderr.resume();child.on('error',()=>finish(Error('Native HTTPS launch failed')));
  child.stdout.on('data',data=>{size+=data.length;if(size>64*1024*1024)return abort();chunks.push(data);});
  child.on('close',code=>{if(code!==0)return finish(Error('Native HTTPS failed; inspect write history'));
   try{const p=JSON.parse(Buffer.concat(chunks).toString('utf8'));finish(null,new Response(Buffer.from(p.body,'base64'),{status:p.status,headers:{'content-type':p.content_type||'application/json'}}));}
   catch{finish(Error('Native HTTPS response unavailable; inspect write history'));}
  });
  child.stdin.on('error',()=>finish(Error('Native HTTPS input failed')));
  if(options.signal?.aborted)return abort();
  child.stdin.end(JSON.stringify({url:url.href,method,headers:Object.fromEntries(new Headers(options.headers)),body:options.body?Buffer.from(options.body).toString('base64'):''}));
 });
};
