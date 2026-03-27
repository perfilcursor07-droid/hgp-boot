-- Adicionar suporte a mensagens de mídia no chat interno
ALTER TABLE chat_messages
    MODIFY COLUMN mensagem TEXT NULL DEFAULT NULL,
    ADD COLUMN message_type VARCHAR(50) DEFAULT 'text' AFTER mensagem,
    ADD COLUMN media_url VARCHAR(500) DEFAULT NULL,
    ADD COLUMN media_mime_type VARCHAR(100) DEFAULT NULL,
    ADD COLUMN media_filename VARCHAR(255) DEFAULT NULL;
