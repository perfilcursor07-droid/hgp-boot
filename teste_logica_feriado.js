const axios = require('axios');
const dayjs = require('dayjs');

// Sua planilha de feriados
const URL_FERIADOS_CSV = "https://docs.google.com/spreadsheets/d/e/2PACX-1vTsLz3GK8jquOyjf9t1AfdGM-oI1i14YVY5a2sPsmnkt70l_Vk2LJdqnI_b__ZirHjVgySgcsnZfUiW/pub?gid=0&single=true&output=csv";

async function simularTeste() {
    console.log("🔍 Iniciando simulação de feriado...");

    try {
        const response = await axios.get(URL_FERIADOS_CSV);
        const linhas = response.data.split('\n').slice(1);
        const feriados = linhas.map(l => {
            const c = l.split(',');
            return { 
                data: c[0]?.trim(), 
                tecnico: c[1]?.trim(), 
                telefone: c[2]?.trim(), 
                nomeFeriado: c[3]?.trim() 
            };
        }).filter(i => i.data);

        // --- SIMULAÇÃO ---
        // Pegamos a primeira data que estiver na sua planilha para testar
        if (feriados.length === 0) {
            console.log("❌ A planilha parece estar vazia ou o link está incorreto.");
            return;
        }

        const diaSimulado = feriados[0].data; // Pega a data do primeiro feriado da lista
        const horaSimulada = 1000; // Simula 10:00 da manhã (Dentro do sobreaviso)

        console.log(`📅 Testando com a data: ${diaSimulado}`);
        console.log(`⏰ Horário simulado: 10:00h`);
        console.log("--------------------------------------------");

        // Lógica de verificação
        const feriadoHoje = feriados.find(f => f.data === diaSimulado);

        if (feriadoHoje) {
            const emHorarioSobreaviso = (horaSimulada >= 800 && horaSimulada <= 1200) || (horaSimulada >= 1400 && horaSimulada <= 1800);

            if (emHorarioSobreaviso) {
                const num = feriadoHoje.telefone.replace(/\D/g, '');
                console.log("✅ RESULTADO (Mensagem que o usuário receberia):");
                console.log(`
*🛠️ TI HGP - COMUNICADO*

Prezado(a), informamos que hoje não haverá expediente administrativo devido ao feriado de *${feriadoHoje.nomeFeriado}*.

Para casos de *urgência*, favor contatar o técnico de plantão:

👨‍💻 *Técnico:* ${feriadoHoje.tecnico}
📞 *Contato:* ${feriadoHoje.telefone}
🔗 https://wa.me/55${num}
                `);
            } else {
                console.log("📴 Fora do horário de sobreaviso. O bot diria que não há atendimento no momento.");
            }
        }

    } catch (error) {
        console.error("❌ Erro ao acessar a planilha:", error.message);
    }
}

simularTeste();