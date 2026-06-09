-- ═══════════════════════════════════════════════════════════════════
-- Migration 014: Locais (sub-unidades) por unidade
-- Permite filtrar chamados por local dentro de uma unidade
-- Ex: SESAU -> SES-SEDE, SVO, SER, ANEXO I, ANEXO VII, etc.
-- ═══════════════════════════════════════════════════════════════════

-- Tabela de locais por unidade
CREATE TABLE IF NOT EXISTS unidade_locais (
    id INT AUTO_INCREMENT PRIMARY KEY,
    unidade_id INT NOT NULL,
    nome VARCHAR(150) NOT NULL,
    codigo VARCHAR(50) NULL COMMENT 'Código curto para match com fluxo do bot',
    ativo BOOLEAN DEFAULT TRUE,
    criado_em TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    UNIQUE KEY uk_unidade_local (unidade_id, nome),
    INDEX idx_locais_unidade (unidade_id),
    FOREIGN KEY (unidade_id) REFERENCES unidades(id) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- Vínculo admin <-> locais (um técnico pode estar em vários locais)
CREATE TABLE IF NOT EXISTS admin_locais (
    admin_id INT NOT NULL,
    local_id INT NOT NULL,
    PRIMARY KEY (admin_id, local_id),
    FOREIGN KEY (admin_id) REFERENCES admins(id) ON DELETE CASCADE,
    FOREIGN KEY (local_id) REFERENCES unidade_locais(id) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- Adicionar local_id na tabela de chamados (opcional, NULL = sem local específico)
SET @col = (SELECT COUNT(*) FROM INFORMATION_SCHEMA.COLUMNS WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'chamados' AND COLUMN_NAME = 'local_id');
SET @sql = IF(@col = 0, 'ALTER TABLE chamados ADD COLUMN local_id INT NULL AFTER unidade_id, ADD INDEX idx_chamados_local (local_id)', 'SELECT "local_id já existe"');
PREPARE stmt FROM @sql; EXECUTE stmt; DEALLOCATE PREPARE stmt;
