<<<<<<< HEAD
# 💬 WhatsApp HGP - Sistema de Gestão

Sistema completo de administração e automação de atendimento via WhatsApp para o Hospital Geral de Palmas (HGP).

## 🚀 Funcionalidades

- ✅ **Dashboard** - Visão geral do sistema e estatísticas
- 💬 **Mensagens** - Histórico completo de conversas
- 📋 **Chamados** - Gestão de tickets de TI
- 👥 **Contatos** - Lista de todos os usuários que interagiram com o bot
- ⚙️ **Configurações** - Editor de código do chatbot e escala de técnicos
- 🤖 **Chatbot Inteligente** - Atendimento automatizado 24/7
- 📊 **Relatórios** - Estatísticas e métricas de atendimento

## 📋 Pré-requisitos

- Node.js 16+ 
- MySQL 5.7+
- WAMP/XAMPP (ou servidor MySQL)
- Navegador Chrome/Chromium (para WhatsApp Web)

## 🔧 Instalação

1. Clone o repositório:
```bash
git clone <url-do-repositorio>
cd hgp-boot-main
```

2. Instale as dependências:
=======
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
>>>>>>> b9304d0859cde428d1d32bc90c169ccd183e542c
```bash
npm install
```

<<<<<<< HEAD
3. Configure o banco de dados:
   - Crie um banco de dados MySQL chamado `whatsapp_admin`
   - Copie `.env.example` para `.env` e configure suas credenciais:
=======
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
>>>>>>> b9304d0859cde428d1d32bc90c169ccd183e542c
```bash
cp .env.example .env
```

<<<<<<< HEAD
4. Edite o arquivo `.env`:
```env
=======
Edite o arquivo `.env` com suas configurações:
```
>>>>>>> b9304d0859cde428d1d32bc90c169ccd183e542c
DB_HOST=localhost
DB_USER=root
DB_PASSWORD=sua_senha
DB_NAME=whatsapp_admin
<<<<<<< HEAD
SESSION_SECRET=seu_secret_seguro_aqui
PORT=3000
```

5. Execute as migrations:
```bash
npm run migrate
```

6. Crie um usuário admin:
=======
SESSION_SECRET=seu_secret_seguro
PORT=3000
```

### 4. Criar usuário administrador

```bash
npm run create-admin admin admin123
```

Ou use o padrão (usuário: admin, senha: admin123):
>>>>>>> b9304d0859cde428d1d32bc90c169ccd183e542c
```bash
npm run create-admin
```

<<<<<<< HEAD
## 🎯 Como Usar

1. Inicie o servidor:
=======
## Executar

### Modo produção:
>>>>>>> b9304d0859cde428d1d32bc90c169ccd183e542c
```bash
npm start
```

<<<<<<< HEAD
2. Acesse o painel em: `http://localhost:3000`

3. Faça login com as credenciais:
   - Usuário: `admin`
   - Senha: `admin123`

4. No Dashboard, clique em "Conectar WhatsApp" e escaneie o QR Code

## 📦 Scripts Disponíveis

```bash
npm start           # Inicia o servidor
npm run dev         # Inicia em modo desenvolvimento (com nodemon)
npm run migrate     # Executa as migrations do banco
npm run create-admin # Cria/atualiza usuário admin
npm run test-db     # Testa conexão com o banco
npm run sync-contacts # Sincroniza contatos das mensagens
```

## 🗂️ Estrutura do Projeto

```
hgp-boot-main/
├── config/              # Configurações do banco de dados
├── migrations/          # Scripts SQL de criação de tabelas
├── public/             # Arquivos estáticos (CSS, JS)
├── scripts/            # Scripts utilitários
├── views/              # Templates EJS
├── chatbot.js          # Lógica do chatbot (editável via painel)
├── chatbot-handler.js  # Handler do chatbot
├── server.js           # Servidor Express principal
├── escala.json         # Escala de técnicos
└── package.json        # Dependências do projeto
```

## 🔐 Segurança

- Senhas são criptografadas com bcrypt
- Sessões protegidas com express-session
- Arquivo `.env` não é versionado (contém credenciais)
- Autenticação obrigatória em todas as rotas

## 🛠️ Tecnologias

- **Backend:** Node.js, Express
- **Banco de Dados:** MySQL
- **WhatsApp:** whatsapp-web.js
- **Template Engine:** EJS
- **Autenticação:** bcrypt, express-session
- **Automação:** Chatbot personalizado

## 📱 Funcionalidades do Chatbot

O chatbot atende automaticamente e coleta:
- Categoria do problema (Soul MV, Impressora, Suporte, etc)
- Nome completo do solicitante
- Setor e ala
- IP da máquina
- Telefone de contato
- Descrição do problema

Após a coleta, gera um protocolo e encaminha para o técnico de plantão.

## 🔄 Atualizações Recentes

- ✅ Página de contatos com sincronização automática
- ✅ Registro automático de contatos ao receber mensagens
- ✅ Estatísticas de contatos (total, novos, ativos)
- ✅ Busca em tempo real na lista de contatos
- ✅ Melhorias na interface e responsividade

## 📞 Suporte

Para dúvidas ou problemas, entre em contato com a equipe de TI do HGP.

## 📄 Licença

Uso interno - Hospital Geral de Palmas (HGP)
=======
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
>>>>>>> b9304d0859cde428d1d32bc90c169ccd183e542c
