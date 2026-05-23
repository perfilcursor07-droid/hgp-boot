-- Adicionar campo de resposta do técnico na tabela de avaliações
SET @dbname = DATABASE();
SET @tablename = 'avaliacoes';

SET @col_exists = (SELECT COUNT(*) FROM INFORMATION_SCHEMA.COLUMNS 
    WHERE TABLE_SCHEMA = @dbname AND TABLE_NAME = @tablename AND COLUMN_NAME = 'resposta_tecnico');
SET @sql = IF(@col_exists = 0, 
    'ALTER TABLE avaliacoes ADD COLUMN resposta_tecnico TEXT NULL AFTER chat_origem', 
    'SELECT "Column resposta_tecnico already exists"');
PREPARE stmt FROM @sql; EXECUTE stmt; DEALLOCATE PREPARE stmt;

SET @col_exists = (SELECT COUNT(*) FROM INFORMATION_SCHEMA.COLUMNS 
    WHERE TABLE_SCHEMA = @dbname AND TABLE_NAME = @tablename AND COLUMN_NAME = 'respondido_por');
SET @sql = IF(@col_exists = 0, 
    'ALTER TABLE avaliacoes ADD COLUMN respondido_por VARCHAR(255) NULL AFTER resposta_tecnico', 
    'SELECT "Column respondido_por already exists"');
PREPARE stmt FROM @sql; EXECUTE stmt; DEALLOCATE PREPARE stmt;

SET @col_exists = (SELECT COUNT(*) FROM INFORMATION_SCHEMA.COLUMNS 
    WHERE TABLE_SCHEMA = @dbname AND TABLE_NAME = @tablename AND COLUMN_NAME = 'respondido_em');
SET @sql = IF(@col_exists = 0, 
    'ALTER TABLE avaliacoes ADD COLUMN respondido_em TIMESTAMP NULL AFTER respondido_por', 
    'SELECT "Column respondido_em already exists"');
PREPARE stmt FROM @sql; EXECUTE stmt; DEALLOCATE PREPARE stmt;
