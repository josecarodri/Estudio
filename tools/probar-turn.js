#!/usr/bin/env node
'use strict';
// Comprueba la configuración TURN de .env: npm run probar-turn
const { iceServers, hasTurn } = require('../server');

(async () => {
  if (!hasTurn()) {
    console.log('✗ No hay ningún servidor TURN configurado en .env (ver .env.ejemplo).');
    process.exit(1);
  }
  const list = await iceServers();
  const turn = list.filter((s) => s.username);
  if (!turn.length) {
    console.log('✗ No se pudieron obtener credenciales TURN. Revisa que los valores de .env estén bien copiados');
    console.log('  (sin espacios ni comillas) y que el PC tenga conexión a internet.');
    process.exit(1);
  }
  console.log('✓ TURN configurado correctamente. Servidores:');
  for (const s of turn) for (const u of [].concat(s.urls)) console.log(`   ${u}`);
})().catch((err) => { console.error(`✗ ${err.message}`); process.exit(1); });
