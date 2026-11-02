import * as k from './iso-kit.mjs';
import { writeFileSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { orderSurfaces, auditSurfaceOrder } from './surface-order.mjs';
export const LINE_STYLE=`.iso[data-theme="light"]{--anatomy-paper:#f5f6f7;--anatomy-top:#f5f6f7;--anatomy-shade-0:#f5f6f7;--anatomy-shade-1:#f5f6f7;--anatomy-shade-2:#f5f6f7;--anatomy-shade-3:#f5f6f7;--anatomy-mid:#383e43;--anatomy-lo:#596168;--anatomy-hi:#292e32;--anatomy-face:#f5f6f7;--anatomy-lit-top:#f5f6f7;--anatomy-lit-shade:#f5f6f7;--anatomy-lit:#292e32;--anatomy-weight:1.05px;--anatomy-halo-opacity:0}.iso-shade,.iso-top,.iso-bevel,.iso-halo{display:none}.iso-dots circle{opacity:.7}`;
const sub=(a,b)=>a.map((v,i)=>v-b[i]);
const add=(a,b)=>a.map((v,i)=>v+b[i]);
const mul=(a,t)=>a.map(v=>v*t);
const dot=(a,b)=>a.reduce((s,v,i)=>s+v*b[i],0);
const cross=(a,b)=>[a[1]*b[2]-a[2]*b[1],a[2]*b[0]-a[0]*b[2],a[0]*b[1]-a[1]*b[0]];
export function scene(bounds,label){
 const P=k.fitProjection(bounds,760,500,{pad:20,azimuth:55,elevation:31});
 const a=55*Math.PI/180,e=31*Math.PI/180;
 const toward=[Math.cos(a)*Math.cos(e),Math.sin(a)*Math.cos(e),Math.sin(e)];
 const boxes=[],triangles=[],edges=[],dots=[],surfaces=[],routes=[];
 let count=0;
 const at=p=>k.iso(p,P);
 const edge=(a,b,weight=1.05)=>edges.push({a,b,weight});
 const face=(pts)=>{count++;pts.forEach((p,i)=>edge(p,pts[(i+1)%pts.length]));};
 const panel=(pts)=>{surfaces.push({pts,material:"steel"});face(pts);for(let i=1;i<pts.length-1;i++)triangles.push([pts[0],pts[i],pts[i+1]]);};
 const occluder=(pts,options={})=>{surfaces.push({pts,material:"steel",...options});for(let i=1;i<pts.length-1;i++)triangles.push([pts[0],pts[i],pts[i+1]]);};
 const box=(x,y,w,d,z,h)=>{
  count++;boxes.push({min:[x,y,z],max:[x+w,y+d,z+h]});
  const bottom=[[x,y,z],[x+w,y,z],[x+w,y+d,z],[x,y+d,z]];
  const top=bottom.map(p=>add(p,[0,0,h]));
  const material=z+h<20?'graphite':Math.min(w,d)<=6 && h>15?'frame':'steel';
  surfaces.push({pts:top,material});
  for(let i=0;i<4;i++)surfaces.push({pts:[bottom[i],bottom[(i+1)%4],top[(i+1)%4],top[i]],material});
  for(let i=0;i<4;i++){edge(bottom[i],bottom[(i+1)%4]);edge(top[i],top[(i+1)%4]);edge(bottom[i],top[i]);}
 };
 const point=(p,r=.8)=>dots.push({p,r});
 const ring=(x,y,r,z)=>{const pts=Array.from({length:24},(_,i)=>[x+Math.cos(i/24*2*Math.PI)*r,y+Math.sin(i/24*2*Math.PI)*r,z]);pts.forEach((p,i)=>edge(p,pts[(i+1)%24],.9));};
 const cable=(pts,physical=true)=>{if(physical)routes.push(pts);pts.slice(1).forEach((p,i)=>edge(pts[i],p,2));};
 const feet=(x,y,w,d)=>{for(const [a,b] of k.corners({x,y,w,d,r:0},9)){box(a-6,b-5,12,10,0,3);box(a-4,b-3,8,6,3,9);}};
 const table=(x,y,w,d,h=65)=>{
  for(const [a,b] of k.corners({x,y,w,d,r:0},6)){box(a-4,b-4,8,8,3,h-8);box(a-6,b-6,12,12,0,3);}
  box(x,y,w,5,h-15,10);box(x,y,5,d,h-15,10);box(x,y,w,d,h-5,5);
 };
 const cabinet=(x,y,w=58,d=58,h=92)=>{
  feet(x,y,w,d);box(x,y,w,d,12,h-12);
  box(x+3,y+d,w-6,1,20,h-27);box(x+w-9,y+d+1,3,2,h/2,13);
  box(x+8,y+8,w-16,d-16,h,1);
  for(let i=0;i<5;i++)box(x+7+i*(w-14)/5,y+d+1,3,1,25,8);
 };
 function blocked(p){
  // Cast a ray toward the shared isometric camera. Hidden edges are omitted,
  // so visibility is independent of the order in which parts are constructed.
  for(const b of boxes){
   let enter=-Infinity,leave=Infinity;
   for(let j=0;j<3;j++){
    let t0=(b.min[j]-p[j])/toward[j],t1=(b.max[j]-p[j])/toward[j];
    if(t0>t1)[t0,t1]=[t1,t0];enter=Math.max(enter,t0);leave=Math.min(leave,t1);
   }
   if(leave>Math.max(enter,.045)+.02)return true;
  }
  for(const [v0,v1,v2] of triangles){
   const e1=sub(v1,v0),e2=sub(v2,v0),h=cross(toward,e2),det=dot(e1,h);
   if(Math.abs(det)<1e-8)continue;
   const s=sub(p,v0),u=dot(s,h)/det;if(u<-.0001||u>1.0001)continue;
   const q=cross(s,e1),v=dot(toward,q)/det;if(v<-.0001||u+v>1.0001)continue;
   if(dot(e2,q)/det>.065)return true;
  }
  return false;
 }
 function finish(slug, outputPath){
  if(process.env.ANATOMY_SCENE_EXPORT){
   const origin=at([0,0,0]);
   const axes=[[1,0,0],[0,1,0],[0,0,1]].map(p=>sub(at(p),origin));
   const exportTarget=process.env.ANATOMY_SCENE_EXPORT;
   if(!exportTarget.endsWith('.json'))mkdirSync(exportTarget,{recursive:true});
   const exportFile=exportTarget.endsWith('.json')?exportTarget:join(exportTarget,`${slug}.json`);
   const linePath=outputPath || `src/assets/technologies/${slug}-schematic.svg`;
   writeFileSync(exportFile,JSON.stringify({surfaces,routes,toward,origin,axes,linePath}));
  }
  const paths=[],seen=new Set();
  for(const {a,b,weight} of edges){
   const id=[a.join(','),b.join(',')].sort().join('|');if(seen.has(id))continue;seen.add(id);
   const sa=at(a),sb=at(b),steps=Math.max(2,Math.ceil(Math.hypot(sb[0]-sa[0],sb[1]-sa[1])/.65));
   let run=[];
   const flush=()=>{if(run.length>1)paths.push(`<path d="M${[run[0],run[run.length-1]].map(p=>p.map(v=>v.toFixed(2)).join(',')).join('L')}" stroke-width="${weight}"/>`);run=[];};
   for(let i=0;i<=steps;i++){
    const p=add(a,mul(sub(b,a),i/steps));
    if(!blocked(p))run.push(at(p));else flush();
   }
   flush();
  }
  for(const {p,r} of dots)if(!blocked(p)){const [cx,cy]=at(p);paths.push(`<circle cx="${cx}" cy="${cy}" r="${r}" fill="#383e43" stroke="none"/>`);}
  const body=`<g fill="none" stroke="#383e43" stroke-linejoin="round" stroke-linecap="round">${paths.join('')}</g>`;
  let svg=k.figureSvg({width:760,height:500,label,body,standalone:'light'});svg=svg.replace('</style>',LINE_STYLE+'</style>');
  const destination=outputPath || `src/assets/technologies/${slug}-schematic.svg`;
  writeFileSync(destination,svg);
  // The alternate uses the same projection and contours: only light and materials change.
  const light=[-.35,-.25,.9];
  const palette={steel:[231,233,235],frame:[192,197,201],graphite:[104,111,117]};
  const ordered=orderSurfaces(surfaces,toward);
  const audited=auditSurfaceOrder(surfaces,ordered,toward);
  const fills=ordered.map(({pts,material,plane})=>{
   let normal=plane.normal;
   const length=Math.hypot(...normal)||1;normal=normal.map(v=>v/length);
   if(dot(normal,toward)<0)normal=mul(normal,-1);
   const brightness=.65+.35*Math.max(0,dot(normal,light));
   const rgb=palette[material].map(v=>Math.round(v*brightness));
   const fill=`rgb(${rgb.join(' ')})`;
   return `<polygon points="${pts.map(p=>at(p).map(v=>v.toFixed(2)).join(',')).join(' ')}" fill="${fill}" stroke="${fill}" stroke-width=".4"/>`;
  }).join('');
  const colored=`<g>${fills}${body.replace('stroke="#383e43"','stroke="#4d5358" stroke-opacity=".7"')}</g>`;
  const colorSvg=k.figureSvg({width:760,height:500,label,body:colored,standalone:'light'});
  writeFileSync(destination.replace('-schematic.svg','-color.svg'),colorSvg);
  console.log(`${slug}: ${count} parts, ${audited} surface-order checks passed`);
 }
 return {P,at,box,face,panel,occluder,path:()=>{},dot:point,ring,cable,feet,table,cabinet,finish};
}
