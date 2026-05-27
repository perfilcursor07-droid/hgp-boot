-- Migration 013: Adicionar email e cpf_solicitante na tabela chamados
ALTER TABLE chamados
    ADD COLUMN IF NOT EXISTS email VARCHAR(150) NULL AFTER telefone_contato,
    ADD COLUMN IF NOT EXISTS cpf_solicitante VARCHAR(20) NULL AFTER email;
