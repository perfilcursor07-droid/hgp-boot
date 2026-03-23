ALTER TABLE admins
    ADD COLUMN IF NOT EXISTS nome_completo VARCHAR(150) NULL AFTER username,
    ADD COLUMN IF NOT EXISTS cpf VARCHAR(20) NULL AFTER nome_completo,
    ADD COLUMN IF NOT EXISTS telefone VARCHAR(30) NULL AFTER cpf,
    ADD COLUMN IF NOT EXISTS nivel_acesso VARCHAR(20) NOT NULL DEFAULT 'administrador' AFTER telefone,
    ADD COLUMN IF NOT EXISTS ativo BOOLEAN NOT NULL DEFAULT TRUE AFTER password;

ALTER TABLE admins
    ADD UNIQUE INDEX IF NOT EXISTS idx_admins_cpf (cpf);

UPDATE admins
SET nome_completo = COALESCE(NULLIF(nome_completo, ''), 'Administrador'),
    nivel_acesso = COALESCE(NULLIF(nivel_acesso, ''), 'administrador'),
    ativo = COALESCE(ativo, TRUE)
WHERE username = 'admin';