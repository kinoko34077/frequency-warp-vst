/** Scoped, strictly whitelisted CSS rules for the opt-in Frequency Warp layout editor. */
export const STORAGE_KEY = 'frequency-warp:layout-editor:v1';
const lengths=new Set(['width','height','padding','margin','gap','border-radius','font-size']);
const supported=new Set([...lengths,'background-color','color','order']);
export function sanitizeRule(property,input){
  if(!supported.has(property))return null;
  const s=String(input??'').trim();
  if(!s)return null;
  if(property==='order'){const n=Number(s);return Number.isSafeInteger(n)&&n>=-999&&n<=999?String(n):null;}
  if(property==='color'||property==='background-color')return /^#[a-f0-9]{6}$/i.test(s)?s.toLowerCase():null;
  const match=/^(\d+(?:\.\d{1,2})?)(px|%)$/.exec(s);
  return match&&Number(match[1])<=3000?s:null;
}
export function normalizeChanges(obj){
  const state={version:1,global:{},mobile:{}};
  if(!obj||obj.version!==1)return state;
  for(const scope of ['global','mobile']){
    const rules=obj[scope];
    if(!rules||typeof rules!=='object'||Array.isArray(rules))continue;
    for(const [selector,raw] of Object.entries(rules)){
      if(typeof selector!=='string'||selector.length>350||/[{};@\n\r]/.test(selector)||selector.includes('/*')||!raw||typeof raw!=='object'||Array.isArray(raw))continue;
      const next={};
      for(const [prop,value] of Object.entries(raw)){const safe=sanitizeRule(prop,value);if(safe!==null)next[prop]=safe;}
      if(Object.keys(next).length)state[scope][selector]=next;
    }
  }
  return state;
}
export function cssForChanges(input){
  const changes=normalizeChanges(input);
  const render=scope=>Object.entries(changes[scope]).map(([selector,style])=>selector+' {\n'+Object.entries(style).map(([p,v])=>'  '+p+': '+v+' !important;').join('\n')+'\n}').join('\n\n');
  const g=render('global'),m=render('mobile');
  return [g,m&&'@media(max-width:800px){\n'+m+'\n}'].filter(Boolean).join('\n\n');
}
export function moveSibling(items,current,direction){
  if(![-1,1].includes(direction))return null;
  const i=items.indexOf(current),j=i+direction;
  if(i<0||j<0||j>=items.length)return null;
  const result=[...items];[result[i],result[j]]=[result[j],result[i]];return result;
}