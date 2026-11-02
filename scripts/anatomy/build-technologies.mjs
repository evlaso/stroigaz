// Anatomy-based assembly-manual illustrations. Generic schematics, no dimensional claims.
import * as k from './iso-kit.mjs';
import { scene } from './line-scene.mjs';
const bounds=(p,h)=>k.boxCorners({...p,r:0},0,h);
// PRESS: base/feet, side frames, bed and die, upper ram, clamp row,
// hydraulic drives, rear stops, metal sheet, controller and foot switch.
{
 const s=scene(bounds({x:-160,y:-58,w:365,d:160},216),'Схема листогибочного пресса с пуансоном, матрицей, листом металла и пультом.');
 const {box,feet,face,panel,dot}=s;
 feet(-152,-45,304,104);box(-152,-45,304,104,12,18,3);
 box(-143,-39,286,70,30,142,2);
 for(const x of [-151,124]){box(x,-45,27,104,30,169,3);box(x+4,-40,19,94,199,13,2);}
 box(-123,35,247,28,42,37,1);box(-123,34,247,30,79,7,.5);
 box(-115,44,231,8,86,5,.2);box(-113,46,227,4,91,3,.1);
 // The bend sits between the lower die and raised punch.
 panel([[-112,51,94],[111,51,94],[111,91,94],[-112,91,94]]);
 panel([[-112,91,94],[111,91,94],[111,106,75],[-112,106,75]]);
 box(-120,34,240,23,130,53,1);
 for(let i=0;i<12;i++){const x=-116+i*19.4;box(x,57,16.5,4,134,12,.4);dot([x+8,61,141]);}
 box(-116,42,232,12,119,11,.3);
 // Tapered tool profile, closed faces and no shaded surfaces.
 panel([[-114,42,119],[114,42,119],[114,48,104],[-114,48,104]]);
 panel([[-114,54,119],[114,54,119],[114,48,104],[-114,48,104]]);
 for(const x of [-112,88]){box(x,-23,24,30,183,19,2);box(x+8,-15,8,14,202,10,.5);}
 box(-120,-32,240,10,208,4);
 // Suspended controller on the right-hand frame.
 box(152,8,27,8,169,6);box(175,7,8,8,124,51);box(170,15,34,16,105,35,2);
 box(174,31,26,1,117,19,.5);for(let i=0;i<3;i++)box(175+i*8,32,3,1,110,3,.2);
 box(144,83,29,20,0,5,2);box(147,85,23,15,5,5,1);
 for(const x of [-138,138])for(const z of [47,94,153,185])dot([x,59,z]);
 s.finish('bending');
}
// CLEANING: mobile source cabinet, top controls, ventilation, connector,
// service cable, handpiece in its cradle, supported sheet and cleared strip.
{
 const s=scene(bounds({x:-160,y:-55,w:330,d:170},124),'Схема комплекса лазерной очистки: источник, ручная головка и металлическая деталь на столе.');
 const {box,cabinet,table,cable,face,dot}=s;
 cable([[-94,9,65],[-71,9,65],[-66,9,18],[-56,17,8],[-25,23,8],[-7,23,28],[8,23,70],[17,23,78]]);
 cabinet(-156,-44,62,65,110);
 box(-148,21,45,1,84,18,.5);for(let i=0;i<3;i++)box(-146+i*13,22,5,1,77,4,.3);
 box(-163,-27,7,30,83,7,1);box(-160,-26,3,28,90,6,.5);
 table(-8,-35,169,133,65);
 box(9,-22,126,92,65,2,.5);
 face([[14,-17,67.1],[74,-17,67.1],[74,65,67.1],[14,65,67.1]]);
 // Sparse closed patches stand for the untreated portion of the sheet.
 for(const [x,y,w,d] of [[25,-5,11,6],[48,18,14,8],[29,43,17,6],[53,-8,8,7],[20,20,7,6]])face([[x,y,67.2],[x+w,y,67.2],[x+w,y+d,67.2],[x,y+d,67.2]]);
 box(4,15,14,18,67,8,.5);box(16,16,36,15,75,9,2);box(49,19,13,9,76,7,.6);
 box(20,20,8,8,67,8,.5);box(27,16,8,15,84,2,.3);
 for(const x of [0,153])for(const y of [-27,90])dot([x,y,65]);
 s.finish('laser-cleaning');
}
// WELDING: source cabinet, two-channel wire-feed assembly, supported spool,
// service cable, torch cradle, perforated welding table and two joined plates.
{
 const s=scene(bounds({x:-160,y:-70,w:330,d:175},151),'Схема комплекса лазерной сварки: источник, блок подачи проволоки, ручная горелка и детали на сварочном столе.');
 const {box,cabinet,table,cable,face,panel,dot,ring}=s;
 cable([[-95,-10,88],[-77,-10,88],[-73,-10,28],[-51,-8,9],[-24,2,9],[-6,8,27],[7,8,73],[35,8,85]]);
 cabinet(-157,-49,62,63,100);
 box(-147,-39,42,40,100,18,2);box(-140,-33,28,28,118,5,.5);
 box(-138,-31,24,24,123,4,.4);box(-136,-29,20,20,127,15,2);
 for(const x of [-130,-119]){box(x,-23,4,8,142,5,.4);dot([x+2,-19,147]);}
 box(-149,14,44,1,74,20,.5);for(let i=0;i<4;i++)box(-146+i*10,15,4,1,66,4,.3);
 table(-10,-50,175,142,68);
 for(let x=4;x<157;x+=18)for(let y=-38;y<84;y+=18)ring(x,y,1.2,68.1);
 box(45,-16,80,66,68,2,.2);box(45,15,80,2,70,28,.3);
 // Handpiece in a real cradle, nozzle aimed at the supported seam.
 box(23,-1,15,18,68,10,.5);box(34,0,28,15,78,12,2);box(60,3,17,9,81,6,.5);box(75,5,11,5,82,4,.2);
 box(39,4,7,8,70,8,.3);box(42,0,6,15,90,2,.3);
 for(const x of [49,111]){box(x,46,10,10,70,5,.5);box(x+3,42,4,10,75,8,.3);}
 s.finish('laser-welding');
}
// COATING: open booth, rear filters, side walls, floor grating, hanging
// workpiece and its rail, extraction housing, wheeled spray unit and gun.
{
 const s=scene(bounds({x:-172,y:-60,w:358,d:190},180),'Схема подготовки и окраски: открытая камера с подвешенной деталью, фильтрами и окрасочным аппаратом.');
 const {box,feet,face,panel,cabinet,cable,dot}=s;
 feet(-112,-55,184,133);box(-112,-55,184,133,12,8);
 box(-112,-55,184,5,20,145);box(-112,-50,5,128,20,145);
 for(let x=-100;x<65;x+=18)box(x,-43,3,112,20,3,.1);
 // Filter panels are mounted on the booth's rear wall.
 for(const x of [-99,-48,3]){box(x,-50,44,2,41,101,.3);for(let z=50;z<139;z+=13)box(x+3,-48,38,1,z,2,.1);}
 box(-107,-50,173,7,165,10);box(-111,-50,8,128,165,10);box(64,-50,8,128,165,10);
 box(-93,11,146,7,171,5,.5);
 for(const x of [-67,13]){box(x,13,2,3,136,35,.1);box(x-3,12,8,5,132,4,.3);}
 box(-76,13,104,3,62,70,.4);
 // Near-side booth wall, with a narrow front upright and sill.
 box(67,-50,5,128,20,145);box(-112,71,8,7,20,145);box(-112,71,184,7,20,5);
 // External extraction cabinet: mounted on the booth side, not floating.
 box(72,-40,43,81,12,103,2);box(77,-36,33,72,115,4,.6);
 for(let i=0;i<5;i++)box(114,-30+i*12,1,6,34,62,.2);
 cable([[143,89,60],[130,89,60],[124,89,12],[99,96,7],[66,99,7],[40,99,16],[7,96,60],[-2,96,69]]);
 cabinet(143,61,39,43,77);
 box(149,104,27,1,56,16,.4);box(151,105,5,1,48,4,.2);
 // Spray gun and support, at the booth entrance.
 box(-21,84,32,26,0,4,1);box(-9,94,6,6,4,55,.5);box(-13,88,15,18,59,6,.5);
 box(-3,89,25,11,65,9,1);box(20,92,12,5,67,5,.3);box(1,92,6,6,56,9,.4);
 box(2,88,11,13,74,13,1);box(3,89,9,11,87,2,.5);
 s.finish('surface-coating');
}
