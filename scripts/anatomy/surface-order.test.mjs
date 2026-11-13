import test from 'node:test';
import assert from 'node:assert/strict';
import { orderSurfaces, auditSurfaceOrder } from './surface-order.mjs';
import { revolvedMesh } from './iso-kit.mjs';

const view=[0,0,1];
test('intersecting plates split where the nearest surface changes',()=>{
 const surfaces=[
  {pts:[[-3,-2,-2],[3,-2,2],[3,2,2],[-3,2,-2]],material:'steel'},
  {pts:[[-2,-1,0],[2,-1,0],[2,1,0],[-2,1,0]],material:'graphite'}
 ];
 const sorted=orderSurfaces(surfaces,view);
 assert.ok(sorted.length>surfaces.length,'intersecting faces must be split');
 assert.equal(auditSurfaceOrder(surfaces,sorted,view),2);
});

test('a rear enclosure cannot cover a smaller foreground part',()=>{
 const surfaces=[
  {pts:[[-10,-10,0],[10,-10,0],[10,10,0],[-10,10,0]],material:'steel'},
  {pts:[[-1,-1,3],[1,-1,3],[1,1,3],[-1,1,3]],material:'graphite'},
  {pts:[[-2,-2,2],[2,-2,2],[2,2,2],[-2,2,2]],material:'steel'}
 ];
 const sorted=orderSurfaces(surfaces,view);
 assert.equal(sorted.at(-1).source,1);
 assert.equal(auditSurfaceOrder(surfaces,sorted,view),3);
});

test('split faces retain their original material and no degenerate fragments',()=>{
 const surfaces=[
  {pts:[[-3,-2,-2],[3,-2,2],[3,2,2],[-3,2,-2]],material:'steel'},
  {pts:[[-2,-1,0],[0,-1,0],[2,-1,0],[2,1,0],[-2,1,0]],material:'graphite'}
 ];
 const sorted=orderSurfaces(surfaces,view);
 for(const p of sorted){assert.equal(p.material,surfaces[p.source].material);assert.ok(p.pts.length>=3);}
 assert.equal(auditSurfaceOrder(surfaces,sorted,view),2);
});

const camera=[.4917,.7022,.515];
const profiles={
 frustum:[[0,0],[6,0],[10,12],[0,12]],
 funnel:[[3,0],[4,1],[9,12],[9,15],[8,15],[8,12.2],[3,1.8]],
 eye:[[2,0],[4,0],[4,1],[2,1]],
 belt:[[9.7,0],[10.4,.4],[10.4,1.2],[9.7,1.6]]
};
for(const [name,profile] of Object.entries(profiles))test(`${name}: closed mesh, finite smooth normals and correct painter order`,()=>{
 const {surfaces,edges}=revolvedMesh(profile,{segments:16,toward:camera,material:'frame'});
 const key=p=>p.map(n=>Math.round(n*1e7)).join(',');
 const adjacency=new Map();
 for(const face of surfaces){
  assert.equal(face.material,'frame');
  assert.equal(face.normals.length,face.pts.length);
  for(const n of face.normals)assert.ok(n.every(Number.isFinite) && Math.abs(Math.hypot(...n)-1)<1e-9);
  face.pts.forEach((p,i)=>{
   const pair=[key(p),key(face.pts[(i+1)%face.pts.length])].sort().join('|');
   adjacency.set(pair,(adjacency.get(pair)||0)+1);
  });
 }
 assert.ok(edges.length>0);
 assert.ok([...adjacency.values()].every(n=>n===2),'every mesh edge has two incident faces, including the inner wall');
 const backing={pts:[[-20,-20,-2],[20,-20,-2],[20,20,-2],[-20,20,-2]],material:'steel'};
 const original=[backing,...surfaces];
 assert.ok(auditSurfaceOrder(original,orderSurfaces(original,camera),camera)>0);
});

test('annular eyes and funnel throats contain no cap across their opening',()=>{
 for(const profile of [profiles.eye,profiles.funnel]){
  const {surfaces}=revolvedMesh(profile,{segments:16});
  // Each polygon lies outside a half-plane through the axis, so no polygon
  // can intersect an axial ray. A disk cap would violate this assertion.
  for(const {pts} of surfaces){
   const sum=pts.reduce((a,p)=>[a[0]+p[0],a[1]+p[1]],[0,0]);
   assert.ok(pts.every(p=>p[0]*sum[0]+p[1]*sum[1]>0));
  }
 }
});

test('oblique tube and mirrored meshes retain valid surface ordering',()=>{
 const {surfaces}=revolvedMesh([[0,0],[2,0],[2,13],[0,13]],{axis:[3,4,1],segments:16,toward:camera,material:'graphite'});
 const angle=35*Math.PI/180;
 const transform=([x,y,z])=>[Math.cos(angle)*x+Math.sin(angle)*y,Math.sin(angle)*x-Math.cos(angle)*y,z];
 const mirrored=surfaces.map(s=>({...s,pts:s.pts.map(transform),normals:s.normals.map(transform)}));
 assert.equal(auditSurfaceOrder(mirrored,orderSurfaces(mirrored,camera),camera),mirrored.length);
});
