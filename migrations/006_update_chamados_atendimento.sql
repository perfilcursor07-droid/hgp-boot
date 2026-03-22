-- Adicionar campos de atendimento na tabela de chamados (ignora se já existir)
SET @dbname = DATABASE();
SET @tablename = 'chamados';

SET @col_exists = (SELECT COUNT(*) FROM INFORMATION_SCHEMA.COLUMNS 
    WHERE TABLE_SCHEMA = @dbname AND TABLE_NAME = @tablename AND COLUMN_NAME = 'atendente_id');
SET @sql = IF(@col_exists = 0, 
    'ALTER TABLE chamados ADD COLUMN atendente_id INT NULL AFTER tecnico_telefone', 
    'SELECT "Column atendente_id already exists"');
PREPARE stmt FROM @sql; EXECUTE stmt; DEALLOCATE PREPARE stmt;

SET @col_exists = (SELECT COUNT(*) FROM INFORMATION_SCHEMA.COLUMNS 
    WHERE TABLE_SCHEMA = @dbname AND TABLE_NAME = @tablename AND COLUMN_NAME = 'atendente_nome');
SET @sql = IF(@col_exists = 0, 
    'ALTER TABLE chamados ADD COLUMN atendente_nome VARCHAR(255) NULL AFTER atendente_id', 
    'SELECT "Column atendente_nome already exists"');
PREPARE stmt FROM @sql; EXECUTE stmt; DEALLOCATE PREPARE stmt;

SET @col_exists = (SELECT COUNT(*) FROM INFORMATION_SCHEMA.COLUMNS 
    WHERE TABLE_SCHEMA = @dbname AND TABLE_NAME = @tablename AND COLUMN_NAME = 'iniciado_em');
SET @sql = IF(@col_exists = 0, 
    'ALTER TABLE chamados ADD COLUMN iniciado_em TIMESTAMP NULL AFTER atribuido_em', 
    'SELECT "Column iniciado_em already exists"');
PREPARE stmt FROM @sql; EXECUTE stmt; DEALLOCATE PREPARE stmt;

SET @col_exists = (SELECT COUNT(*) FROM INFORMATION_SCHEMA.COLUMNS 
    WHERE TABLE_SCHEMA = @dbname AND TABLE_NAME = @tablename AND COLUMN_NAME = 'encerrado_em');
SET @sql = IF(@col_exists = 0, 
    'ALTER TABLE chamados ADD COLUMN encerrado_em TIMESTAMP NULL AFTER iniciado_em', 
    'SELECT "Column encerrado_em already exists"');
PREPARE stmt FROM @sql; EXECUTE stmt; DEALLOCATE PREPARE stmt;

SET @col_exists = (SELECT COUNT(*) FROM INFORMATION_SCHEMA.COLUMNS 
    WHERE TABLE_SCHEMA = @dbname AND TABLE_NAME = @tablename AND COLUMN_NAME = 'observacoes');
SET @sql = IF(@col_exists = 0, 
    'ALTER TABLE chamados ADD COLUMN observacoes TEXT NULL AFTER encerrado_em', 
    'SELECT "Column observacoes already exists"');
PREPARE stmt FROM @sql; EXECUTE stmt; DEALLOCATE PREPARE stmt;

-- Adicionar foreign key se não existir
SET @fk_exists = (SELECT COUNT(*) FROM information_schema.TABLE_CONSTRAINTS 
    WHERE CONSTRAINT_SCHEMA = DATABASE() 
    AND TABLE_NAME = 'chamados' 
    AND CONSTRAINT_NAME = 'chamados_ibfk_2');

SET @sql = IF(@fk_exists = 0, 
    'ALTER TABLE chamados ADD FOREIGN KEY (atendente_id) REFERENCES admins(id) ON DELETE SET NULL', 
    'SELECT "Foreign key already exists"');

PREPARE stmt FROM @sql;
EXECUTE stmt;
DEALLOCATE PREPARE stmt;

-- Atualizar status para incluir 'em_atendimento'
ALTER TABLE chamados
MODIFY COLUMN status ENUM('pendente', 'aberto', 'em_atendimento', 'finalizado') DEFAULT 'pendente';
