// Cria um trigger que define unidade_id = HGP automaticamente para
// chamados novos que vierem sem unidade_id e sem instancia_id (bot legado)
require('dotenv').config();
const db = require('../config/database');

(async () => {
    try {
        // Pegar o id da unidade HGP
        const [hgp] = await db.query("SELECT id FROM unidades WHERE codigo = 'HGP' LIMIT 1");
        if (hgp.length === 0) {
            console.error('Unidade HGP não encontrada. Rode antes: node scripts/seed_hgp_unidade.js');
            process.exit(1);
        }
        const hgpId = hgp[0].id;

        // Drop se já existir
        await db.query('DROP TRIGGER IF EXISTS trg_chamados_default_hgp');

        // Criar trigger BEFORE INSERT
        await db.query(`
            CREATE TRIGGER trg_chamados_default_hgp
            BEFORE INSERT ON chamados
            FOR EACH ROW
            BEGIN
                IF NEW.unidade_id IS NULL AND NEW.instancia_id IS NULL THEN
                    SET NEW.unidade_id = ${hgpId};
                END IF;
            END
        `);

        console.log(`✓ Trigger criado: chamados sem unidade_id/instancia_id serão automaticamente HGP (id=${hgpId})`);
        process.exit(0);
    } catch (e) {
        console.error('Erro:', e.message);
        process.exit(1);
    }
})();
