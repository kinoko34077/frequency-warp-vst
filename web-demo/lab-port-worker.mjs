import {renderPCM} from './lab-model/lab-dsp.mjs';
self.onmessage=({data})=>{
 try{
  const {channels,sampleRate,sourceStartSeconds,options}=data;
  const started=performance.now();
  if(!channels?.length||channels.length>2||channels[0]?.length>sampleRate*1.51)
   throw RangeError('試聴上限は1.5秒・ステレオです');
  const result=renderPCM({channels,sampleRate,sourceStartSeconds,...options});
  self.postMessage({type:'done',channels:result.channels,
   duration:result.channels[0].length/sampleRate,elapsedMs:performance.now()-started},
   result.channels.map(ch=>ch.buffer));
 }catch(e){self.postMessage({type:'error',message:e.message||String(e)});}
};
