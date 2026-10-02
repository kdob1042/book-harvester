import {test} from 'node:test';
import assert from 'node:assert/strict';
import {allowedFileURL,downloadFile} from '../src/book-files.ts';
test('file inputs restrict hosts, redirects, size and stale URLs',async()=>{
 for(const url of ['http://files.oaiusercontent.com/f','https://files.oaiusercontent.com.evil.test/f','https://127.0.0.1/f','https://user:pass@files.oaiusercontent.com/f','https://files.oaiusercontent.com:8080/f'])assert.throws(()=>allowedFileURL(url));
 const file={file_id:'file_test_01',download_url:'https://files.oaiusercontent.com/authorized',mime_type:'text/plain',file_name:'hello.txt'};
 const result=await downloadFile(file,async()=>new Response('hello'));assert.equal(new TextDecoder().decode(result.bytes),'hello');
 await assert.rejects(downloadFile(file,async()=>new Response(null,{status:302,headers:{location:'http://localhost'}})),/redirect_rejected/);
 await assert.rejects(downloadFile(file,async()=>new Response(null,{status:403})),/file_url_expired/);
 await assert.rejects(downloadFile(file,async()=>new Response('x',{headers:{'content-length':String(11*1024*1024)}})),/file_too_large/);
});
