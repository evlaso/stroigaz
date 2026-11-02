// Built with wheresryan22/anatomy (MIT). Schematic, not a dimensional model.
// Parts: six feet and pads; base, trim, four drawers and pull handles;
// two rails, rail seats, end stops and rack strips; 16 cutting-bed slats;
// metal sheet and cut contours; two gantry trucks, two uprights, crossbeam,
// guide, carriage, laser body, nozzle; operator cabinet, screen and controls.
import { writeFileSync } from 'node:fs';
import * as k from './iso-kit.mjs';
const W=760,H=500;
const base={x:-160,y:-86,w:320,d:172,r:5};
const bounds=[...k.boxCorners(base,0,58),...k.boxCorners({x:53,y:-85,w:62,d:170,r:0},58,115),...k.boxCorners({x:164,y:74,w:38,d:34,r:2},0,112)];
const P=k.fitProjection(bounds,W,H,{pad:12,azimuth:55,elevation:31});
const S=(p,s={})=>k.solidSvg(p,{tone:'mid',crease:'lo',flat:true,...s});
const L=(p,s={})=>k.lineSvg(p,{tone:'lo',...s});
const at=p=>k.iso(p,P);
let partCount=0;
const layer=[];
function box(x,y,w,d,z,h,tone='mid',r=1,inner='') {
 partCount++;
 return S(k.slabOf({x,y,w,d,r},z,h,P,4,0),{tone,inner});
}
function bolts(x,y,w,d,z){return k.dotsSvg(k.corners({x,y,w,d,r:0},2.5).map(([a,b])=>at([a,b,z])),{size:.8,tone:'mid'});}
const sorted=items=>items.sort((a,b)=>k.depthOf(a.p,P)-k.depthOf(b.p,P)).map(v=>v.svg).join('');
// Feet and the lower welded frame.
const feet=[];
for(const x of [-140,0,140])for(const y of [-66,66]){
 feet.push({p:[x,y,8],svg:box(x-11,y-9,22,18,0,4,'lo',2)+box(x-7,y-6,14,12,4,12,'mid',1)});
}
layer.push(sorted(feet));
layer.push(box(-160,-86,320,172,16,27,'mid',5));
layer.push(box(-159,-85,318,170,43,4,'hi',3));
// Front service doors. All seams close on panel edges.
for(let i=0;i<4;i++){
 const x=-150+i*77;
 layer.push(box(x,84,71,2,22,16,'lo',.5));
 layer.push(box(x+27,86,18,2,33,2,'mid',.4));
}
// Cutting bed and teeth: each rib is a separate metal support.
layer.push(box(-146,-67,292,134,47,3,'lo',1));
for(let i=0;i<16;i++){
 const x=-141+i*18;
 layer.push(box(x,-64,2,128,50,4,'lo',.25));
}
// Thin sheet on the cutting bed, with closed cut paths on its surface.
const sheet={x:-127,y:-53,w:150,d:105,r:.4};
layer.push(S(k.slabOf(sheet,54,1,P,2,.2),{tone:'hi',crease:'mid'}));
for(const [x,y,w,d] of [[-111,-38,48,30],[-111,5,48,30],[-48,-38,49,73]]){
 layer.push(L(k.planOutline({x,y,w,d,r:4},55.1,P,6),{tone:'mid'}));
}
// The longitudinal rails sit on raised side beams, with closed rack teeth.
const rails=[];
for(const y of [-84,71]){
 let svg=box(-154,y,308,13,47,8,'hi',1);
 svg+=box(-150,y+3,300,6,55,3,'mid',.4);
 svg+=bolts(-150,y+3,300,6,58);
 for(const x of [-156,146])svg+=box(x,y,10,13,55,6,'mid',.5);
 rails.push({p:[0,y,55],svg});
}
layer.push(sorted(rails));
// Gantry trucks and uprights at a single schematic rest position.
const gx=69;
const towers=[];
for(const y of [-84,69]){
 let svg=box(gx-16,y-1,34,16,58,10,'hi',2);
 svg+=bolts(gx-16,y-1,34,16,68);
 svg+=box(gx-12,y+2,26,10,68,28,'hi',1.5);
 towers.push({p:[gx,y,80],svg});
}
layer.push(sorted(towers));
layer.push(box(gx-13,-82,28,164,96,16,'hi',2));
layer.push(box(gx+15,-76,3,150,101,5,'mid',.4));
layer.push(box(gx-10,-80,22,160,112,3,'hi',1));
for(const y of [-70,-40,-10,20,50,70])layer.push(k.dotsSvg([at([gx+16,y,106])],{size:.75,tone:'mid'}));
// Laser carriage: the only dark, emphasized assembly.
const headY=17;
layer.push(box(gx+18,headY-12,7,24,91,22,'hi',1));
layer.push(S(k.slabOf({x:gx+25,y:headY-10,w:15,d:20,r:2},74,30,P,6,.8),{tone:'hi',lit:true}));
layer.push(box(gx+26,headY-8,13,16,69,5,'mid',1));
layer.push(box(gx+30,headY-4,5,8,62,7,'hi',.5));
layer.push(box(gx+31,headY-2,3,4,59,3,'hi',.3));
// Z-axis guide and drive housing, seated directly on the carriage.
layer.push(box(gx+26,headY-8,4,16,104,8,'mid',.5));
layer.push(box(gx+31,headY-6,7,12,104,9,'lo',.8));
// Operator cabinet on a grounded stand; monitor, bezel and closed buttons.
layer.push(box(166,76,34,30,0,5,'lo',2));
layer.push(box(176,86,14,12,5,59,'mid',1));
layer.push(box(164,74,38,34,64,8,'hi',2));
layer.push(box(167,77,32,28,72,35,'hi',2));
layer.push(box(171,104,24,1.5,82,20,'lo',.5));
for(let i=0;i<4;i++)layer.push(box(172+i*6,105.5,3,1,76,3,'mid',.2));
layer.push(box(174,80,20,17,107,1,'mid',.5));
let svg=k.figureSvg({width:W,height:H,label:'Схематичный изометрический вид станка лазерного раскроя: рабочий стол с листом металла, направляющие, портал, лазерная головка и пульт управления.',body:layer.join(''),standalone:'light'});
// Flat assembly-manual linework: opaque paper for occlusion, no shade or shadow.
svg=svg.replace('</style>',`.iso[data-theme="light"]{--anatomy-paper:#f5f6f7;--anatomy-top:#f5f6f7;--anatomy-shade-0:#f5f6f7;--anatomy-shade-1:#f5f6f7;--anatomy-shade-2:#f5f6f7;--anatomy-shade-3:#f5f6f7;--anatomy-mid:#383e43;--anatomy-lo:#596168;--anatomy-hi:#292e32;--anatomy-face:#f5f6f7;--anatomy-lit-top:#f5f6f7;--anatomy-lit-shade:#f5f6f7;--anatomy-lit:#292e32;--anatomy-weight:1.05px;--anatomy-halo-opacity:0}.iso-shade,.iso-top,.iso-bevel,.iso-halo{display:none}.iso-dots circle{opacity:.7}</style>`);
writeFileSync('src/assets/technologies/laser-cutting-schematic.svg',svg);
console.log(`Laser-cutting schematic: ${partCount} solid parts`);
