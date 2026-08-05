// Remove opcoes de visita hospitalar dos fluxos salvos no banco.
require('dotenv').config();
const db = require('../config/database');

function removerOpcaoHospitalar(flow) {
    const opcoes = flow?.menuPrincipal?.opcoes;
    if (!Array.isArray(opcoes)) return false;

    const antes = opcoes.length;
    flow.menuPrincipal.opcoes = opcoes.filter((opcao) => {
        const texto = `${opcao.label || ''} ${opcao.categoria || ''}`.toLowerCase();
        return !(texto.includes('visita') && (texto.includes('hospital') || texto.includes('anexo')));
    });

    let proximoId = 1;
    for (const opcao of flow.menuPrincipal.opcoes) {
        if (/^\d+$/.test(String(opcao.id))) {
            opcao.id = String(proximoId++);
        }
    }

    return flow.menuPrincipal.opcoes.length !== antes;
}

(async () => {
    try {
        const [rows] = await db.query('SELECT id, nome, definicao_json FROM bot_flows_v2 WHERE ativo = TRUE');
        let atualizados = 0;

        for (const row of rows) {
            let flow;
            try {
                flow = typeof row.definicao_json === 'string'
                    ? JSON.parse(row.definicao_json)
                    : row.definicao_json;
            } catch (e) {
                console.warn(`Fluxo ignorado por JSON invalido: ${row.nome} (id=${row.id})`);
                continue;
            }

            if (!removerOpcaoHospitalar(flow)) continue;

            await db.query(
                'UPDATE bot_flows_v2 SET definicao_json = ? WHERE id = ?',
                [JSON.stringify(flow), row.id]
            );
            atualizados += 1;
            console.log(`Atualizado: ${row.nome} (id=${row.id})`);
        }

        console.log(`Concluido. Fluxos atualizados: ${atualizados}`);
        process.exit(0);
    } catch (e) {
        console.error(e);
        process.exit(1);
    }
})();