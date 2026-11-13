import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { scene } from './line-scene.mjs';

test('X reflection +220° matches Y reflection +40°, including curved silhouettes',()=>{
 const temp=mkdtempSync('/tmp/opencode/anatomy-mirror-');
 const previous=process.env.ANATOMY_SCENE_EXPORT;
 try{
  const render=(slug,options)=>{
   const json=join(temp,`${slug}.json`),svg=join(temp,`${slug}-schematic.svg`);
   process.env.ANATOMY_SCENE_EXPORT=json;
   const s=scene([[0,0,0],[30,25,40]],'Reflection regression',{...options,fixedCanvas:true});
   s.box(2,3,8,12,0,20,{material:'frame'});
   s.revolve(20,15,0,[[0,0],[5,0],[5,12],[0,12]],{segments:16});
   s.tube([[20,15,12],[20,15,30],[12,15,30]],.7);
   s.finish(slug,svg);
   return {data:JSON.parse(readFileSync(json,'utf8')),svg:readFileSync(svg,'utf8')};
  };
  const x=render('mirror-x',{mirrorX:true,rotation:220});
  const y=render('mirror-y',{mirrorY:true,rotation:40});
  const close=(a,b)=>{
   assert.equal(a.length,b.length);
   a.forEach((v,i)=>Array.isArray(v)?close(v,b[i]):assert.ok(Math.abs(v-b[i])<1e-9,`${v} != ${b[i]}`));
  };
  assert.equal(x.data.surfaces.length,y.data.surfaces.length);
  x.data.surfaces.forEach((surface,i)=>{
   const other=y.data.surfaces[i];
   assert.equal(surface.material,other.material);
   close(surface.pts,other.pts);
   if(surface.normals)close(surface.normals,other.normals);
  });
  close(x.data.origin,y.data.origin);
  close(x.data.axes,y.data.axes);
  const paths=svg=>[...svg.matchAll(/<path d="([^"]+)"/g)].map(m=>m[1]);
  assert.deepEqual(paths(x.svg),paths(y.svg),'hidden-line silhouettes must agree');
  assert.match(x.svg,/data-frame="canvas"/);
  assert.match(x.svg,/viewBox="0 0 760 500"/);
  const reflected=render('mirror-only',{mirrorX:true});
  assert.ok(reflected.data.surfaces.flatMap(s=>s.pts).every(([x])=>x<=0),'reflection works without yaw too');
 }finally{
  if(previous===undefined)delete process.env.ANATOMY_SCENE_EXPORT;
  else process.env.ANATOMY_SCENE_EXPORT=previous;
  rmSync(temp,{recursive:true,force:true});
 }
});
