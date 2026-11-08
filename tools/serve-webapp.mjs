import {createServer} from 'node:http';
import {readFile,stat} from 'node:fs/promises';
import {resolve,join,extname,sep} from 'node:path';
const root=resolve(process.argv[2]??'dist-web');
const mime={'.html':'text/html; charset=utf-8','.js':'text/javascript; charset=utf-8','.mjs':'text/javascript; charset=utf-8','.css':'text/css; charset=utf-8'};
createServer(async(request,response)=>{
  try{
    const pathname=decodeURIComponent(new URL(request.url,'http://localhost').pathname);
    const file=resolve(root,'.'+pathname.replace(/\/$/,'/index.html'));
    if(file!==root&&!file.startsWith(root+sep))throw new Error('Forbidden');
    const info=await stat(file);
    if(!info.isFile())throw new Error('Not found');
    response.writeHead(200,{'Content-Type':mime[extname(file)]??'application/octet-stream'});
    response.end(await readFile(file));
  }catch{response.writeHead(404);response.end('Not found');}
}).listen(4173,'127.0.0.1',()=>console.log('Web test: http://127.0.0.1:4173/'));
