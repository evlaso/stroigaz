// Exact painter order for convex metal surfaces. Split polygons at intervening
// planes instead of sorting their centres (which hides nearer curved parts).
const EPS=1e-6;
const sub=(a,b)=>a.map((v,i)=>v-b[i]);
const dot=(a,b)=>a.reduce((s,v,i)=>s+v*b[i],0);
const cross=(a,b)=>[a[1]*b[2]-a[2]*b[1],a[2]*b[0]-a[0]*b[2],a[0]*b[1]-a[1]*b[0]];
function plane(pts){
 for(let i=1;i<pts.length-1;i++){
  const n=cross(sub(pts[i],pts[0]),sub(pts[i+1],pts[0]));
  const l=Math.hypot(...n);if(l>EPS){const normal=n.map(v=>v/l);return {normal,w:dot(normal,pts[0])};}
 }
 return null;
}
function sides(poly,p){
 const ds=poly.pts.map(v=>dot(p.normal,v)-p.w);
 return {ds,front:ds.some(d=>d>EPS),back:ds.some(d=>d< -EPS)};
}
function split(poly,p){
 const {ds,front,back}=sides(poly,p);
 if(!front&&!back)return {same:poly};
 if(!back)return {front:poly};
 if(!front)return {back:poly};
 const f=[],b=[];
 for(let i=0;i<poly.pts.length;i++){
  const j=(i+1)%poly.pts.length,a=poly.pts[i],next=poly.pts[j];
  if(ds[i]>=-EPS)f.push(a);if(ds[i]<=EPS)b.push(a);
  if(ds[i]*ds[j]<0&&Math.abs(ds[i])>EPS&&Math.abs(ds[j])>EPS){
   const t=ds[i]/(ds[i]-ds[j]),v=a.map((x,k)=>x+t*(next[k]-x));f.push(v);b.push(v);
  }
 }
 return {front:{...poly,pts:f},back:{...poly,pts:b}};
}
export function orderSurfaces(surfaces,toward){
 const polys=surfaces.map((s,i)=>({...s,source:i,plane:plane(s.pts)})).filter(s=>s.plane);
 const result=[];
 function visit(items,depth=0){
  if(!items.length)return;
  if(depth>512)throw new Error('Surface ordering exceeded BSP depth');
  let best=items[0].plane,score=Infinity;
  for(let i=0;i<items.length;i+=Math.max(1,Math.floor(items.length/16))){
   const p=items[i].plane;let front=0,back=0,cuts=0;
   for(const poly of items){const s=sides(poly,p);if(s.front)front++;if(s.back)back++;if(s.front&&s.back)cuts++;}
   const cost=cuts*4+Math.abs(front-back)*.25;
   if(cost<score){score=cost;best=p;}
  }
  const front=[],back=[],same=[];
  for(const poly of items){
   const s=split(poly,best);
   if(s.same)same.push(s.same);
   if(s.front&&plane(s.front.pts))front.push(s.front);
   if(s.back&&plane(s.back.pts))back.push(s.back);
  }
  const frontNear=dot(best.normal,toward)>=0;
  visit(frontNear?back:front,depth+1);result.push(...same);visit(frontNear?front:back,depth+1);
 }
 visit(polys);
 return result;
}
// Check that the last painted fragment at each sampled surface point is the
// nearest physical surface along the camera ray, including cylinder facets.
export function auditSurfaceOrder(original,ordered,toward){
 function hit(poly,origin){
  const p=plane(poly.pts);if(!p)return null;
  const denom=dot(p.normal,toward);if(Math.abs(denom)<EPS)return null;
  const t=(p.w-dot(p.normal,origin))/denom;
  const q=origin.map((v,i)=>v+t*toward[i]);let plus=false,minus=false;
  for(let i=0;i<poly.pts.length;i++){
   const d=dot(cross(sub(poly.pts[(i+1)%poly.pts.length],poly.pts[i]),sub(q,poly.pts[i])),p.normal);
   if(d>EPS)plus=true;if(d< -EPS)minus=true;
   if(plus&&minus)return null;
  }
  return t;
 }
 let checked=0;
 for(let i=0;i<original.length;i+=Math.max(1,Math.floor(original.length/120))){
  const pts=original[i].pts;
  const center=pts.reduce((a,p)=>a.map((v,k)=>v+p[k]),[0,0,0]).map(v=>v/pts.length);
  // Avoid shared boundaries: offset the sample into each face's interior.
  const origin=center.map((v,k)=>v*.83+pts[0][k]*.17);
  const hits=original.map(p=>hit(p,origin)).filter(v=>v!==null);
  if(!hits.length)continue;
  const expected=Math.max(...hits);let painted=null;
  for(const p of ordered){const t=hit(p,origin);if(t!==null)painted=t;}
  if(painted===null||Math.abs(painted-expected)>1e-4)throw new Error(`Incorrect surface order: ${painted} vs ${expected}`);
  checked++;
 }
 return checked;
}
