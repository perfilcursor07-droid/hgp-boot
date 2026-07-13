// ════════════════════════════════════════════════════════════════════
// Seed: cria a unidade HGP e vincula tudo que já existe a ela
// ════════════════════════════════════════════════════════════════════
require('dotenv').config();
const db = require('../config/database');

const FLUXO_HGP = {
    nome: 'Fluxo HGP (Original)',
    menuPrincipal: {
        titulo: '🤖 *MENU PRINCIPAL — HGP*',
        opcoes: [
            { id: '1', label: 'Soul MV',           categoria: 'Soul MV',           camposBloco: 'padrao' },
            { id: '2', label: 'Impressora',        categoria: 'Impressora',        camposBloco: 'padrao' },
            { id: '3', label: 'Suporte Técnico',   categoria: 'Suporte Técnico',   camposBloco: 'padrao' },
            { id: '4', label: 'Telefonia / VOIP',  categoria: 'Telefonia / VOIP',  camposBloco: 'padrao' },
            { id: '5', label: 'Outras',            categoria: 'Outras Solicitações', camposBloco: 'padrao' }
        ]
    },
    submenus: {},
    blocos: {
        padrao: {
            campos: [
                { key: 'nome_completo', label: 'NOME COMPLETO',          obrigatorio: true,  tipo: 'texto' },
                { key: 'setor',         label: 'SETOR',                  obrigatorio: true,  tipo: 'texto' },
                { key: 'ip',            label: 'IP DA MÁQUINA',          obrigatorio: false, tipo: 'texto' },
                { key: 'telefone',      label: 'TELEFONE PARA CONTATO',  obrigatorio: false, tipo: 'telefone' },
                { key: 'descricao',     label: 'DESCRIÇÃO DO PROBLEMA',  obrigatorio: true,  tipo: 'texto_longo' }
            ]
        }
    },
    avaliacao: {
        habilitada: true,
        texto: '⭐ *Avalie nosso atendimento*\n\nDe 1 a 5, como foi o atendimento?\n\n1️⃣ Péssimo\n2️⃣ Ruim\n3️⃣ Regular\n4️⃣ Bom\n5️⃣ Excelente\n\n_Sistema versão 2.1 — Desenvolvido por Erick Vinicius (62) 98101-3083_'
    },
    inatividadeMinutos: 10
};

(async () => {
    try {
        // ── 1. Criar/garantir a unidade HGP ──
        let unidadeHgpId;
        const [existHgp] = await db.query("SELECT id FROM unidades WHERE codigo = 'HGP'");
        if (existHgp.length > 0) {
            unidadeHgpId = existHgp[0].id;
            console.log(`⊙ Unidade HGP já existe (id=${unidadeHgpId})`);
        } else {
            const [r] = await db.query(
                `INSERT INTO unidades (nome, codigo, descricao, cor, ativo)
                 VALUES (?, 'HGP', ?, '#25d366', TRUE)`,
                ['Hospital Geral Público', 'Unidade principal — sistema legado original']
            );
            unidadeHgpId = r.insertId;
            console.log(`✓ Unidade HGP criada (id=${unidadeHgpId})`);
        }

        // ── 2. Criar/garantir o fluxo HGP ──
        let flowHgpId;
        const [existFlow] = await db.query("SELECT id FROM bot_flows_v2 WHERE nome = ?", [FLUXO_HGP.nome]);
        if (existFlow.length > 0) {
            flowHgpId = existFlow[0].id;
            await db.query(
                `UPDATE bot_flows_v2 SET definicao_json = ?, ativo = TRUE WHERE id = ?`,
                [JSON.stringify(FLUXO_HGP), flowHgpId]
            );
            console.log(`⊙ Fluxo HGP atualizado (id=${flowHgpId})`);
        } else {
            const [r] = await db.query(
                `INSERT INTO bot_flows_v2 (nome, descricao, definicao_json, is_default, ativo)
                 VALUES (?, ?, ?, FALSE, TRUE)`,
                [FLUXO_HGP.nome, 'Fluxo original do HGP — espelho do chatbot-handler.js', JSON.stringify(FLUXO_HGP)]
            );
            flowHgpId = r.insertId;
            console.log(`✓ Fluxo HGP criado (id=${flowHgpId})`);
        }

        // ── 3. Vincular instância legada à HGP ──
        const [legacyUpd] = await db.query(
            `UPDATE instancias SET unidade_id = ?, flow_id = ? WHERE is_legacy = TRUE`,
            [unidadeHgpId, flowHgpId]
        );
        console.log(`✓ Instância legada vinculada à HGP (${legacyUpd.affectedRows} linha)`);

        // ── 4. Vincular todos os chamados existentes (sem unidade) à HGP ──
        const [chamUpd] = await db.query(
            `UPDATE chamados SET unidade_id = ? WHERE unidade_id IS NULL`,
            [unidadeHgpId]
        );
        console.log(`✓ Chamados antigos vinculados à HGP (${chamUpd.affectedRows} chamados)`);

        // ── 5. Vincular todos os usuários ativos à HGP ──
        const [admins] = await db.query(`SELECT id FROM admins WHERE ativo = TRUE`);
        let novosVincs = 0;
        for (const a of admins) {
            try {
                await db.query(
                    `INSERT IGNORE INTO admin_unidades (admin_id, unidade_id) VALUES (?, ?)`,
                    [a.id, unidadeHgpId]
                );
                novosVincs++;
            } catch (e) {}
        }
        console.log(`✓ ${novosVincs} usuários vinculados à HGP`);

        console.log('\n══════════════════════════════════════════════════════════');
        console.log('  ✅ Seed HGP concluído!');
        console.log('══════════════════════════════════════════════════════════');
        console.log(`  Unidade HGP id: ${unidadeHgpId}`);
        console.log(`  Fluxo HGP id:   ${flowHgpId}`);
        console.log(`  Chamados:       ${chamUpd.affectedRows} vinculados`);
        console.log(`  Usuários:       ${novosVincs} vinculados`);
        console.log('══════════════════════════════════════════════════════════');
        process.exit(0);
    } catch (e) {
        console.error('Erro:', e);
        process.exit(1);
    }
})();
