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
```bash
npm install
```

3. Configure o banco de dados:
   - Crie um banco de dados MySQL chamado `whatsapp_admin`
   - Copie `.env.example` para `.env` e configure suas credenciais:
```bash
cp .env.example .env
```

4. Edite o arquivo `.env`:
```env
DB_HOST=localhost
DB_USER=root
DB_PASSWORD=sua_senha
DB_NAME=whatsapp_admin
SESSION_SECRET=seu_secret_seguro_aqui
PORT=3000
```

5. Execute as migrations:
```bash
npm run migrate
```

6. Crie um usuário admin:
```bash
npm run create-admin
```

## 🎯 Como Usar

1. Inicie o servidor:
```bash
npm start
```

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
