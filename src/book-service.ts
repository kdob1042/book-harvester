import {WorkerEntrypoint} from 'cloudflare:workers';
import {callBook} from './book-operations.ts';
export class BookService extends WorkerEntrypoint<Env> {call(name:string,args:Record<string,unknown>){return callBook(this.env,this.ctx,name,args);}}
