async function columnExists(connection, tableName, columnName) {
    const [rows] = await connection.query(
        `SELECT 1
         FROM information_schema.COLUMNS
         WHERE TABLE_SCHEMA = DATABASE()
           AND TABLE_NAME = ?
           AND COLUMN_NAME = ?
         LIMIT 1`,
        [tableName, columnName]
    );

    return rows.length > 0;
}

async function indexExists(connection, tableName, indexName) {
    const [rows] = await connection.query(
        `SELECT 1
         FROM information_schema.STATISTICS
         WHERE TABLE_SCHEMA = DATABASE()
           AND TABLE_NAME = ?
           AND INDEX_NAME = ?
         LIMIT 1`,
        [tableName, indexName]
    );

    return rows.length > 0;
}

async function foreignKeyExists(connection, tableName, constraintName) {
    const [rows] = await connection.query(
        `SELECT 1
         FROM information_schema.TABLE_CONSTRAINTS
         WHERE CONSTRAINT_SCHEMA = DATABASE()
           AND TABLE_NAME = ?
           AND CONSTRAINT_NAME = ?
           AND CONSTRAINT_TYPE = 'FOREIGN KEY'
         LIMIT 1`,
        [tableName, constraintName]
    );

    return rows.length > 0;
}

async function ensureColumn(connection, tableName, columnName, definition) {
    if (await columnExists(connection, tableName, columnName)) {
        return false;
    }

    await connection.query(`ALTER TABLE ${tableName} ADD COLUMN ${columnName} ${definition}`);
    return true;
}

async function ensureIndex(connection, tableName, indexName, definition) {
    if (await indexExists(connection, tableName, indexName)) {
        return false;
    }

    await connection.query(`ALTER TABLE ${tableName} ADD ${definition}`);
    return true;
}

async function ensureForeignKey(connection, tableName, constraintName, definition) {
    if (await foreignKeyExists(connection, tableName, constraintName)) {
        return false;
    }

    await connection.query(`ALTER TABLE ${tableName} ADD CONSTRAINT ${constraintName} ${definition}`);
    return true;
}

async function ensureSchema(connection) {
    const changes = [];

    await connection.query(`
        CREATE TABLE IF NOT EXISTS admins (
            id INT AUTO_INCREMENT PRIMARY KEY,
            username VARCHAR(50) UNIQUE NOT NULL,
            nome_completo VARCHAR(150) NULL,
            cpf VARCHAR(20) UNIQUE NULL,
            telefone VARCHAR(30) NULL,
            nivel_acesso VARCHAR(20) NOT NULL DEFAULT 'administrador',
            password VARCHAR(255) NOT NULL,
            ativo BOOLEAN NOT NULL DEFAULT TRUE,
            created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
        ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_general_ci
    `);

    await connection.query(`
        CREATE TABLE IF NOT EXISTS whatsapp_sessions (
            id INT AUTO_INCREMENT PRIMARY KEY,
            session_name VARCHAR(100) UNIQUE NOT NULL,
            is_connected BOOLEAN DEFAULT FALSE,
            qr_code TEXT,
            last_connected TIMESTAMP NULL,
            created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
        ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_general_ci
    `);

    await connection.query(`
        CREATE TABLE IF NOT EXISTS messages (
            id INT AUTO_INCREMENT PRIMARY KEY,
            session_id INT NOT NULL,
            from_number VARCHAR(50) NOT NULL,
            to_number VARCHAR(50) NOT NULL,
            message_body TEXT,
            message_type VARCHAR(100) DEFAULT 'text',
            is_from_me BOOLEAN DEFAULT FALSE,
            timestamp TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
            INDEX idx_session (session_id),
            INDEX idx_from (from_number),
            INDEX idx_timestamp (timestamp)
        ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_general_ci
    `);

    await connection.query(`
        CREATE TABLE IF NOT EXISTS chamados (
            id INT AUTO_INCREMENT PRIMARY KEY,
            protocolo VARCHAR(50) UNIQUE NOT NULL,
            categoria VARCHAR(100) NOT NULL,
            solicitante_nome VARCHAR(150) NOT NULL,
            nome_whatsapp VARCHAR(150) NULL,
            telefone_whatsapp VARCHAR(50) NULL,
            setor VARCHAR(150) NOT NULL,
            ip_maquina VARCHAR(50) NULL,
            telefone_contato VARCHAR(50) NULL,
            descricao TEXT NOT NULL,
            status VARCHAR(20) DEFAULT 'pendente',
            tecnico_nome VARCHAR(150) NULL,
            tecnico_telefone VARCHAR(50) NULL,
            atendente_id INT NULL,
            atendente_nome VARCHAR(255) NULL,
            chat_origem VARCHAR(100) NULL,
            atribuido_em DATETIME NULL,
            iniciado_em TIMESTAMP NULL,
            encerrado_em TIMESTAMP NULL,
            observacoes TEXT NULL,
            criado_em TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
            atualizado_em TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
            INDEX idx_chamados_status (status),
            INDEX idx_chamados_tecnico (tecnico_nome),
            INDEX idx_chamados_criado_em (criado_em)
        ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_general_ci
    `);

    await connection.query(`
        CREATE TABLE IF NOT EXISTS contacts (
            id INT AUTO_INCREMENT PRIMARY KEY,
            phone_number VARCHAR(50) UNIQUE NOT NULL,
            contact_name VARCHAR(255),
            first_message_at TIMESTAMP NULL,
            last_message_at TIMESTAMP NULL,
            message_count INT DEFAULT 0,
            created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
            updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
            INDEX idx_phone (phone_number),
            INDEX idx_last_message (last_message_at)
        ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_general_ci
    `);

    await connection.query(`
        CREATE TABLE IF NOT EXISTS escalas (
            id INT AUTO_INCREMENT PRIMARY KEY,
            data_escala DATE NOT NULL,
            admin_id INT NOT NULL,
            created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
            updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
            UNIQUE KEY uniq_escalas_data (data_escala),
            INDEX idx_escalas_admin_id (admin_id)
        ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_general_ci
    `);

    await connection.query(`
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
        ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_general_ci
    `);

    const adminColumns = [
        ['nome_completo', 'VARCHAR(150) NULL AFTER username'],
        ['cpf', 'VARCHAR(20) NULL AFTER nome_completo'],
        ['telefone', 'VARCHAR(30) NULL AFTER cpf'],
        ['nivel_acesso', `VARCHAR(20) NOT NULL DEFAULT 'administrador' AFTER telefone`],
        ['ativo', 'BOOLEAN NOT NULL DEFAULT TRUE AFTER password']
    ];

    for (const [columnName, definition] of adminColumns) {
        if (await ensureColumn(connection, 'admins', columnName, definition)) {
            changes.push(`admins.${columnName}`);
        }
    }

    const chamadoColumns = [
        ['telefone_whatsapp', 'VARCHAR(50) NULL AFTER nome_whatsapp'],
        ['atendente_id', 'INT NULL AFTER tecnico_telefone'],
        ['atendente_nome', 'VARCHAR(255) NULL AFTER atendente_id'],
        ['iniciado_em', 'TIMESTAMP NULL AFTER atribuido_em'],
        ['encerrado_em', 'TIMESTAMP NULL AFTER iniciado_em'],
        ['observacoes', 'TEXT NULL AFTER encerrado_em']
    ];

    for (const [columnName, definition] of chamadoColumns) {
        if (await ensureColumn(connection, 'chamados', columnName, definition)) {
            changes.push(`chamados.${columnName}`);
        }
    }

    if (await ensureIndex(connection, 'admins', 'idx_admins_cpf', 'UNIQUE INDEX idx_admins_cpf (cpf)')) {
        changes.push('admins.idx_admins_cpf');
    }

    if (await ensureForeignKey(connection, 'messages', 'messages_ibfk_1', 'FOREIGN KEY (session_id) REFERENCES whatsapp_sessions(id) ON DELETE CASCADE')) {
        changes.push('messages.messages_ibfk_1');
    }

    if (await ensureForeignKey(connection, 'chamados', 'chamados_ibfk_2', 'FOREIGN KEY (atendente_id) REFERENCES admins(id) ON DELETE SET NULL')) {
        changes.push('chamados.chamados_ibfk_2');
    }

    if (await ensureForeignKey(connection, 'chat_messages', 'fk_chat_chamado', 'FOREIGN KEY (chamado_id) REFERENCES chamados(id) ON DELETE CASCADE')) {
        changes.push('chat_messages.fk_chat_chamado');
    }

    if (await ensureForeignKey(connection, 'escalas', 'fk_escalas_admin', 'FOREIGN KEY (admin_id) REFERENCES admins(id) ON DELETE CASCADE')) {
        changes.push('escalas.fk_escalas_admin');
    }

    await connection.query(`
        ALTER TABLE messages
        MODIFY COLUMN message_type VARCHAR(100) DEFAULT 'text'
    `);

    await connection.query(`
        ALTER TABLE chamados
        MODIFY COLUMN status ENUM('pendente', 'aberto', 'em_atendimento', 'finalizado') DEFAULT 'pendente'
    `);

    await connection.query(`
        UPDATE admins
        SET nome_completo = COALESCE(NULLIF(nome_completo, ''), 'Administrador'),
            nivel_acesso = COALESCE(NULLIF(nivel_acesso, ''), 'administrador'),
            ativo = COALESCE(ativo, TRUE)
        WHERE username = 'admin'
    `);

    return changes;
}

module.exports = { ensureSchema };