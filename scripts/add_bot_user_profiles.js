// Cria a tabela bot_user_profiles que guarda os dados pessoais por telefone
require('dotenv').config();
const db = require('../config/database');

(async () => {
    try {
        await db.query(`
            CREATE TABLE IF NOT EXISTS bot_user_profiles (
                id INT AUTO_INCREMENT PRIMARY KEY,
                telefone VARCHAR(50) NOT NULL UNIQUE,
                dados_json JSON NOT NULL,
                ultima_unidade_id INT NULL,
                criado_em TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
                atualizado_em TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
                INDEX idx_bup_unidade (ultima_unidade_id)
            ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci
        `);
        console.log('✓ Tabela bot_user_profiles criada/verificada');
        process.exit(0);
    } catch (e) {
        console.error('Erro:', e.message);
        process.exit(1);
    }
})();
