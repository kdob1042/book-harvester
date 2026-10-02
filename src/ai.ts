// One cancellation boundary covers all provider entry points, including ingestion.
import * as provider from './ai-provider.ts';
import {cancellableAI} from './ai-cancellation.ts';
export {AiError} from './ai-provider.ts';
export function call(...args:Parameters<typeof provider.call>){
 const [env,captureId,endpoint,model,payload,fetcher=fetch]=args;
 return cancellableAI(env,fetcher,f=>provider.call(env,captureId,endpoint,model,payload,f));
}
export function harvest(...args:Parameters<typeof provider.harvest>){
 const [env,capture,assets,transcript,fetcher=fetch]=args;
 return cancellableAI(env,fetcher,f=>provider.harvest(env,capture,assets,transcript,f));
}
export function transcribe(...args:Parameters<typeof provider.transcribe>){
 const [env,capture,asset,fetcher=fetch]=args;
 return cancellableAI(env,fetcher,f=>provider.transcribe(env,capture,asset,f));
}
export function answer(...args:Parameters<typeof provider.answer>){
 const [env,capture,harvest,question,fetcher=fetch]=args;
 return cancellableAI(env,fetcher,f=>provider.answer(env,capture,harvest,question,f));
}
