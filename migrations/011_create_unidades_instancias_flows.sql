-- ═══════════════════════════════════════════════════════════════════
-- Migration 011: Multi-instância (Unidades, Instâncias, Fluxos)
-- ═══════════════════════════════════════════════════════════════════

-- Tabela de UNIDADES
CREATE TABLE IF NOT EXISTS unidades (
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
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- Tabela de FLUXOS DE BOT (definição em JSON)
CREATE TABLE IF NOT EXISTS bot_flows_v2 (
    id INT AUTO_INCREMENT PRIMARY KEY,
    nome VARCHAR(150) NOT NULL,
    descricao TEXT NULL,
    definicao_json LONGTEXT NOT NULL COMMENT 'Definição do fluxo em formato JSON',
    is_default BOOLEAN DEFAULT FALSE,
    ativo BOOLEAN DEFAULT TRUE,
    criado_em TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    atualizado_em TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
    INDEX idx_flows_v2_ativo (ativo)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- Tabela de INSTÂNCIAS (cada conexão WhatsApp)
CREATE TABLE IF NOT EXISTS instancias (
    id INT AUTO_INCREMENT PRIMARY KEY,
    nome VARCHAR(150) NOT NULL,
    session_name VARCHAR(100) NOT NULL UNIQUE,
    unidade_id INT NULL,
    flow_id INT NULL,
    status ENUM('disconnected','connecting','qr_ready','connected','error') DEFAULT 'disconnected',
    qr_code TEXT NULL,
    last_error TEXT NULL,
    last_connected TIMESTAMP NULL,
    is_legacy BOOLEAN DEFAULT FALSE COMMENT 'Marca a instância principal (admin-session)',
    ativo BOOLEAN DEFAULT TRUE,
    criado_em TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    atualizado_em TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
    FOREIGN KEY (unidade_id) REFERENCES unidades(id) ON DELETE SET NULL,
    FOREIGN KEY (flow_id) REFERENCES bot_flows_v2(id) ON DELETE SET NULL,
    INDEX idx_instancias_status (status),
    INDEX idx_instancias_session (session_name)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- Vínculo ADMIN <-> UNIDADE (técnico/gestor pertence a quais unidades)
CREATE TABLE IF NOT EXISTS admin_unidades (
    admin_id INT NOT NULL,
    unidade_id INT NOT NULL,
    PRIMARY KEY (admin_id, unidade_id),
    FOREIGN KEY (admin_id) REFERENCES admins(id) ON DELETE CASCADE,
    FOREIGN KEY (unidade_id) REFERENCES unidades(id) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- Adicionar unidade_id em chamados (pra saber de qual unidade veio)
SET @col = (SELECT COUNT(*) FROM INFORMATION_SCHEMA.COLUMNS WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'chamados' AND COLUMN_NAME = 'unidade_id');
SET @sql = IF(@col = 0, 'ALTER TABLE chamados ADD COLUMN unidade_id INT NULL AFTER setor, ADD INDEX idx_chamados_unidade (unidade_id)', 'SELECT "unidade_id já existe"');
PREPARE stmt FROM @sql; EXECUTE stmt; DEALLOCATE PREPARE stmt;

SET @col = (SELECT COUNT(*) FROM INFORMATION_SCHEMA.COLUMNS WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'chamados' AND COLUMN_NAME = 'instancia_id');
SET @sql = IF(@col = 0, 'ALTER TABLE chamados ADD COLUMN instancia_id INT NULL AFTER unidade_id', 'SELECT "instancia_id já existe"');
PREPARE stmt FROM @sql; EXECUTE stmt; DEALLOCATE PREPARE stmt;
