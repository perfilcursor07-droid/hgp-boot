// =====================================
// EMULADOR DE LÓGICA - VERSÃO ANTI-TRAVA
// =====================================
const readline = require('readline');

const rl = readline.createInterface({
  input: process.stdin,
  output: process.stdout
});

let estado = { step: 0 };

console.log("--- SIMULADOR DE FLUXO TI HGP ---");
console.log("Digite 'OI' para começar ou 'SAIR' para encerrar.\n");

function simularBot(input) {
  const texto = input.trim();
  const textoUpper = texto.toUpperCase();

  // COMANDO DE SAÍDA IMEDIATA
  if (textoUpper === 'SAIR' || textoUpper === 'CANCELAR') {
    console.log("\nBOT: ❌ Atendimento encerrado. Digite 'OI' para recomeçar.");
    estado = { step: 0 };
    return;
  }

  // PASSO 0: INÍCIO (OI ou MENU)
  if (estado.step === 0) {
    if (/^(OI|OLA|OLÁ|MENU|BOM DIA)$/.test(textoUpper)) {
      console.log("\nBOT: Escolha uma opção:\n1️⃣ Soul MV\n2️⃣ Impressora\n3️⃣ Suporte Técnico\n4️⃣ VOIP\n5️⃣ Outros");
      estado.step = 0.5;
    } else {
      console.log("\nBOT: 👋 Olá! Digite 'OI' ou 'MENU' para iniciar o atendimento.");
    }
    return;
  }

  // FLUXO DE PASSOS (SWITCH CASE)
  switch (estado.step) {
    case 0.5: // SELEÇÃO DO MENU
      if (["1", "2", "3", "4", "5"].includes(textoUpper)) {
        estado.opcao = textoUpper;
        estado.step = 1;
        console.log("\nBOT: 👤 Informe seu Nome Completo:");
      } else {
        console.log("\nBOT: ⚠️ Opção inválida! Escolha de 1 a 5.");
      }
      break;

    case 1: // NOME
      estado.nome = texto;
      estado.step = 2;
      console.log("\nBOT: 🏢 Qual seu Setor e Ala?");
      break;

    case 2: // SETOR
      estado.setor = texto;
      if (estado.opcao === "2") {
        estado.step = 2.5;
        console.log("\nBOT: 📠 Informe o Código da Impressora (ex: TC0225):");
      } else {
        estado.step = 3;
        console.log("\nBOT: 💻 Informe o IP do Computador (Verificar na área de trabalho canto superior direito. Ex: 10.75.18.25):");
      }
      break;

    case 2.5: // CÓDIGO DA IMPRESSORA
      estado.codImpressora = texto;
      estado.step = 3;
      console.log("\nBOT: 💻 Informe o IP do Computador (Verificar na área de trabalho canto superior direito. Ex: 10.75.18.25):");
      break;

    case 3: // IP COM VALIDAÇÃO
      const ipRegex = /^(?:[0-9]{1,3}\.){3}[0-9]{1,3}$/;
      if (!ipRegex.test(texto)) {
        console.log("\nBOT: ⚠️ IP Inválido! Verifique na área de trabalho canto superior direito.\n📍 Exemplo: 10.75.18.25");
      } else {
        estado.ip = texto;
        estado.step = 4;
        console.log("\nBOT: 📱 Seu Telefone para contato (com DDD):");
      }
      break;

    case 4: // TELEFONE
      if (texto.replace(/\D/g, '').length < 10) {
        console.log("\nBOT: ⚠️ Telefone inválido! Digite DDD + Número.");
      } else {
        estado.telefone = texto;
        estado.step = 5;
        console.log("\nBOT: 📝 Descreva o Problema:");
      }
      break;

    case 5: // FINALIZAÇÃO
      estado.descricao = texto;
      console.log("\n===============================");
      console.log("🛠️  RELATÓRIO GERADO COM SUCESSO");
      console.log(`👤 Nome: ${estado.nome}`);
      console.log(`🏢 Setor: ${estado.setor}`);
      if (estado.codImpressora) console.log(`📠 Impressora: ${estado.codImpressora}`);
      console.log(`💻 IP: ${estado.ip}`);
      console.log(`📱 Telefone: ${estado.telefone}`);
      console.log(`📝 Problema: ${estado.descricao}`);
      console.log("===============================\n");
      
      console.log("✅ Chamado Registrado! O bot foi resetado.");
      console.log("Digite 'OI' para iniciar um novo teste.");
      
      // RESET TOTAL PARA VOLTAR AO COMEÇO
      estado = { step: 0 };
      break;

    default:
      console.log("\nBOT: Algo deu errado. Resetando...");
      estado = { step: 0 };
      break;
  }
}

rl.on('line', (line) => {
  simularBot(line);
});