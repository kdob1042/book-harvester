// Pure policy: importing persistence helpers must not create a core/policy cycle.
export const automaticAI = (env: Pick<Env, 'AI_EXECUTION_POLICY'>) =>
  env.AI_EXECUTION_POLICY === 'automatic_legacy';
