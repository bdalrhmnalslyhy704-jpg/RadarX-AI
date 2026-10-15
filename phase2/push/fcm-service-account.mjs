function usableServiceAccount(value){
  return Boolean(value&&typeof value==='object'&&!Array.isArray(value)&&
    typeof value.client_email==='string'&&value.client_email.trim()&&
    typeof value.private_key==='string'&&value.private_key.trim());
}

export function parseFcmServiceAccount(value){
  if(usableServiceAccount(value))return value;
  const raw=String(value??'').trim();
  if(!raw)return null;
  const normalized=raw.replace(/^base64\\s*:/i,'').replace(/\\s+/g,'');
  const candidates=[raw];
  if(normalized&&normalized!==raw)candidates.push(normalized);
  if(normalized){
    try{
      const decoded=Buffer.from(normalized.replace(/-/g,'+').replace(/_/g,'/'),'base64').toString('utf8').replace(/^\\uFEFF/,'').trim();
      if(decoded&&decoded!==raw)candidates.push(decoded);
    }catch{}
  }
  for(const candidate of candidates){
    try{
      const parsed=JSON.parse(candidate);
      if(usableServiceAccount(parsed))return parsed;
    }catch{}
  }
  return null;
}
