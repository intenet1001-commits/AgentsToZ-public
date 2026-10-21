/** New Supabase API keys are not JWTs. Preserve legacy bearer compatibility only for old keys. */
export function supabaseApiKeyHeaders(key:string):Record<string,string>{
  return {apikey:key,...(/^(?:sb_publishable_|sb_secret_)/.test(key)?{}:{Authorization:'Bearer '+key})};
}
