import {fail} from './core.ts';
export function questionContent(value:unknown):string|null {
 if(value===null)return null;
 if(typeof value!=='string'||value.length>10000)fail(400,'内容は10000文字以内で入力してください。');
 return value.trim()||null;
}
export function questionContext<T extends {id:string;version:number;question:string;content?:string|null}>(theme:T){return {...theme,content:theme.content??null};}
