const axios = require('axios');
const dayjs = require('dayjs');

// O seu link da planilha CSV
const URL_PLANILHA_CSV = "https://docs.google.com/spreadsheets/d/e/2PACX-1vTXqSf5qMNA7Zd7jolV5IeplWYz-beU5-ypZHgmvUSlPxGIisq51hGbhHtlpnMf96OgG-TE4WIrLvKp/pub?gid=0&single=true&output=csv";

async function simularSobreavisoReal() {
    try {
        console.log("--- CONECTANDO À PLANILHA DO GOOGLE... ---");
        const response = await axios.get(URL_PLANILHA_CSV);
        const linhas = response.data.split('\n').slice(1); 

        // Converte o CSV em uma lista de objetos
        const escala = linhas.map(l => {
            const c = l.split(',');
            let dataOriginal = c[0]?.trim();
            
            // Tratamento de data: Se estiver DD/MM/AAAA, converte para AAAA-MM-DD
            let dataPadronizada = dataOriginal;
            if (dataOriginal.includes('/')) {
                const [d, m, a] = dataOriginal.split('/');
                dataPadronizada = `${a}-${m}-${d}`;
            }

            return { 
                data: dataPadronizada, 
                tecnico: c[1]?.trim(), 
                telefone: c[2]?.trim() 
            };
        }).filter(i => i.data);

        // Pega a data de hoje (Simulando hoje: 2026-03-17)
        const dataHoje = dayjs().format('YYYY-MM-DD');
        const horaAtual = dayjs().hour() * 100 + dayjs().minute();

        console.log(`Hoje é: ${dataHoje}`);
        console.log(`Hora: ${horaAtual}`);

        // Busca o técnico na lista que veio da planilha
        const plantonista = escala.find(s => s.data === dataHoje);

        if (plantonista) {
            console.log("\n✅ TÉCNICO ENCONTRADO NA PLANILHA!");
            console.log(`👨‍💻 Nome: ${plantonista.tecnico}`);
            console.log(`📞 Telefone: ${plantonista.telefone}`);
            console.log(`📅 Data na Planilha: ${plantonista.data}`);
        } else {
            console.log("\n❌ NENHUM TÉCNICO ESCALADO PARA HOJE.");
            console.log("Verifique se a data na planilha está correta (AAAA-MM-DD ou DD/MM/AAAA).");
            console.log("Dados lidos da planilha (primeiras 3 linhas):", escala.slice(0, 3));
        }

    } catch (error) {
        console.error("Erro ao ler a planilha:", error.message);
    }
}

simularSobreavisoReal();