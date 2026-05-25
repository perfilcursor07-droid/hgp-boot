-- ═══════════════════════════════════════════════════════════════════
-- Migration 012: Presets de turnos por unidade
-- Cada unidade pode ter seus próprios horários (ex: HGP 07-19, SESAU 08-14)
-- ═══════════════════════════════════════════════════════════════════

CREATE TABLE IF NOT EXISTS unidade_turnos_presets (
    id INT AUTO_INCREMENT PRIMARY KEY,
    unidade_id INT NOT NULL,
    chave VARCHAR(50) NOT NULL COMMENT 'Identificador interno (ex: manha, tarde, integral)',
    label VARCHAR(100) NOT NULL COMMENT 'Texto exibido no menu (ex: "Manhã (08:00-14:00)")',
    icone VARCHAR(20) DEFAULT '🕐',
    hora_inicio TIME NOT NULL,
    hora_fim TIME NOT NULL,
    ordem INT DEFAULT 0,
    ativo BOOLEAN DEFAULT TRUE,
    criado_em TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    atualizado_em TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
    UNIQUE KEY uk_unidade_chave (unidade_id, chave),
    INDEX idx_presets_unidade (unidade_id),
    FOREIGN KEY (unidade_id) REFERENCES unidades(id) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;
