-- Tabela para armazenar mensagens do chat entre técnicos e solicitantes
CREATE TABLE IF NOT EXISTS chat_messages (
    id INT AUTO_INCREMENT PRIMARY KEY,
    chamado_id INT NOT NULL,
    remetente_tipo ENUM('solicitante', 'tecnico', 'sistema') NOT NULL,
    remetente_nome VARCHAR(255),
    mensagem TEXT NOT NULL,
    enviada_em TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    lida BOOLEAN DEFAULT FALSE,
    INDEX idx_chamado (chamado_id),
    INDEX idx_enviada (enviada_em)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- Adicionar foreign key após criar a tabela
ALTER TABLE chat_messages
ADD CONSTRAINT fk_chat_chamado
FOREIGN KEY (chamado_id) REFERENCES chamados(id) ON DELETE CASCADE;
