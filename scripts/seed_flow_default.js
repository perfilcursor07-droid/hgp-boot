// Seed do fluxo padrão (o novo fluxo de SERVIÇOS)
require('dotenv').config();
const db = require('../config/database');

const FLUXO_DEFAULT = {
    nome: 'Fluxo Serviços (Padrão)',
    menuPrincipal: {
        titulo: '🤖 *MENU PRINCIPAL — SERVIÇOS*',
        opcoes: [
            { id: '1', label: 'Suporte Técnico',         categoria: 'Suporte Técnico',         camposBloco: 'padrao' },
            { id: '2', label: 'Impressora',              categoria: 'Impressora',              camposBloco: 'impressora' },
            { id: '3', label: 'Telefonia VOIP',          categoria: 'Telefonia VOIP',          camposBloco: 'padrao' },
            { id: '4', label: 'Intranet',                categoria: 'Intranet',                camposBloco: 'padrao', submenu: 'intranet' },
            { id: '5', label: 'Abrir Garantia Positivo', categoria: 'Garantia Positivo',       camposBloco: 'garantia' },
            { id: '6', label: 'Visita Técnica Hospital/Anexos', categoria: 'Visita Técnica',  camposBloco: 'padrao' },
            { id: '7', label: 'Outros',                  categoria: 'Outros',                  camposBloco: 'padrao' }
        ]
    },
    submenus: {
        intranet: {
            titulo: '🌐 *INTRANET — ESCOLHA O SISTEMA*',
            opcoes: [
                { id: '1', label: 'Recursos Humanos' },
                { id: '2', label: 'Avaliação Periódica' },
                { id: '3', label: 'Passagens Aéreas' },
                { id: '4', label: 'Escalas' },
                { id: '5', label: 'SGI' },
                { id: '6', label: 'SISGC' }
            ]
        }
    },
    blocos: {
        padrao: {
            campos: [
                { key: 'unidade',         label: 'UNIDADE',                 obrigatorio: true,  tipo: 'texto' },
                { key: 'setor',           label: 'SETOR',                   obrigatorio: true,  tipo: 'texto' },
                { key: 'nome_completo',   label: 'NOME COMPLETO',           obrigatorio: true,  tipo: 'texto' },
                { key: 'cpf',             label: 'CPF',                     obrigatorio: true,  tipo: 'cpf'   },
                { key: 'email',           label: 'E-MAIL',                  obrigatorio: true,  tipo: 'email' },
                { key: 'telefone',        label: 'NÚMERO DE TELEFONE',      obrigatorio: true,  tipo: 'telefone' },
                { key: 'ip',              label: 'IP',                      obrigatorio: false, tipo: 'texto' },
                { key: 'descricao',       label: 'DESCRIÇÃO DO PROBLEMA',   obrigatorio: true,  tipo: 'texto_longo' }
            ]
        },
        impressora: {
            campos: [
                { key: 'unidade',         label: 'UNIDADE',                 obrigatorio: true,  tipo: 'texto' },
                { key: 'setor',           label: 'SETOR',                   obrigatorio: true,  tipo: 'texto' },
                { key: 'codigo_impressora', label: 'CÓDIGO DA IMPRESSORA',  obrigatorio: true,  tipo: 'texto' },
                { key: 'nome_completo',   label: 'NOME COMPLETO',           obrigatorio: true,  tipo: 'texto' },
                { key: 'cpf',             label: 'CPF',                     obrigatorio: true,  tipo: 'cpf'   },
                { key: 'email',           label: 'E-MAIL',                  obrigatorio: true,  tipo: 'email' },
                { key: 'telefone',        label: 'NÚMERO DE TELEFONE',      obrigatorio: true,  tipo: 'telefone' },
                { key: 'ip',              label: 'IP',                      obrigatorio: false, tipo: 'texto' },
                { key: 'descricao',       label: 'DESCRIÇÃO DO PROBLEMA',   obrigatorio: true,  tipo: 'texto_longo' }
            ]
        },
        garantia: {
            campos: [
                { key: 'unidade',         label: 'UNIDADE',                 obrigatorio: true,  tipo: 'texto' },
                { key: 'setor',           label: 'SETOR',                   obrigatorio: true,  tipo: 'texto' },
                { key: 'numero_serie',    label: 'NÚMERO DE SÉRIE DO EQUIPAMENTO', obrigatorio: true, tipo: 'texto' },
                { key: 'nome_completo',   label: 'NOME COMPLETO',           obrigatorio: true,  tipo: 'texto' },
                { key: 'cpf',             label: 'CPF',                     obrigatorio: true,  tipo: 'cpf'   },
                { key: 'email',           label: 'E-MAIL',                  obrigatorio: true,  tipo: 'email' },
                { key: 'telefone',        label: 'NÚMERO DE TELEFONE',      obrigatorio: true,  tipo: 'telefone' },
                { key: 'ip',              label: 'IP',                      obrigatorio: false, tipo: 'texto' },
                { key: 'descricao',       label: 'DESCRIÇÃO DO PROBLEMA',   obrigatorio: true,  tipo: 'texto_longo' }
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
        const [existing] = await db.query('SELECT id FROM bot_flows_v2 WHERE nome = ?', [FLUXO_DEFAULT.nome]);
        if (existing.length > 0) {
            await db.query(
                `UPDATE bot_flows_v2 SET definicao_json = ?, is_default = TRUE, ativo = TRUE WHERE id = ?`,
                [JSON.stringify(FLUXO_DEFAULT), existing[0].id]
            );
            console.log('✓ Fluxo padrão atualizado (id=' + existing[0].id + ')');
        } else {
            const [r] = await db.query(
                `INSERT INTO bot_flows_v2 (nome, descricao, definicao_json, is_default, ativo)
                 VALUES (?, ?, ?, TRUE, TRUE)`,
                [FLUXO_DEFAULT.nome, 'Fluxo padrão de serviços com 7 categorias e submenu de intranet', JSON.stringify(FLUXO_DEFAULT)]
            );
            console.log('✓ Fluxo padrão inserido (id=' + r.insertId + ')');
        }
        process.exit(0);
    } catch (e) {
        console.error(e);
        process.exit(1);
    }
})();
