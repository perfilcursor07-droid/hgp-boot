// Corrige a constraint UNIQUE da tabela escalas para permitir
// múltiplas escalas na mesma data (uma por técnico).
require('dotenv').config();
const db = require('../config/database');

(async () => {
    try {
        try {
            await db.query('ALTER TABLE escalas DROP INDEX uniq_escalas_data');
            console.log('✓ Constraint antiga removida');
        } catch (e) {
            console.log('⊙', e.message);
        }
        try {
            await db.query('ALTER TABLE escalas ADD UNIQUE KEY uniq_escalas_data_admin (data_escala, admin_id)');
            console.log('✓ Nova constraint adicionada (data_escala + admin_id)');
        } catch (e) {
            console.log('⊙', e.message);
        }
        process.exit(0);
    } catch (e) {
        console.error(e);
        process.exit(1);
    }
})();
