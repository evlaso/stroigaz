// Anatomy Figures: illustrative assemblies based on the presentation's equipment.
// No dimensions or construction specifications are implied.
// Parts: feet, skid rails, uprights, crossbars, brackets, tank bodies, heads,
// collars, pump bases, motors, manifolds, valves, gauges, panels and fasteners.
import { scene } from './line-scene.mjs';
import { boxCorners } from './iso-kit.mjs';

function figure(slug, label, build, bounds={x:-135,y:-65,w:270,d:150,h:185}) {
 if(process.argv[2] && process.argv[2] !== slug) return;
 const s=scene(boxCorners({...bounds,r:0},0,bounds.h),label);
 const {box,panel,face,dot,cable}=s;
 // A closed cylinder with actual faces for hidden-edge removal. Only eight
 // silhouette generators are visible; no transparent wireframe through parts.
 const cyl=(x,y,z,r,h,axis='z')=>{
  const tangent=(axis==='z'?55*Math.PI/180:Math.atan2(Math.sin(31*Math.PI/180),Math.sin(55*Math.PI/180)*Math.cos(31*Math.PI/180)))+Math.PI/2;
  const point=(angle,end)=>{const t=angle+tangent;return axis==='z'?[x+r*Math.cos(t),y+r*Math.sin(t),z+end]:[x+end,y+r*Math.cos(t),z+r*Math.sin(t)];};
  const n=32;
  const ends=[0,h].map(end=>Array.from({length:n},(_,i)=>point(i/n*2*Math.PI,end)));
  panel(ends[0]);panel(ends[1]);
  for(let i=0;i<n;i++){
   const j=(i+1)%n;
   // Occluders must still be closed, but facet lines aren't tube seams.
   s.occluder?.([ends[0][i],ends[0][j],ends[1][j],ends[1][i]]);
  }
  for(const i of [0,16])cable([ends[0][i],ends[1][i]]);
 };
 const frame=(x,y,w,d,h)=>{
  s.feet(x,y,w,d);box(x,y,w,d,12,5);
  for(const a of [x,x+w-5])for(const b of [y,y+d-5])box(a,b,5,5,17,h-17);
  for(const z of [h-5,40]){box(x,y,w,5,z,5);box(x,y+d-5,w,5,z,5);box(x,y,5,d,z,5);box(x+w-5,y,5,d,z,5);}
  for(const a of [x+2,x+w-3])for(const z of [42,h-3])dot([a,y+d,z]);
 };
 const pump=(x,y,z)=>{
  box(x,y,48,27,z,5);cyl(x+6,y+13,z+18,12,27,'x');
  for(let i=0;i<5;i++)cyl(x+9+i*4,y+13,z+18,12.4,1,'x');
  cyl(x+34,y+13,z+18,16,10,'x');box(x+36,y+10,7,7,z+33,12);
  for(const a of [x+4,x+42])for(const b of [y+3,y+23])dot([a,b,z+5]);
 };
 const tank=(x,y,z,r,h)=>{cyl(x,y,z,r,h);cyl(x,y,z+h,r+1,3);cyl(x,y,z+h+3,r*.33,4);cyl(x,y,z-3,r+1,3);};
 const valve=(x,y,z)=>{box(x-4,y-4,8,8,z,8);box(x-1,y-1,2,2,z+8,9);box(x-10,y-2,20,4,z+17,2);};
 const pipe=(points)=>{cable(points);for(const p of [points[0],points.at(-1)])box(p[0]-2,p[1]-2,4,4,p[2]-2,4);};
 build({...s,cyl,frame,pump,tank,valve,pipe});
 s.finish(slug,`src/assets/cases/${slug}-schematic.svg`);
}

figure('sampling','Схема станции отбора проб: открытый шкаф, трубопроводы, охладитель, арматура и манометр.',({box,panel,frame,tank,pipe,valve,dot})=>{
 frame(-64,-31,128,63,176);
 box(-64,-31,128,3,47,129);box(-64,-31,3,63,47,129);box(-64,-31,128,63,174,3);
 // Open door, supported by the front left upright.
 panel([[-64,32,47],[-110,83,47],[-110,83,174],[-64,32,174]]);
 panel([[-61,35,52],[-104,82,52],[-104,82,169],[-61,35,169]]);
 box(-107,75,3,4,101,15);
 tank(-16,-10,75,13,55);
 for(let z=79;z<126;z+=5)pipe([[-28,-8,z],[-29,9,z],[-7,9,z],[-5,-8,z]]);
 pipe([[-16,-10,133],[-16,-10,154],[39,-10,154],[39,15,154],[39,15,62],[-16,15,62],[-16,-10,75]]);
 valve(39,15,95);valve(-16,15,62);
 box(29,12,22,8,154,18);box(33,20,14,1,158,10);
 for(const x of [-56,56])for(const z of [57,165])dot([x,32,z]);
}, {x:-115,y:-35,w:185,d:122,h:180});

figure('boiler','Схема уличного шкафа для газового оборудования: корпус, арматура и блок управления.',({frame,box,panel,pipe,valve})=>{
 frame(-65,-35,130,70,180);box(-65,-35,130,4,45,130);box(-65,-35,4,70,45,130);box(-65,-35,130,70,178,5);
 box(-44,-25,55,26,85,70);box(-36,1,39,2,129,17);
 for(let x=-38;x<8;x+=8)box(x,2,3,1,95,18);
 box(27,-20,24,20,129,32);box(31,0,16,1,143,10);
 pipe([[-16,-10,85],[-16,-10,64],[40,-10,64],[40,17,64],[40,17,110]]);valve(40,17,80);
 panel([[-65,35,45],[-105,86,45],[-105,86,178],[-65,35,178]]);
},{x:-110,y:-35,w:180,d:125,h:187});

figure('structures','Схема опорной конструкции с лестницей, площадкой и ограждениями.',({box,pipe,dot})=>{
 for(const x of [-95,75])for(const y of [-40,35]){
  box(x-8,y-8,22,22,0,4);box(x,y,6,6,4,110);
  for(const dx of [-4,12])for(const dy of [-4,12])dot([x+dx,y+dy,4]);
 }
 for(const z of [30,105]){box(-95,-40,176,6,z,7);box(-95,35,176,6,z,7);box(-95,-40,6,81,z,7);box(75,-40,6,81,z,7);}
 for(let x=-89;x<75;x+=12)box(x,-34,5,69,112,3);
 for(const y of [-40,38]){for(const x of [-95,-38,19,78])box(x,y,3,3,115,43);box(-95,y,176,3,155,3);box(-95,y,176,3,133,2);}
 for(let i=0;i<9;i++){const y=43+i*8,z=104-i*12;box(25,y,48,9,z,3);}
 pipe([[25,43,155],[25,116,47]]);pipe([[73,43,155],[73,116,47]]);
 for(let i=0;i<4;i++)for(const x of [25,73])box(x,43+i*24,2,2,105-i*36,40);
},{x:-110,y:-50,w:205,d:180,h:165});

figure('cip','Схема установки химической промывки: бак, насос, трубопроводы и шкаф управления.',({frame,tank,pump,box,pipe,valve})=>{
 frame(-100,-45,200,90,45);tank(-55,-2,45,30,86);pump(7,0,17);
 box(60,-35,30,19,55,72);box(64,-16,22,1,94,23);
 pipe([[-55,-2,45],[-55,26,45],[42,26,45],[42,13,50]]);valve(-12,26,45);
 pipe([[43,13,62],[43,13,142],[-55,13,142],[-55,-2,138]]);valve(43,13,110);
});

figure('osmosis','Схема установки обратного осмоса: рама, мембранные корпуса, фильтры, насос и управление.',({frame,cyl,pump,box,pipe,valve})=>{
 frame(-130,-35,260,70,160);
 for(const z of [65,98,131]){
  for(const x of [-108,94]){box(x,-18,9,38,z-15,5);box(x,-5,9,6,z-10,10);}
  cyl(-113,0,z,11,222,'x');cyl(-116,0,z,13,4,'x');cyl(109,0,z,13,4,'x');
 }
 pump(-110,8,17);
 for(const x of [55,82,109]){cyl(x,20,22,8,26);cyl(x,20,48,9,4);}
 box(-124,-30,30,12,164,25);box(-120,-18,22,1,170,13);
 pipe([[-116,0,65],[-123,0,65],[-123,0,131],[-116,0,131]]);
 pipe([[113,0,131],[122,0,131],[122,0,48],[109,20,48]]);valve(122,0,94);
},{x:-140,y:-45,w:285,d:105,h:195});

figure('vacuum','Схема вакуумной установки: насосная группа, трубопроводы и шкаф управления.',({frame,tank,pump,pipe,valve,box})=>{
 frame(-100,-45,200,90,45);tank(-60,-5,45,26,76);
 pump(-5,5,17);pump(-5,-33,17);
 box(60,-35,32,22,48,86);box(65,-13,22,1,101,21);
 pipe([[-60,-5,124],[-60,-5,143],[30,-5,143],[30,18,143],[30,18,62]]);valve(30,18,100);
 pipe([[-60,-5,45],[-60,30,45],[37,30,45],[37,18,50]]);
});

figure('dosing','Схема дозирования реагентов: два бака с мешалками, дозирующие насосы и арматура.',({frame,tank,box,cyl,pump,pipe,valve})=>{
 frame(-105,-45,210,90,40);
 for(const x of [-59,25]){
  tank(x,-8,40,28,76);box(x-11,-18,23,20,123,19);cyl(x,-8,119,3,4);
  for(let z=47;z<103;z+=9)box(x+27,-9,1,7,z,1);
  box(x+28,18,18,20,20,19);box(x+31,20,12,13,39,12);
  pipe([[x,-8,40],[x,23,40],[x+30,23,40]]);valve(x,23,40);
  pipe([[x+36,23,51],[x+36,23,152],[x+13,23,152]]);
 }
});

function module(slug,label,mode){
 figure(slug,label,({frame,box,panel,tank,pump,pipe,valve})=>{
  frame(-135,-45,270,90,145);
  // Cutaway housing with roof beams and ribs attached to the back wall.
  box(-135,-45,270,3,17,123);box(-135,-45,3,90,17,123);
  for(let x=-124;x<130;x+=18)box(x,-42,2,2,18,120);
  for(const x of [-130,-45,40,125])box(x,-45,5,90,140,5);
  box(103,-35,24,18,65,61);box(107,-17,16,1,101,16);
  if(mode==='pumps'){
   for(const x of [-110,-47,16]){pump(x,5,17);pipe([[x+40,18,62],[x+40,18,80],[x+40,-14,80]]);valve(x+40,18,63);}
   pipe([[-70,-14,80],[110,-14,80]]);
  }else{
   for(const x of [-95,-43,9]){tank(x,-7,20,18,86);valve(x,24,62);pipe([[x,-7,109],[x,24,109],[x,24,62]]);}
   pump(51,2,17);pipe([[-95,24,62],[-95,34,62],[89,34,62],[89,15,62]]);
   if(mode==='drinking'){box(-116,26,13,12,75,44);box(-111,38,3,2,85,24);}
  }
 },{x:-145,y:-55,w:295,d:115,h:153});
}
module('surface-water','Схема модульной установки очистки поверхностных вод с фильтрами, насосом и управлением.','filters');
module('water-pumping','Схема модульной насосной станции с тремя насосами и общим коллектором.','pumps');
module('drinking-water','Схема мобильного комплекса подготовки питьевой воды: модуль, фильтры, насос и шкаф управления.','drinking');
