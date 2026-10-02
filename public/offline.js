// Keep the durable offline store unchanged; add shared controls at its public boundary.
export * from './offline-core.js';
import {deviceRequest as storedRequest} from './offline-core.js';
import {requestWithAIControls} from './ai-controls.js';
export function deviceRequest(path,options={}){return requestWithAIControls(path,options,storedRequest);}
