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

const DEFAULT_CHATBOT_FLOW = {
    name: 'Fluxo Padrão chatbot.js',
    slug: 'chatbot-js-padrao',
    description: 'Representação visual do fluxo atual do chatbot que já está em produção.',
    source_file: 'chatbot.js',
    steps: [
        {
            step_key: 'start',
            title: 'Boas-vindas e menu',
            prompt_text: 'Apresenta a saudação inicial e mostra as opções 1 a 6 com possibilidade de CANCELAR.',
            field_key: 'opcao',
            validation_type: 'menu',
            next_step: '0.5',
            error_message: 'Ignora entradas fora do menu até o usuário escolher uma opção válida.',
            conditions_text: 'Se a mensagem inicial for o gatilho de teste, marca o estado como teste antes de iniciar.',
            action_summary: 'Envia o menu principal com categorias e opção de ramais.',
            sort_order: 1,
            is_terminal: false
        },
        {
            step_key: '0.5',
            title: 'Escolha da categoria',
            prompt_text: 'Recebe a opção escolhida pelo usuário.',
            field_key: 'opcao',
            validation_type: 'categoria',
            next_step: '1',
            error_message: 'Se a opção não existir, o fluxo aguarda nova resposta.',
            conditions_text: 'Se a opção for 6, envia o PDF de ramais e encerra o estado.',
            action_summary: 'Quando a categoria é válida, avança para coleta do nome completo.',
            sort_order: 2,
            is_terminal: false
        },
        {
            step_key: '1',
            title: 'Nome completo',
            prompt_text: '👤 Seu *Nome Completo*:',
            field_key: 'nome',
            validation_type: 'texto',
            next_step: '2',
            error_message: '',
            conditions_text: '',
            action_summary: 'Salva o nome do solicitante e solicita o setor e ala.',
            sort_order: 3,
            is_terminal: false
        },
        {
            step_key: '2',
            title: 'Setor e ala',
            prompt_text: '🏢 Seu *Setor e Ala*:',
            field_key: 'setor',
            validation_type: 'texto',
            next_step: '3',
            error_message: '',
            conditions_text: '',
            action_summary: 'Salva setor/ala e solicita o IP da máquina.',
            sort_order: 4,
            is_terminal: false
        },
        {
            step_key: '3',
            title: 'IP da máquina',
            prompt_text: '💻 *IP da Máquina*:',
            field_key: 'ip',
            validation_type: 'ip',
            next_step: '4',
            error_message: '❌ IP inválido. Tente novamente:',
            conditions_text: 'Se a categoria escolhida for Impressora (2), o próximo passo vira 3.5 para pedir o código da impressora.',
            action_summary: 'Valida o IP e decide se o fluxo segue para o código da impressora ou telefone.',
            sort_order: 5,
            is_terminal: false
        },
        {
            step_key: '3.5',
            title: 'Código da impressora',
            prompt_text: '🖨️ Qual é o *código da impressora*? (Ex: TC1020)',
            field_key: 'codImpressora',
            validation_type: 'texto',
            next_step: '4',
            error_message: '',
            conditions_text: 'Executado somente quando a categoria for Impressora.',
            action_summary: 'Salva o código da impressora e segue para o telefone de contato.',
            sort_order: 6,
            is_terminal: false
        },
        {
            step_key: '4',
            title: 'Telefone de contato',
            prompt_text: '📱 *Telefone* de contato:',
            field_key: 'tel',
            validation_type: 'telefone',
            next_step: '5',
            error_message: '',
            conditions_text: '',
            action_summary: 'Salva o telefone informado e pede a descrição do problema.',
            sort_order: 7,
            is_terminal: false
        },
        {
            step_key: '5',
            title: 'Descrição e fechamento',
            prompt_text: '📝 Descreva o *Problema*:',
            field_key: 'desc',
            validation_type: 'texto-livre',
            next_step: '',
            error_message: '',
            conditions_text: 'Monta o relatório, salva chamado, envia ao técnico da escala e dispara o webhook histórico.',
            action_summary: 'Conclui o fluxo do chamado e limpa o estado do usuário.',
            sort_order: 8,
            is_terminal: true
        }
    ]
};

async function ensureDefaultChatbotFlow(connection) {
    const [existingFlows] = await connection.query(
        'SELECT id FROM chatbot_flows WHERE slug = ? LIMIT 1',
        [DEFAULT_CHATBOT_FLOW.slug]
    );

    let flowId = existingFlows[0]?.id;

    if (!flowId) {
        const [result] = await connection.query(
            `INSERT INTO chatbot_flows (name, slug, description, is_default, is_active, source_file)
             VALUES (?, ?, ?, TRUE, TRUE, ?)`,
            [
                DEFAULT_CHATBOT_FLOW.name,
                DEFAULT_CHATBOT_FLOW.slug,
                DEFAULT_CHATBOT_FLOW.description,
                DEFAULT_CHATBOT_FLOW.source_file
            ]
        );

        flowId = result.insertId;
    }

    const [stepCountRows] = await connection.query(
        'SELECT COUNT(*) AS total FROM chatbot_flow_steps WHERE flow_id = ?',
        [flowId]
    );

    if (stepCountRows[0].total > 0) {
        return false;
    }

    for (const step of DEFAULT_CHATBOT_FLOW.steps) {
        await connection.query(
            `INSERT INTO chatbot_flow_steps (
                flow_id,
                step_key,
                title,
                prompt_text,
                field_key,
                validation_type,
                next_step,
                error_message,
                conditions_text,
                action_summary,
                sort_order,
                is_terminal
            ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
            [
                flowId,
                step.step_key,
                step.title,
                step.prompt_text,
                step.field_key,
                step.validation_type,
                step.next_step,
                step.error_message,
                step.conditions_text,
                step.action_summary,
                step.sort_order,
                step.is_terminal
            ]
        );
    }

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
        CREATE TABLE IF NOT EXISTS chatbot_flows (
            id INT AUTO_INCREMENT PRIMARY KEY,
            name VARCHAR(150) NOT NULL,
            slug VARCHAR(160) NOT NULL,
            description TEXT NULL,
            is_default BOOLEAN NOT NULL DEFAULT FALSE,
            is_active BOOLEAN NOT NULL DEFAULT TRUE,
            source_file VARCHAR(120) NULL,
            created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
            updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
            UNIQUE KEY uniq_chatbot_flows_slug (slug)
        ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_general_ci
    `);

    await connection.query(`
        CREATE TABLE IF NOT EXISTS chatbot_flow_steps (
            id INT AUTO_INCREMENT PRIMARY KEY,
            flow_id INT NOT NULL,
            step_key VARCHAR(20) NOT NULL,
            title VARCHAR(150) NOT NULL,
            prompt_text TEXT NULL,
            field_key VARCHAR(80) NULL,
            validation_type VARCHAR(50) NULL,
            next_step VARCHAR(20) NULL,
            error_message TEXT NULL,
            conditions_text TEXT NULL,
            action_summary TEXT NULL,
            sort_order INT NOT NULL DEFAULT 0,
            is_terminal BOOLEAN NOT NULL DEFAULT FALSE,
            created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
            updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
            UNIQUE KEY uniq_chatbot_flow_step (flow_id, step_key),
            INDEX idx_chatbot_flow_steps_flow_id (flow_id),
            INDEX idx_chatbot_flow_steps_order (flow_id, sort_order)
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

    if (await ensureForeignKey(connection, 'chatbot_flow_steps', 'fk_chatbot_flow_steps_flow', 'FOREIGN KEY (flow_id) REFERENCES chatbot_flows(id) ON DELETE CASCADE')) {
        changes.push('chatbot_flow_steps.fk_chatbot_flow_steps_flow');
    }

    if (await ensureDefaultChatbotFlow(connection)) {
        changes.push('chatbot_flows.default_seed');
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