import { test } from 'node:test';
import assert from 'node:assert/strict';
import { indexStep, argumentsOf, references, stepFragment, planFragments } from '../src/step-partition.ts';

function step(rows: string): string { return `ISO-10303-21;\nHEADER;FILE_SCHEMA(('CONFIG_CONTROL_DESIGN'));ENDSEC;\nDATA;\n${rows}\nENDSEC;END-ISO-10303-21;`; }
const source = step(`
#1=PRODUCT_DEFINITION('root','',#2,#3);
#2=PRODUCT_DEFINITION_FORMATION('','',#4);
#3=PRODUCT_DEFINITION_CONTEXT('',#5,'');
#4=PRODUCT('root','','',());
#5=APPLICATION_CONTEXT('');
#6=SHAPE_DEFINITION_REPRESENTATION(#7,#8);
#7=PRODUCT_DEFINITION_SHAPE('','',#1);
#8=SHAPE_REPRESENTATION('',(#9),#10);
#9=AXIS2_PLACEMENT_3D('',#11,$,$);
#10=GEOMETRIC_REPRESENTATION_CONTEXT(3);
#11=CARTESIAN_POINT('',(0.,0.,0.));
#12=PRODUCT_DEFINITION('child a','',#2,#3);
#13=PRODUCT_DEFINITION('child b','',#2,#3);
#14=NEXT_ASSEMBLY_USAGE_OCCURRENCE('a','','',#1,#12,$);
#15=NEXT_ASSEMBLY_USAGE_OCCURRENCE('b','','',#1,#13,$);
#16=SHAPE_DEFINITION_REPRESENTATION(#17,#18);
#17=PRODUCT_DEFINITION_SHAPE('','',#12);
#18=ADVANCED_BREP_SHAPE_REPRESENTATION('',(#19),#10);
#19=MANIFOLD_SOLID_BREP('a',#20);
#20=CLOSED_SHELL('',());
#21=SHAPE_DEFINITION_REPRESENTATION(#22,#23);
#22=PRODUCT_DEFINITION_SHAPE('','',#13);
#23=MANIFOLD_SURFACE_SHAPE_REPRESENTATION('',(#24),#10);
#24=SHELL_BASED_SURFACE_MODEL('',(#25,#26));
#25=OPEN_SHELL('shell 1',());
#26=OPEN_SHELL('shell 2',());
#27=STYLED_ITEM('',(#28),#19);
#28=PRESENTATION_STYLE_ASSIGNMENT(());
#29=STYLED_ITEM('',(#28),#25);
#30=STYLED_ITEM('',(#28),#26);
#31=MECHANICAL_DESIGN_GEOMETRIC_PRESENTATION_REPRESENTATION('',(#27,#29,#30),#10);
#32=PRESENTATION_LAYER_ASSIGNMENT('','',(#27,#29,#30));
`);

test('ссылки и аргументы не читаются внутри строк STEP', () => {
  assert.deepEqual(references("FUNC('some #300; it''s a name',(#1,#2),#4)"), [1, 2, 4]);
  assert.deepEqual(argumentsOf("FUNC('a,b',(#1,#2),#4)"), ["'a,b'", '(#1,#2)', '#4']);
});

test('индексация с inline-комментарием и точкой с запятой в имени', () => {
  const i = indexStep(source.replace("'child a'", "'child; #555 a'").replace("MANIFOLD_SOLID_BREP('a',", "MANIFOLD_SOLID_BREP(/* #999; */'a',"));
  assert.deepEqual(i.atoms, [19, 25, 26]);
  assert.equal(planFragments(i, 1).length, 3);
  assert.throws(() => indexStep(step('#1=PRODUCT(#999);')), /не найдена/);
  assert.throws(() => indexStep(step('#999999999=PRODUCT();')), /большой ID/);
  assert.throws(() => indexStep(source.replace('ENDSEC;END-ISO', 'END-ISO')), /STEP DATA|Незавершённый/);
});

test('фрагмент сохраняет выбранное тело, имя, цвет и предков, но не соседей', () => {
  const index = indexStep(source);
  const fragment = stepFragment(index, [19]);
  const i = indexStep(fragment.text);
  assert.ok(i.records[1], 'родительская сборка');
  assert.ok(i.records[12] && i.records[14], 'выбранная деталь и assembly occurrence');
  assert.ok(i.records[19] && i.records[27], 'BREP и стиль');
  assert.equal(i.records[13], undefined, 'соседняя деталь удалена');
  assert.equal(i.records[15], undefined, 'соседнее размещение удалено');
  assert.equal(i.records[24], undefined);
  assert.deepEqual(references(i.records[31]!), [27, 10]);
  assert.deepEqual(references(i.records[32]!), [27]);
});

test('surface model делится по независимым оболочкам, без разрезания solid', () => {
  const i = indexStep(stepFragment(indexStep(source), [25]).text);
  assert.equal(i.records[19], undefined);
  assert.ok(i.records[13] && i.records[15]);
  assert.deepEqual(references(i.records[24]!), [25]);
  assert.equal(i.records[26], undefined);
  assert.deepEqual(references(i.records[31]!), [29, 10]);
});
