import { timingSafeEqual } from 'node:crypto';
import { digest,stmt,now } from './core.ts';

export async function loggedIn(request:Request,env:Env) {
 const token=/(?:^|;\s*)bh_session=([a-f0-9]{64})(?:;|$)/.exec(request.headers.get('cookie')||'')?.[1];
 return token ? Boolean(await stmt(env,'SELECT hash FROM sessions WHERE hash=? AND expires>? AND generation=?',await digest(token),now(),await digest(env.APP_PASSWORD)).first()) : false;
}
export async function login(request:Request,env:Env,password:unknown) {
 if (!env.APP_PASSWORD||env.APP_PASSWORD.length<16) return {status:503,error:'ログインの設定を確認してください。'};
 const address=await digest(request.headers.get('CF-Connecting-IP')||'local');
 const count=await stmt(env,`INSERT INTO login_limits(address,count,reset_at) VALUES(?,1,?)
 ON CONFLICT(address) DO UPDATE SET count=CASE WHEN reset_at>? THEN count+1 ELSE 1 END,
 reset_at=CASE WHEN reset_at>? THEN reset_at ELSE excluded.reset_at END RETURNING count`,address,now()+900000,now(),now()).first<{count:number}>();
 if ((count?.count||0)>8) return {status:429,error:'少し待ってからお試しください。'};
 const [a,b]=await Promise.all([digest(typeof password==='string'?password.slice(0,1000):''),digest(env.APP_PASSWORD)]);
 if(!timingSafeEqual(new TextEncoder().encode(a),new TextEncoder().encode(b))) return {status:401,error:'パスワードを確認してください。'};
 const token=Array.from(crypto.getRandomValues(new Uint8Array(32))).map(n=>n.toString(16).padStart(2,'0')).join('');
 await env.DB.batch([stmt(env,'DELETE FROM login_limits WHERE address=?',address),stmt(env,'DELETE FROM sessions WHERE expires<=?',now()),stmt(env,'INSERT INTO sessions(hash,expires,generation) VALUES(?,?,?)',await digest(token),now()+604800000,b)]);
 return {status:200,cookie:`bh_session=${token}; Path=/; HttpOnly; SameSite=Strict; Max-Age=604800${new URL(env.APP_ORIGIN).protocol==='https:'?'; Secure':''}`};
}
export async function logout(request:Request,env:Env) {
 const token=/(?:^|;\s*)bh_session=([a-f0-9]{64})/.exec(request.headers.get('cookie')||'')?.[1];
 if(token) await stmt(env,'DELETE FROM sessions WHERE hash=?',await digest(token)).run();
 return `bh_session=; Path=/; HttpOnly; SameSite=Strict; Max-Age=0${env.APP_ORIGIN.startsWith('https:')?'; Secure':''}`;
}
