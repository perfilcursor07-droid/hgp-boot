// Atualiza o Fluxo SESAU para aceitar hospitais e listar HOSPITAIS como opcao 2.
require('dotenv').config();
const db = require('../config/database');

const OPCOES_UNIDADE_SESAU = [
    { id: '1', label: 'SES-SEDE' },
    { id: '2', label: 'HOSPITAIS' },
    { id: '3', label: 'SVO' },
    { id: '4', label: 'SER' },
    { id: '5', label: 'ANEXO VII' },
    { id: '6', label: 'ANEXO I' },
    { id: '7', label: 'ESTOQUE REG.' },
    { id: '8', label: 'ASSISTÊNCIA FARMACÊUTICA' }
];

function codigoLocal(label) {
    return String(label || '')
        .normalize('NFD')
        .replace(/[\u0300-\u036f]/g, '')
        .toUpperCase()
        .replace(/[^A-Z0-9]+/g, '_')
        .replace(/^_+|_+$/g, '');
}

function parseFlow(row) {
    return typeof row.definicao_json === 'string'
        ? JSON.parse(row.definicao_json)
        : row.definicao_json;
}

function atualizarBlocos(flow) {
    let alterado = false;
    const blocos = flow?.blocos || {};

    for (const bloco of Object.values(blocos)) {
        if (!Array.isArray(bloco.campos)) continue;

        const campoUnidade = bloco.campos.find((campo) => campo.key === 'unidade');
        if (campoUnidade) {
            campoUnidade.label = 'UNIDADE';
            campoUnidade.obrigatorio = true;
            campoUnidade.tipo = 'opcoes';
            campoUnidade.opcoes = OPCOES_UNIDADE_SESAU;
            alterado = true;
        }
    }

    return alterado;
}

async function atualizarLocaisSesau() {
    const [unidades] = await db.query(`
        SELECT id, nome, codigo
        FROM unidades
        WHERE ativo = TRUE
          AND (UPPER(codigo) = 'SESAU' OR LOWER(nome) LIKE '%sesau%')
        ORDER BY id
    `);

    for (const unidade of unidades) {
        for (const opcao of OPCOES_UNIDADE_SESAU) {
            await db.query(
                `INSERT INTO unidade_locais (unidade_id, nome, codigo, ativo)
                 VALUES (?, ?, ?, TRUE)
                 ON DUPLICATE KEY UPDATE codigo = VALUES(codigo), ativo = TRUE`,
                [unidade.id, opcao.label, codigoLocal(opcao.label)]
            );
        }
        console.log(`Locais sincronizados: ${unidade.nome} (${unidade.codigo || unidade.id})`);
    }

    return unidades.length;
}

(async () => {
    try {
        const [rows] = await db.query(`
            SELECT DISTINCT f.id, f.nome, f.definicao_json
            FROM bot_flows_v2 f
            LEFT JOIN instancias i ON i.flow_id = f.id
            LEFT JOIN unidades u ON u.id = i.unidade_id
            WHERE f.ativo = TRUE
              AND (
                LOWER(f.nome) LIKE '%sesau%'
                OR UPPER(u.codigo) = 'SESAU'
                OR LOWER(u.nome) LIKE '%sesau%'
              )
            ORDER BY f.id
        `);

        if (rows.length === 0) {
            console.log('Nenhum fluxo SESAU ativo encontrado.');
            process.exit(0);
        }

        let atualizados = 0;

        for (const row of rows) {
            let flow;
            try {
                flow = parseFlow(row);
            } catch (e) {
                console.warn(`Fluxo ignorado por JSON invalido: ${row.nome} (id=${row.id})`);
                continue;
            }

            flow.permitirHospitais = true;

            if (!atualizarBlocos(flow)) {
                console.warn(`Fluxo sem campo unidade nos blocos: ${row.nome} (id=${row.id})`);
            }

            await db.query(
                'UPDATE bot_flows_v2 SET definicao_json = ? WHERE id = ?',
                [JSON.stringify(flow), row.id]
            );

            atualizados += 1;
            console.log(`Atualizado: ${row.nome} (id=${row.id})`);
        }

        const unidadesAtualizadas = await atualizarLocaisSesau();

        console.log(`Concluido. Fluxos SESAU atualizados: ${atualizados}. Unidades SESAU com locais sincronizados: ${unidadesAtualizadas}`);
        process.exit(0);
    } catch (e) {
        console.error(e);
        process.exit(1);
    }
})();
