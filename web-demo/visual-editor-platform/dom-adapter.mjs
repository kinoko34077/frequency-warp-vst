import {EditError,assertSafeId,validateDocument} from './core.mjs';
/** Static DOM adapter: owns a stylesheet only; never detaches or clones controls. */
export function createDomStyleAdapter({root,styleElement,target,allowedIds=null,breakpoints={mobile:'(max-width: 800px)'}}){
  if(!root||!styleElement||!target)throw new EditError('BAD_ADAPTER');
  const permitted=new Set(allowedIds??[]);
  for(const key of Object.keys(breakpoints)){
    if(key!=='mobile'||typeof breakpoints[key]!=='string'||!/^\(max-width: [1-9]\d{1,3}px\)$/.test(breakpoints[key]))throw new EditError('BAD_BREAKPOINT');
  }
  function resolve(id){
    assertSafeId(id);
    if(allowedIds&&!permitted.has(id))throw new EditError('FORBIDDEN_NODE');
    const nodes=[root,...root.querySelectorAll('[data-ve-id]')].filter(node=>node?.getAttribute?.('data-ve-id')===id);
    if(nodes.length!==1)throw new EditError(nodes.length?'AMBIGUOUS_NODE':'MISSING_NODE');
    return nodes[0];
  }
  const cssAttr=id=>id.replace(/\\/g,'\\\\').replace(/"/g,'\\"');
  function safeOrder(node){
    if(!node.parentElement||typeof getComputedStyle!=='function'||!/flex|grid/.test(getComputedStyle(node.parentElement).display))return false;
    const unsafe='button,input,select,textarea,a,[tabindex],[contenteditable],[role="button"],canvas,iframe,video,audio';
    return [...node.parentElement.children].every(child=>!child.matches(unsafe)&&!child.querySelector(unsafe));
  }
  return {
    resolve,
    describe(id){
      const node=resolve(id);
      const capabilities=['inspect','style.safe'];
      if(safeOrder(node))capabilities.push('order.visual');
      return {identity:id,capabilities,element:node};
    },
    async applyState(candidate){
      const doc=validateDocument(candidate,target);
      let css='';
      for(const [id,scopes] of Object.entries(doc.nodes)){
        const node=resolve(id),selector='[data-ve-id="'+cssAttr(id)+'"]';
        for(const [bp,styles] of Object.entries(scopes)){
          if(Object.hasOwn(styles,'order')&&!safeOrder(node))throw new EditError('FORBIDDEN_CAPABILITY');
          const declaration=Object.entries(styles).map(([p,v])=>p+': '+v+' !important;').join('');
          if(!declaration)continue;
          css+=(bp==='base'?selector+'{'+declaration+'}':'@media '+breakpoints[bp]+'{'+selector+'{'+declaration+'}}')+'\n';
        }
      }
      // One paint update after complete validation; no app DOM structure is edited.
      styleElement.textContent=css;
    }
  };
}
