# Changelog

Todas as mudanças notáveis neste projeto serão documentadas neste arquivo.

## [1.1.0] - 2026-03-22

### Adicionado
- ✨ Nova página de Contatos (`/contacts`)
- 📊 Estatísticas de contatos (total, novos hoje, ativos nos últimos 7 dias)
- 🔍 Busca em tempo real na lista de contatos
- 🔄 Sincronização automática de contatos ao receber mensagens
- 🔄 Botão de sincronização manual de contatos
- 📝 Script CLI para sincronizar contatos: `npm run sync-contacts`
- 🗄️ Nova tabela `contacts` no banco de dados
- 📄 Migration 004: criação da tabela de contatos
- 📖 README.md atualizado com documentação completa
- 📋 CHANGELOG.md para rastrear alterações

### Modificado
- 🎨 Melhorias no CSS para a página de contatos
- 🔧 Atualização do `chatbot-handler.js` para registrar contatos automaticamente
- 🔧 Atualização do `server.js` com rotas de contatos
- 📦 Atualização do `package.json` com novo script

### Técnico
- Tabela `contacts` com campos:
  - `phone_number` (único)
  - `contact_name`
  - `first_message_at`
  - `last_message_at`
  - `message_count`
- API endpoint: `POST /api/contacts/sync`
- Registro automático de contatos no evento `message` do WhatsApp

## [1.0.0] - 2026-03-XX

### Inicial
- 🎉 Sistema base de administração WhatsApp
- 🔐 Sistema de login e autenticação
- 📊 Dashboard com estatísticas
- 💬 Registro de mensagens
- 📋 Sistema de chamados
- 🤖 Chatbot inteligente
- ⚙️ Painel de configurações
- 🗄️ Banco de dados MySQL
