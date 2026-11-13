// Anatomy Figures: illustrative assemblies based on the presentation's equipment.
// No dimensions or construction specifications are implied.
// Parts: feet, skid rails, uprights, crossbars, brackets, tank bodies, heads,
// collars, pump bases, motors, manifolds, valves, gauges, panels and fasteners.
import { scene } from './line-scene.mjs';
import { boxCorners } from './iso-kit.mjs';

function figure(slug, label, build, bounds={x:-135,y:-65,w:270,d:150,h:185}, options={}) {
 if(process.argv[2] && process.argv[2] !== slug) return;
 const s=scene(boxCorners({...bounds,r:0},0,bounds.h),label,options);
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
   const normal=index=>{const t=index/n*2*Math.PI+tangent;return axis==='z'?[Math.cos(t),Math.sin(t),0]:[0,Math.cos(t),Math.sin(t)];};
   s.occluder?.([ends[0][i],ends[0][j],ends[1][j],ends[1][i]],{normals:[normal(i),normal(j),normal(j),normal(i)]});
  }
  for(const i of [0,16])cable([ends[0][i],ends[1][i]],false);
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
 const valve=(x,y,z,size=1)=>{box(x-4*size,y-4*size,8*size,8*size,z,8*size);box(x-size,y-size,2*size,2*size,z+8*size,9*size);box(x-10*size,y-2*size,20*size,4*size,z+17*size,2*size);};
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

// STEP study, separate from the presentation-based dosing figure above.
// Source: «Установка приготовления и дозирования.stp», СПЦЭ.19.162.00.00.000,
// SHA-256 03c44363488cff2ed454c6d69c128e9e0971f465dcda99695e8d4096d301756e.
// scripts/anatomy/step-layout.py: located XCAF occurrences, AddOptimal bounds.
// Uniform illustrative scale: [x,y,z] = [(Y+475),-(X+467.93),(Z+80)] / 12.5.
// View: mirror local X, then rotate +220° about Z (relative to the -90° STEP
// mapping above). The site's 55°/31° camera is NOT changed. A 5° sweep of both
// unmirrored and X-mirrored poses selects the reference's LEFT panel flank,
// open pump front and down/right-running depth edges. Instruments stay on
// their reference sides. Tank groups are translated independently in plan:
// funnel tank (+26,-15), plain tank (+21,-15), before mirror/rotation. This
// puts the funnel tank left/front and the plain tank right/back, partly hidden.
// Rebuild: ANATOMY_SCENE_EXPORT=<dir> node scripts/anatomy/build-cases.mjs dosing-step
//         python3 scripts/anatomy/frame-variants.py dosing-step
//         python3 scripts/anatomy/render-metal.py <dir>/dosing-step.json
// fixedCanvas keeps 760×500 / 20 px margins throughout this pipeline.
// Tank sizes, panel envelope, pump spacing and main route levels come from STEP.
// No common skid, twin mixers or separate
// control cabinet are invented: STEP has two floor-standing tanks, a pump panel,
// two metering pumps with local controls, and ONE barrel/transfer pump on a tank.
figure('dosing-step','Установка приготовления и дозирования: ребристые баки с горловинами, воронка и бочковой насос, открытая панель с двумя насосами-дозаторами, коллекторами и приборами.',(parts)=>{
 // Move entire tank groups, including their necks, sight tubes and top fittings.
 // Panel/pump coordinates remain measured; only the two inter-group pipes adapt.
 const tankOffsets={'-60':[26,-15],'60':[21,-15]};
 let offset=[0,0];
 const shifted=([x,y,z])=>[x+offset[0],y+offset[1],z];
 const box=(x,y,...args)=>parts.box(x+offset[0],y+offset[1],...args);
 const revolve=(x,y,...args)=>parts.revolve(x+offset[0],y+offset[1],...args);
 const tube=(points,...args)=>parts.tube(points.map(shifted),...args);
 const edge=(a,b,...args)=>parts.edge(shifted(a),shifted(b),...args);
 const valve=(x,y,...args)=>parts.valve(x+offset[0],y+offset[1],...args);
 const cylinder=(x,y,z,r,h,axis='z',material='steel')=>revolve(x,y,z,[[0,0],[r,0],[r,h],[0,h]],{axis,material});
 const belt=(x,y,z,r,h)=>revolve(x,y,z,[[r-.3,0],[r+.45,.45],[r+.45,h-.45],[r-.3,h]],{});
 // The measured envelopes are kept; rolled shoulders and three raised moulded
 // belts replace the blank drums. No tessellation edges or fasteners are drawn.
  for(const y of [60,-60]){
   offset=tankOffsets[y];
  revolve(-26,y,0,[[0,0],[43.8,0],[45.2,2],[45.2,76],[44.4,81],[40,88.4],[0,88.4]]);
  for(const z of [13.5,39,68.5])belt(-26,y,z,45.2,1.6);
  cylinder(-26,y,88.4,18.2,1.6);cylinder(-26,y,90,17.5,2.2);
  cylinder(-26,y,92.2,15.6,1.1);
  tube([[-26,y-10,93.4],[-26,y-10,94.7],[-26,y+10,94.7],[-26,y+10,93.4]],.65);
  // Second, smaller screw neck on the far shoulder.
  // STEP nodes 664 / 673: original Y=-1205, R=109.5, Z=1025..1093.
  cylinder(-58.4,y,88.4,8.3,3);cylinder(-58.4,y,91.4,8.76,1.7);
  cylinder(-58.4,y,93.1,8,.74);
  // Two moulded bottom recess outlines, not extra support skids.
  for(const theta of [-.35,1.9]){
   const p=[-26+45.25*Math.cos(theta),y+45.25*Math.sin(theta)];
   const q=[-26+45.25*Math.cos(theta+.15),y+45.25*Math.sin(theta+.15)];
   edge([...p,1],[...p,9]);edge([...p,9],[...q,9]);edge([...q,9],[...q,1]);
  }
  // The two real external sight tubes are on the BACK of the tanks in this
  // view. Model them in place; the closed tank occludes them, not a cutaway.
  tube([[-68,y,9],[-74,y,9],[-74,y,82],[-68,y,82]],.9);
  for(const z of [10,79])cylinder(-74,y,z,1.8,2.4);
 }
  // Hollow funnel: outer cone, rolled rim, inner cone and open throat. Its
  // opening remains a hole in both hidden-line and lit geometry.
  offset=tankOffsets[-60];
 revolve(-26,-92.4,88.4,[[3.2,0],[4.2,1.2],[8.8,12],[8.8,15.2],[8.1,15.2],[8.1,12.2],[3.2,1.8]]);
 // Tank-top saddle and barrel pump, including exposed shaft/column, drive,
 // stepped motor housing, outlet and the characteristic carry handle.
 box(-33,-36.2,14,14,89,1.1);
 cylinder(-26,-29.2,90.1,3.2,7.7);cylinder(-26,-29.2,97.8,4.1,2);
 cylinder(-26,-29.2,99.8,2.6,4);
 revolve(-26,-29.2,103.8,[[0,0],[5.8,0],[6.4,1.3],[6.4,10.6],[4.9,13],[4.9,18.7],[4.2,19.3],[0,19.3]],{material:'frame'});
 tube([[-26,-34,123.1],[-26,-34,124.7],[-26,-24.4,124.7],[-26,-24.4,123.1]],.65);
  const tankLink=[-26+tankOffsets[60][0]-offset[0],33.2+tankOffsets[60][1]-offset[1]];
  tube([[-26,-29.2,100.7],[-26,-20.5,100.7],[-26,-20.5,96.4],[tankLink[0],-20.5,96.4],[...tankLink,96.4],[...tankLink,89]],1.15);
 // High filling riser beside the drive (not a second mixer). Main actuator,
 // neck and one valve retained, without the source's flanges and screws.
 cylinder(10,-60,88.4,2.4,40.7);cylinder(10,-60,126.6,4.8,2.1);
 for(const z of [102,107.5,120])cylinder(10,-60,z,2.9,1.3,'z','frame');
 box(10,-63.2,9.8,6.4,91.2,10.5,{material:'frame'});
 valve(10,-60,110,.35);
 tube([[10,-60,98],[22,-60,98],[22,-49,98]],1.15);
 // Tank-top support webs under the two tall components.
 for(const y of [-38,-65]){
  box(-10,y,20,1.4,85,5.1);
  box(-8,y,1.4,9,85,5.1);
 }

  // Frame with adjustable feet, a full rear mounting sheet and both side
  // sheets. Looking through its real open front, no arbitrary cutaway needed.
  offset=[0,0];
 for(const x of [38,75.2])for(const y of [-40.6,44.2]){
  cylinder(x+1.6,y+1.6,0,3.2,.9,'z','graphite');
  cylinder(x+1.6,y+1.6,.9,.7,5.5);
  box(x,y,3.2,3.2,6.4,117.6,{material:'frame'});
 }
 for(const z of [12,52.4,120.8]){
  for(const y of [-40.6,44.2])box(38,y,40.4,3.2,z,3.2,{material:'frame'});
  for(const x of [38,75.2])box(x,-37.4,3.2,81.6,z,3.2,{material:'frame'});
 }
 box(41.2,-37.4,.4,81.6,15.2,105.6);
 for(const y of [-37.4,43.8])box(41.6,y,33.6,.4,52.4,68.4);
 box(41.2,1.8,34,3.2,12,3.2,{material:'frame'});
 box(75.2,1.8,3.2,3.2,15.2,37.2,{material:'frame'});
 // Four lifting eyes: actual annular through-holes, not circles on filled boxes.
 for(const x of [38.8,76])for(const y of [-29,34]){
  box(x,y-3,1.6,6,123.2,2.2,{material:'frame'});
  revolve(x,y,126,[[1.4,0],[3,0],[3,1.6],[1.4,1.6]],{axis:'x',segments:32,material:'frame'});
 }
 // Metering pumps: motor/control body, display bezel, gearbox, diaphragm
 // head and its setting knob; pitch is the measured 400 mm / 12.5.
 for(const dy of [0,32]){
  box(59,-30+dy,16,25,55.6,1.2,{material:'frame'});
  box(60,-25.4+dy,10,16,56.8,7,{material:'frame'});
  cylinder(68.8,-23.2+dy,61,6.4,12.1,'z','graphite');
  box(65.2,-29.2+dy,11.4,12,73.1,15.4,{material:'graphite'});
  box(76.6,-28+dy,.8,9.8,78,7.5,{material:'frame'});
  box(77.4,-26.7+dy,.15,7.2,79.4,4.9);
  edge([77.6,-27+dy,76],[77.6,-19+dy,76]);
  // A few casing ribs convey the motor, without a dense CAD hatch.
  for(const yy of [-27,-23,-19])edge([66,yy+dy,88.6],[74.5,yy+dy,88.6]);
  cylinder(65.8,-10.7+dy,56.4,7.2,10.8,'x','graphite');
  cylinder(76.6,-10.7+dy,56.4,6.4,1.8,'x','frame');
  cylinder(78.4,-10.7+dy,56.4,3.1,2.3,'x');
  cylinder(80.7,-10.7+dy,56.4,1.7,1.3,'x');
  // Separate suction and delivery checks and branches, plus drain cock.
  tube([[44.1,-10.7+dy,37.1],[66.6,-10.7+dy,37.1],[66.6,-10.7+dy,49.2]],1);
  tube([[44.1,-10.7+dy,86.9],[66.6,-10.7+dy,86.9],[66.6,-10.7+dy,63.6]],1);
  for(const z of [44,68.5,77])cylinder(66.6,-10.7+dy,z,1.9,3.6,'z','graphite');
  valve(53,-10.7+dy,37.1,.36);
  valve(60,-10.7+dy,82.8,.31);
  tube([[66.6,-10.7+dy,37.1],[66.6,-10.7+dy,29.5]],.7);
  cylinder(66.6,-10.7+dy,29.5,1.5,4.4,'z','graphite');
 }
 // Lower manifold and the external low tank connection with its pipe support.
  const tankOutlet=[16.1+tankOffsets[60][0],60+tankOffsets[60][1],7.9];
  tube([tankOutlet,[66.8,tankOutlet[1],7.9],[66.8,60,7.9],[66.8,60,37.1],[52.4,60,37.1],[52.4,49.4,37.1],[44.1,49.4,37.1],[44.1,-10.7,37.1]],1.25);
 valve(66.8,60,14,.35);
 box(58.8,54.1,8,8,0,.8,{material:'frame'});
 box(61.8,57.1,2,2,.8,39.4,{material:'frame'});
 // Delivery header, outlet riser and top isolating valve.
 tube([[44.1,-21.6,86.9],[44.1,27.4,86.9],[44.1,27.4,103.7]],1);
 tube([[44.1,6.4,86.9],[44.1,6.4,127.9]],1);
 valve(44.1,6.4,112,.38);valve(44.1,27.4,94,.33);
 // Bladder damper: tapered ends, shoulder and waist, not a featureless rod.
 tube([[44.1,-21.6,86.9],[49.5,-21.6,86.9],[49.5,-21.6,91]],.85);
 revolve(49.5,-21.6,91,[[0,0],[1.2,0],[1.9,2],[3.6,4.5],[3.6,10.5],[2.7,13.2],[1.5,14.6],[0,14.6]]);
 belt(49.5,-21.6,99,3.6,1.1);
 // Gauge, raised front dial, needle and three readable scale marks.
 cylinder(44.3,27.4,110.1,6.4,4.3,'x');
 cylinder(48.6,27.4,110.1,5.6,.45,'x');
 edge([49.1,27.4,110.1],[49.1,24.7,113]);
 for(const t of [-.7,.6,1.9])edge([49.1,27.4+4.5*Math.cos(t),110.1+4.5*Math.sin(t)],[49.1,27.4+5.1*Math.cos(t),110.1+5.1*Math.sin(t)]);
 // Calibration column with cap, lower connection and a sparse graduated scale.
 cylinder(61.9,41,61.5,1.65,32.7);
 for(const z of [61.5,63.5,90.2,92.2])cylinder(61.9,41,z,2.1,1.3,'z','frame');
 for(let z=67;z<=88;z+=3.5)edge([63.6,40.5,z],[63.6,41.5,z]);
 tube([[61.9,41,61.5],[61.9,41,37.1],[44.1,41,37.1]],.8);
}, {x:-51,y:-121,w:136,d:212,h:130}, {rotation:220,mirrorX:true,fixedCanvas:true});

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
