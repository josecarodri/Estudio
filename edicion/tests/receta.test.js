/*
 * Pruebas de la validación de recetas (edicion/recipe.js): tiempos, media, cortes,
 * reencuadre y claves desconocidas. Lo propio del montaje (fundidos, velocidad, pistas…)
 * se prueba también en kdenlive.test.js.
 */
const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');

const R = require(path.join(__dirname, '..', 'recipe.js'));

function recetaValida() {
  return {
    project: { name: 'P', fps: 30 },
    media: [{ id: 'a', path: '/v/a.mp4' }, { id: 'b', path: '/v/b.mp4' }],
    timeline: { name: 'T' },
    edit: [
      { clip: 'a', in: '00:00:01:00', out: '00:00:02:00' },
      { clip: 'b', duration: '2s' },
    ],
  };
}

// ------------------------------------------------------------------ timecode

test('isTimecode acepta las formas documentadas', () => {
  for (const v of ['00:00:01:00', '01:02:03:04', '00:10', '00:00:02', '2s', '2.5s',
    '120', 120, 0, '00;00;01;00']) {
    assert.equal(R.isTimecode(v), true, `debería aceptar ${JSON.stringify(v)}`);
  }
});

test('isTimecode rechaza lo que no es un tiempo', () => {
  for (const v of ['', '  ', 'mañana', '1:2:3:4:5', -5, 1.5, null, undefined, {}, [],
    '00:00:01:', 'abc:def']) {
    assert.equal(R.isTimecode(v), false, `debería rechazar ${JSON.stringify(v)}`);
  }
});

// ---------------------------------------------------------------- validación

test('una receta correcta no da errores ni avisos', () => {
  const { errors, warnings } = R.validate(recetaValida());
  assert.deepEqual(errors, []);
  assert.deepEqual(warnings, []);
});

test('la receta tiene que ser un objeto', () => {
  for (const v of [null, 'texto', 42, []]) {
    assert.equal(R.validate(v).errors.length, 1);
  }
});

test('exige id y path en media, y no admite ids repetidos', () => {
  let e = R.validate({ media: [{ path: '/v/a.mp4' }] }).errors;
  assert.ok(e.some((m) => m.includes('media[0].id')));

  e = R.validate({ media: [{ id: 'a' }] }).errors;
  assert.ok(e.some((m) => m.includes('media[0].path')));

  e = R.validate({ media: [{ id: 'a', path: '/1.mp4' }, { id: 'a', path: '/2.mp4' }] }).errors;
  assert.ok(e.some((m) => m.includes('duplicado')));
});

test('avisa si una ruta de media no es absoluta', () => {
  const { warnings } = R.validate({ media: [{ id: 'a', path: 'clip.mp4' }] });
  assert.ok(warnings.some((m) => m.includes('no parece una ruta absoluta')));
});

test('acepta rutas absolutas de Windows y UNC', () => {
  const { warnings } = R.validate({
    media: [
      { id: 'a', path: 'C:\\Videos\\a.mp4' },
      { id: 'b', path: '\\\\servidor\\share\\b.mp4' },
    ],
  });
  assert.deepEqual(warnings.filter((m) => m.includes('ruta absoluta')), []);
});

test('un corte no puede apuntar a un clip que no está en media', () => {
  const r = recetaValida();
  r.edit.push({ clip: 'fantasma' });
  const { errors } = R.validate(r);
  assert.ok(errors.some((m) => m.includes('fantasma') && m.includes('no está en media')));
});

test('detecta out antes de in y pistas inválidas', () => {
  let e = R.validate({
    media: [{ id: 'a', path: '/a.mp4' }],
    edit: [{ clip: 'a', in: 100, out: 50 }],
  }).errors;
  assert.ok(e.some((m) => m.includes('out (50) va antes que in (100)')));

  e = R.validate({
    media: [{ id: 'a', path: '/a.mp4' }],
    edit: [{ clip: 'a', track: 0 }, { clip: 'a', track: 1.5 }],
  }).errors;
  assert.equal(e.filter((m) => m.includes('.track')).length, 2);
});

test('rechaza timecodes mal escritos indicando el campo', () => {
  const { errors } = R.validate({
    media: [{ id: 'a', path: '/a.mp4' }],
    edit: [{ clip: 'a', in: 'cuando empiece' }],
  });
  assert.ok(errors.some((m) => m.startsWith('edit[0].in:')));
});

test('transform.index tiene que existir en edit', () => {
  const r = recetaValida();
  r.transform = [{ index: 9, zoom: 2 }];
  const { errors } = R.validate(r);
  assert.ok(errors.some((m) => m.includes('no existe: edit[] tiene 2 corte(s)')));

  r.transform = [{ index: 0 }];
  assert.ok(R.validate(r).errors.some((m) => m.includes('entero >= 1')));
});

test('opacity va de 0 a 100 y los valores de transform son números', () => {
  const r = recetaValida();
  r.transform = [{ index: 1, opacity: 150 }, { index: 2, zoom: 'mucho' }];
  const { errors } = R.validate(r);
  assert.ok(errors.some((m) => m.includes('opacity va de 0 a 100')));
  assert.ok(errors.some((m) => m.includes('zoom debe ser un número')));
});

test('las claves desconocidas son avisos, no errores', () => {
  const r = recetaValida();
  r.inventada = 1;
  r.project.inventada = 2;
  r.edit[0].inventada = 3;
  const { errors, warnings } = R.validate(r);
  assert.deepEqual(errors, []);
  assert.equal(warnings.filter((m) => m.includes('inventada')).length, 3);
});

test('los títulos todavía no se hacen: se avisa y se ignoran', () => {
  const r = recetaValida();
  r.titles = [{ at: 0, text: 'x' }];
  const { errors, warnings } = R.validate(r);
  assert.deepEqual(errors, []);
  assert.ok(warnings.some((m) => m.includes('títulos todavía no')));
});

test('lo que no sirve para montar (export, render) se avisa como desconocido y se ignora', () => {
  const r = recetaValida();
  r.export = { path: '/x.csv' };
  r.render = { dir: '/x', name: 'y' };
  const { errors, warnings } = R.validate(r);
  assert.deepEqual(errors, []);
  assert.equal(warnings.filter((m) => /clave desconocida "(export|render)"/.test(m)).length, 2);
});

test('avisa de un color de guía que Kdenlive no conoce', () => {
  const r = recetaValida();
  r.guides = [{ at: 0, color: 'Red' }, { at: 10, color: 'Fucsia' }];
  const { errors, warnings } = R.validate(r);
  assert.deepEqual(errors, []);
  assert.equal(warnings.filter((m) => m.includes('no es un color de guía')).length, 1);
});

test('transform admite speed y lo exige positivo', () => {
  const r = recetaValida();
  r.transform = [{ index: 1, speed: 2 }];
  assert.deepEqual(R.validate(r).errors, []);
  r.transform = [{ index: 1, speed: 0 }];
  assert.ok(R.validate(r).errors.some((m) => m.includes('speed debe ser mayor que 0')));
});
