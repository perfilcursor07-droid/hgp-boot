# Sistema de Gerenciamento de Usuários

## Níveis de Acesso

### 🔑 Administrador
- Acesso total ao sistema
- Pode gerenciar usuários
- Acesso a todas as páginas:
  - Dashboard
  - Mensagens
  - Chamados
  - Contatos
  - Usuários
  - Configurações

### 📊 Gestor
- Acesso restrito apenas à página de Chamados
- Não pode gerenciar usuários
- Não tem acesso a outras funcionalidades

## Funcionalidades

### Cadastro de Usuários
- Nome Completo
- Usuário (login)
- CPF (com máscara automática)
- Telefone (com máscara automática)
- Nível de Acesso (Administrador ou Gestor)
- Senha
- Status (Ativo/Inativo)

### Gerenciamento
- ✏️ Editar usuários
- 🔒 Ativar/Desativar usuários
- 🗑️ Excluir usuários (exceto o admin padrão)
- 🔍 Busca em tempo real

## Credenciais Padrão

Após executar a migration, o usuário admin será atualizado:

- **Usuário:** admin
- **Senha:** admin123
- **Nível:** Administrador
- **Nome:** Administrador do Sistema
- **CPF:** 000.000.000-00
- **Telefone:** (00) 00000-0000

## Como Usar

1. Execute a migration:
```bash
npm run migrate
```

2. Faça login como administrador

3. Acesse o menu "Usuários"

4. Clique em "Novo Usuário" para cadastrar

5. Preencha os dados e escolha o nível de acesso

## Regras de Segurança

- Apenas administradores podem acessar a página de usuários
- Gestores são redirecionados automaticamente para /chamados após login
- Não é possível excluir o usuário "admin" padrão
- Usuários inativos não podem fazer login
- Senhas são criptografadas com bcrypt

## Rotas Protegidas

### Apenas Administradores:
- `/dashboard`
- `/messages`
- `/contacts`
- `/usuarios`
- `/settings`
- `/api/usuarios/*`

### Todos os Usuários Autenticados:
- `/chamados`
- `/logout`

## Testando

1. Crie um usuário gestor
2. Faça logout
3. Faça login com o gestor
4. Verifique que ele só tem acesso a /chamados
5. Tente acessar outras páginas (será redirecionado)
