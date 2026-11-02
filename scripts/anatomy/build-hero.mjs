// Simplified process skid for the large homepage illustration. The visual
// keeps the tank bodies, pumps, common frame and connecting pipework;
// dimensions, ribs, fasteners and control details are intentionally omitted.
import { scene } from './line-scene.mjs';
import { boxCorners } from './iso-kit.mjs';
const s=scene(boxCorners({x:-138,y:-60,w:284,d:155,r:0},0,184),'Упрощённая схема технологического узла: ёмкости и насосы на общей раме.');
const {box,panel,occluder,cable,feet}=s;
function cylinder(x,y,z,r,h,axis='z'){
 const tangent=(axis==='z'?55*Math.PI/180:Math.atan2(Math.sin(31*Math.PI/180),Math.sin(55*Math.PI/180)*Math.cos(31*Math.PI/180)))+Math.PI/2;
 const point=(i,end)=>{const t=i/32*Math.PI*2+tangent;return axis==='z'?[x+r*Math.cos(t),y+r*Math.sin(t),z+end]:[x+end,y+r*Math.cos(t),z+r*Math.sin(t)];};
 const rings=[0,h].map(end=>Array.from({length:32},(_,i)=>point(i,end)));
 panel([...rings[0]].reverse());panel(rings[1]);
 for(let i=0;i<32;i++){const j=(i+1)%32;occluder([rings[0][i],rings[0][j],rings[1][j],rings[1][i]]);}
 for(const i of [0,16])cable([rings[0][i],rings[1][i]],false);
}
feet(-128,-48,264,126);
for(const y of [-48,72])box(-128,y,264,6,12,12);
for(const x of [-128,130])box(x,-42,6,114,12,12);
for(const x of [-86,-27]){
 box(x-24,-35,48,54,24,10);
 cylinder(x,-8,34,22,99);
 cylinder(x,-8,133,8,7);
 cable([[x,-8,140],[x,-8,157],[x,36,157],[x,36,67]]);
}
for(const x of [-80,-12]){
 box(x,35,53,31,24,6);
 cylinder(x+4,50,43,12,28,'x');
 cylinder(x+32,50,43,16,12,'x');
 for(const dx of [8,34])box(x+dx,41,6,18,30,3);
 cable([[x+40,50,59],[x+40,50,79],[x+40,72,79]]);
}
cable([[-86,36,67],[-86,72,67],[108,72,67],[108,72,79],[-40,72,79]]);
box(69,-39,57,62,24,111);box(72,23,51,2,31,96);
cable([[97,-8,135],[97,-8,166],[-86,-8,166],[-86,-8,140]]);
s.finish('hero-equipment','src/assets/hero-equipment-schematic.svg',{ink:'#ffffff',color:false,fit:true,relief:true});
