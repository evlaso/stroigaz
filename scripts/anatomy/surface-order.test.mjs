import test from 'node:test';
import assert from 'node:assert/strict';
import { orderSurfaces, auditSurfaceOrder } from './surface-order.mjs';

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
