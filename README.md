# WhatsApp HGP - Sistema de Gerenciamento

Sistema completo para administração de WhatsApp com frontend em Node.js, registro de mensagens e banco MySQL.

## Funcionalidades

- Login de administrador
- Conexão com WhatsApp via QR Code
- Dashboard de controle
- Registro completo de mensagens
- Interface responsiva e moderna

## Instalação

### 1. Instalar dependências
```bash
npm install
```

### 2. Configurar banco de dados MySQL

Crie o banco de dados:
```sql
CREATE DATABASE whatsapp_admin;
```

Execute a migration:
```bash
mysql -u root -p whatsapp_admin < migrations/001_create_tables.sql
```

### 3. Configurar variáveis de ambiente

Copie o arquivo de exemplo:
```bash
cp .env.example .env
```

Edite o arquivo `.env` com suas configurações:
```
DB_HOST=localhost
DB_USER=root
DB_PASSWORD=sua_senha
DB_NAME=whatsapp_admin
SESSION_SECRET=seu_secret_seguro
PORT=3000
```

### 4. Criar usuário administrador

```bash
npm run create-admin admin admin123
```

Ou use o padrão (usuário: admin, senha: admin123):
```bash
npm run create-admin
```

## Executar

### Modo produção:
```bash
npm start
```

### Modo desenvolvimento:
```bash
npm run dev
```

Acesse: http://localhost:3000

## Login Padrão

- Usuário: `admin`
- Senha: `admin123`

## Estrutura do Projeto

```
├── config/
│   └── database.js          # Configuração MySQL
├── migrations/
│   └── 001_create_tables.sql # Schema do banco
├── public/
│   └── css/
│       └── style.css        # Estilos
├── scripts/
│   └── create_admin.js      # Script criar admin
├── views/
│   ├── login.ejs           # Página de login
│   ├── dashboard.ejs       # Dashboard principal
│   └── messages.ejs        # Lista de mensagens
├── .env.example            # Exemplo de configuração
├── server.js               # Servidor principal
└── package.json
```

## Uso

1. Faça login com suas credenciais
2. No dashboard, clique em "Conectar WhatsApp"
3. Escaneie o QR Code com seu WhatsApp
4. Aguarde a conexão
5. Acesse "Mensagens" para ver o registro

## Tecnologias

- Node.js + Express
- EJS (templates)
- MySQL
- whatsapp-web.js
- bcrypt (segurança)
- express-session
