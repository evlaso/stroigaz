// Three flat contour colours, classified by surface light and floor depth.
const dot=(a,b)=>a.reduce((s,v,i)=>s+v*b[i],0);
const sub=(a,b)=>a.map((v,i)=>v-b[i]);
const cross=(a,b)=>[a[1]*b[2]-a[2]*b[1],a[2]*b[0]-a[0]*b[2],a[0]*b[1]-a[1]*b[0]];
const clamp=v=>Math.max(0,Math.min(1,v));
const pointKey=p=>p.map(v=>v.toFixed(4)).join(',');
const edgeKey=(a,b)=>[pointKey(a),pointKey(b)].sort().join('|');
const light=[-.68,.15,.72];
const rgb=v=>v<.2?'#075730':v<.42?'#84CBA5':'#F1FAF4';
export function contourAmount(point,diffuse,range,toward){
 const floor=[toward[0],toward[1],0];
 const depth=clamp((dot(point,floor)-range[0])/(range[1]-range[0]||1));
 return (.13+.87*clamp(diffuse))*(.25+.75*depth**.7);
}
export function makeContourLighting(edges,surfaces,toward){
 const adjacent=new Map(),cache=new Map();
 const depths=edges.flatMap(({a,b})=>[a,b]).map(p=>p[0]*toward[0]+p[1]*toward[1]);
 const range=[Math.min(...depths),Math.max(...depths)];
 for(const {pts} of surfaces){
  let n=cross(sub(pts[1],pts[0]),sub(pts[2],pts[0]));
  const length=Math.hypot(...n);if(length<1e-8)continue;
  n=n.map(v=>v/length);
  // Never turn a rear face toward the camera just to light its outline.
  if(dot(n,toward)<-1e-6)continue;
  for(let i=0;i<pts.length;i++){
   const id=edgeKey(pts[i],pts[(i+1)%pts.length]);
   if(!adjacent.has(id))adjacent.set(id,[]);
   adjacent.get(id).push(n);
  }
 }
 const diffuseFor=(a,b)=>{
  const normals=adjacent.get(edgeKey(a,b))||[];
  return normals.length?normals.reduce((s,n)=>s+Math.max(0,dot(n,light)),0)/normals.length:.35;
 };
 return {
  style(a,b){
   const key=edgeKey(a,b);if(cache.has(key))return cache.get(key);
   const midpoint=a.map((v,i)=>(v+b[i])/2);
   const colour=rgb(contourAmount(midpoint,diffuseFor(a,b),range,toward));
   const style=`stroke="${colour}" stroke-width="2.5"`;
   cache.set(key,style);return style;
  },
  definitions(){return '';}
 };
}
