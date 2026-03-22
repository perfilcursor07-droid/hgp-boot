-- Adicionar campo telefone_whatsapp na tabela chamados
ALTER TABLE chamados
ADD COLUMN telefone_whatsapp VARCHAR(50) NULL AFTER nome_whatsapp;
