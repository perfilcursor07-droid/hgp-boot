# Script PowerShell para facilitar commits no Git
# Execute este arquivo após instalar o Git

Write-Host "==================================" -ForegroundColor Cyan
Write-Host "  Git Setup - WhatsApp HGP" -ForegroundColor Cyan
Write-Host "==================================" -ForegroundColor Cyan
Write-Host ""

# Verificar se o Git está instalado
try {
    $gitVersion = git --version
    Write-Host "✓ Git encontrado: $gitVersion" -ForegroundColor Green
} catch {
    Write-Host "✗ Git não está instalado!" -ForegroundColor Red
    Write-Host ""
    Write-Host "Por favor, instale o Git:" -ForegroundColor Yellow
    Write-Host "https://git-scm.com/download/win" -ForegroundColor Yellow
    Write-Host ""
    Write-Host "Após instalar, reinicie o PowerShell e execute este script novamente." -ForegroundColor Yellow
    pause
    exit
}

Write-Host ""

# Verificar se já existe um repositório Git
if (Test-Path .git) {
    Write-Host "✓ Repositório Git já existe" -ForegroundColor Green
} else {
    Write-Host "Inicializando repositório Git..." -ForegroundColor Yellow
    git init
    Write-Host "✓ Repositório Git criado" -ForegroundColor Green
}

Write-Host ""

# Verificar configuração do Git
$userName = git config user.name
$userEmail = git config user.email

if ([string]::IsNullOrEmpty($userName) -or [string]::IsNullOrEmpty($userEmail)) {
    Write-Host "Configurando Git..." -ForegroundColor Yellow
    Write-Host ""
    
    $nome = Read-Host "Digite seu nome"
    $email = Read-Host "Digite seu email"
    
    git config --global user.name "$nome"
    git config --global user.email "$email"
    
    Write-Host "✓ Git configurado" -ForegroundColor Green
} else {
    Write-Host "✓ Git já configurado:" -ForegroundColor Green
    Write-Host "  Nome: $userName" -ForegroundColor Gray
    Write-Host "  Email: $userEmail" -ForegroundColor Gray
}

Write-Host ""
Write-Host "==================================" -ForegroundColor Cyan
Write-Host "  Status dos Arquivos" -ForegroundColor Cyan
Write-Host "==================================" -ForegroundColor Cyan
Write-Host ""

git status

Write-Host ""
Write-Host "==================================" -ForegroundColor Cyan
Write-Host "  Fazer Commit" -ForegroundColor Cyan
Write-Host "==================================" -ForegroundColor Cyan
Write-Host ""

$resposta = Read-Host "Deseja adicionar todos os arquivos e fazer commit? (S/N)"

if ($resposta -eq "S" -or $resposta -eq "s") {
    Write-Host ""
    Write-Host "Adicionando arquivos..." -ForegroundColor Yellow
    git add .
    
    Write-Host ""
    $mensagem = Read-Host "Digite a mensagem do commit (ou pressione Enter para usar a padrão)"
    
    if ([string]::IsNullOrEmpty($mensagem)) {
        $mensagem = "feat: adicionar página de contatos e melhorias no sistema"
    }
    
    Write-Host ""
    Write-Host "Fazendo commit..." -ForegroundColor Yellow
    git commit -m "$mensagem"
    
    Write-Host ""
    Write-Host "✓ Commit realizado com sucesso!" -ForegroundColor Green
    
    Write-Host ""
    Write-Host "==================================" -ForegroundColor Cyan
    Write-Host "  Repositório Remoto (Opcional)" -ForegroundColor Cyan
    Write-Host "==================================" -ForegroundColor Cyan
    Write-Host ""
    
    $temRemoto = git remote -v
    
    if ([string]::IsNullOrEmpty($temRemoto)) {
        $adicionarRemoto = Read-Host "Deseja adicionar um repositório remoto? (S/N)"
        
        if ($adicionarRemoto -eq "S" -or $adicionarRemoto -eq "s") {
            Write-Host ""
            Write-Host "Exemplo: https://github.com/seu-usuario/seu-repositorio.git" -ForegroundColor Gray
            $urlRemoto = Read-Host "Digite a URL do repositório remoto"
            
            if (-not [string]::IsNullOrEmpty($urlRemoto)) {
                git remote add origin $urlRemoto
                git branch -M main
                
                Write-Host ""
                $enviar = Read-Host "Deseja enviar para o repositório remoto agora? (S/N)"
                
                if ($enviar -eq "S" -or $enviar -eq "s") {
                    Write-Host ""
                    Write-Host "Enviando para o repositório remoto..." -ForegroundColor Yellow
                    git push -u origin main
                    Write-Host "✓ Código enviado com sucesso!" -ForegroundColor Green
                }
            }
        }
    } else {
        Write-Host "Repositório remoto já configurado:" -ForegroundColor Green
        git remote -v
        
        Write-Host ""
        $enviar = Read-Host "Deseja enviar para o repositório remoto? (S/N)"
        
        if ($enviar -eq "S" -or $enviar -eq "s") {
            Write-Host ""
            Write-Host "Enviando para o repositório remoto..." -ForegroundColor Yellow
            git push
            Write-Host "✓ Código enviado com sucesso!" -ForegroundColor Green
        }
    }
}

Write-Host ""
Write-Host "==================================" -ForegroundColor Cyan
Write-Host "  Concluído!" -ForegroundColor Cyan
Write-Host "==================================" -ForegroundColor Cyan
Write-Host ""
Write-Host "Comandos úteis do Git:" -ForegroundColor Yellow
Write-Host "  git status          - Ver status dos arquivos" -ForegroundColor Gray
Write-Host "  git add .           - Adicionar todos os arquivos" -ForegroundColor Gray
Write-Host "  git commit -m 'msg' - Fazer commit" -ForegroundColor Gray
Write-Host "  git push            - Enviar para repositório remoto" -ForegroundColor Gray
Write-Host "  git log --oneline   - Ver histórico de commits" -ForegroundColor Gray
Write-Host ""

pause
