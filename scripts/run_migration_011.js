// Roda a migration 011 com queries individuais
require('dotenv').config();
const db = require('../config/database');

const STATEMENTS = [
    `CREATE TABLE IF NOT EXISTS unidades (
        id INT AUTO_INCREMENT PRIMARY KEY,
        nome VARCHAR(150) NOT NULL,
        codigo VARCHAR(50) NOT NULL UNIQUE,
        descricao TEXT NULL,
        cor VARCHAR(20) DEFAULT '#25d366',
        ativo BOOLEAN DEFAULT TRUE,
        criado_em TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
        atualizado_em TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
        INDEX idx_unidades_codigo (codigo),
        INDEX idx_unidades_ativo (ativo)
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci`,

    `CREATE TABLE IF NOT EXISTS bot_flows_v2 (
        id INT AUTO_INCREMENT PRIMARY KEY,
        nome VARCHAR(150) NOT NULL,
        descricao TEXT NULL,
        definicao_json LONGTEXT NOT NULL,
        is_default BOOLEAN DEFAULT FALSE,
        ativo BOOLEAN DEFAULT TRUE,
        criado_em TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
        atualizado_em TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
        INDEX idx_flows_v2_ativo (ativo)
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci`,

    `CREATE TABLE IF NOT EXISTS instancias (
        id INT AUTO_INCREMENT PRIMARY KEY,
        nome VARCHAR(150) NOT NULL,
        session_name VARCHAR(100) NOT NULL UNIQUE,
        unidade_id INT NULL,
        flow_id INT NULL,
        status ENUM('disconnected','connecting','qr_ready','connected','error') DEFAULT 'disconnected',
        qr_code TEXT NULL,
        last_error TEXT NULL,
        last_connected TIMESTAMP NULL,
        is_legacy BOOLEAN DEFAULT FALSE,
        ativo BOOLEAN DEFAULT TRUE,
        criado_em TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
        atualizado_em TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
        FOREIGN KEY (unidade_id) REFERENCES unidades(id) ON DELETE SET NULL,
        FOREIGN KEY (flow_id) REFERENCES bot_flows_v2(id) ON DELETE SET NULL,
        INDEX idx_instancias_status (status),
        INDEX idx_instancias_session (session_name)
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci`,

    `CREATE TABLE IF NOT EXISTS admin_unidades (
        admin_id INT NOT NULL,
        unidade_id INT NOT NULL,
        PRIMARY KEY (admin_id, unidade_id),
        FOREIGN KEY (admin_id) REFERENCES admins(id) ON DELETE CASCADE,
        FOREIGN KEY (unidade_id) REFERENCES unidades(id) ON DELETE CASCADE
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci`,
];

(async () => {
    try {
        for (const stmt of STATEMENTS) {
            try {
                await db.query(stmt);
                const tableName = stmt.match(/CREATE TABLE.*?(\w+)\s*\(/i)?.[1] || 'tabela';
                console.log('✓ Tabela', tableName);
            } catch (err) {
                console.error('✗', err.message);
            }
        }

        // Adicionar colunas em chamados
        const checkColumn = async (col) => {
            const [rows] = await db.query(
                `SELECT COUNT(*) AS c FROM INFORMATION_SCHEMA.COLUMNS WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'chamados' AND COLUMN_NAME = ?`,
                [col]
            );
            return rows[0].c > 0;
        };

        if (!(await checkColumn('unidade_id'))) {
            await db.query(`ALTER TABLE chamados ADD COLUMN unidade_id INT NULL AFTER setor`);
            await db.query(`ALTER TABLE chamados ADD INDEX idx_chamados_unidade (unidade_id)`).catch(() => {});
            console.log('✓ Coluna chamados.unidade_id adicionada');
        } else {
            console.log('⊙ chamados.unidade_id já existe');
        }

        if (!(await checkColumn('instancia_id'))) {
            await db.query(`ALTER TABLE chamados ADD COLUMN instancia_id INT NULL AFTER unidade_id`);
            console.log('✓ Coluna chamados.instancia_id adicionada');
        } else {
            console.log('⊙ chamados.instancia_id já existe');
        }

        // Registrar a instância legada (admin-session) se ainda não existir
        const [legacy] = await db.query(`SELECT id FROM instancias WHERE session_name = 'admin-session'`);
        if (legacy.length === 0) {
            await db.query(
                `INSERT INTO instancias (nome, session_name, status, is_legacy, ativo)
                 VALUES (?, 'admin-session', 'disconnected', TRUE, TRUE)`,
                ['Instância Principal (Legada)']
            );
            console.log('✓ Instância legada registrada');
        } else {
            console.log('⊙ Instância legada já registrada');
        }

        console.log('\n✅ Migration concluída.');
        process.exit(0);
    } catch (e) {
        console.error('Erro:', e);
        process.exit(1);
    }
})();
