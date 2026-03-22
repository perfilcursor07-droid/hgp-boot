-- Tabela de administradores
CREATE TABLE IF NOT EXISTS admins (
    id INT AUTO_INCREMENT PRIMARY KEY,
    username VARCHAR(50) UNIQUE NOT NULL,
    password VARCHAR(255) NOT NULL,
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

-- Tabela de sessões do WhatsApp
CREATE TABLE IF NOT EXISTS whatsapp_sessions (
    id INT AUTO_INCREMENT PRIMARY KEY,
    session_name VARCHAR(100) UNIQUE NOT NULL,
    is_connected BOOLEAN DEFAULT FALSE,
    qr_code TEXT,
    last_connected TIMESTAMP NULL,
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

-- Tabela de mensagens
CREATE TABLE IF NOT EXISTS messages (
    id INT AUTO_INCREMENT PRIMARY KEY,
    session_id INT NOT NULL,
    from_number VARCHAR(50) NOT NULL,
    to_number VARCHAR(50) NOT NULL,
    message_body TEXT,
    message_type VARCHAR(100) DEFAULT 'text',
    is_from_me BOOLEAN DEFAULT FALSE,
    timestamp TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    FOREIGN KEY (session_id) REFERENCES whatsapp_sessions(id) ON DELETE CASCADE,
    INDEX idx_session (session_id),
    INDEX idx_from (from_number),
    INDEX idx_timestamp (timestamp)
);

-- Inserir admin padrão (senha: admin123)
INSERT INTO admins (username, password) VALUES 
('admin', '$2b$10$rKvVPZqGsYKHXq7K5Y5zXeJ8YqGqYqGqYqGqYqGqYqGqYqGqYqGqY')
ON DUPLICATE KEY UPDATE username = username;
