// Keep successful and ambiguous requests deduplicated. Only a confirmed terminal
// failure/stop releases this attempt's key for the next explicitly approved try.
export function integrationActionKey(runId,mode,selectedIds) {
  return `integration:${runId}:${mode||''}:${selectedIds.slice().sort().join(',')}`;
}
export function createIntegrationAttempt(storage,storageKey) {
  let key=storage.getItem(storageKey);
  if(!key){key=crypto.randomUUID();storage.setItem(storageKey,key);}
  const retry={storageKey,key};
  return {key,retry,settle:outcome=>settleIntegrationAttempt(storage,retry,outcome)};
}
export function settleIntegrationAttempt(storage,retry,outcome) {
  if(!retry||!outcome)return false;
  const states=[outcome.state,outcome.ai_operation?.state];
  // A successfully committed result is never retried under a fresh identity.
  if(states.includes('completed'))return false;
  const confirmed=outcome.canceled===true||states.some(state=>['canceled','failed'].includes(state));
  if(!confirmed||storage.getItem(retry.storageKey)!==retry.key)return false;
  storage.removeItem(retry.storageKey);return true;
}
export const importExtractionLabel=job=>job.state==='canceled'?'抽出を再試行 · AI':job.error_code==='extraction_required'?'抽出する · AI':null;
