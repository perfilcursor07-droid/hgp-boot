-- Tabela de contatos
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
);
