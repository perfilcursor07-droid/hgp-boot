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

function textoNormalizado(valor) {
    return String(valor || '')
        .normalize('NFD')
        .replace(/[\u0300-\u036f]/g, '')
        .toLowerCase()
        .trim();
}

function metaIndicaSesau(meta = {}) {
    const partes = [
        meta.flowNome,
        meta.nome,
        meta.unidadeNome,
        meta.unidadeCodigo,
        ...(Array.isArray(meta.unidadeCodigos) ? meta.unidadeCodigos : []),
        ...(Array.isArray(meta.unidadeNomes) ? meta.unidadeNomes : [])
    ];

    return partes.some((parte) => textoNormalizado(parte).includes('sesau'));
}

function normalizarFluxoSesau(flow, meta = {}) {
    if (!flow || !metaIndicaSesau(meta)) return flow;

    flow.permitirHospitais = true;

    const blocos = flow.blocos || {};
    for (const bloco of Object.values(blocos)) {
        if (!Array.isArray(bloco.campos)) continue;

        const campoUnidade = bloco.campos.find((campo) => campo.key === 'unidade');
        if (!campoUnidade) continue;

        campoUnidade.label = 'UNIDADE';
        campoUnidade.obrigatorio = true;
        campoUnidade.tipo = 'opcoes';
        campoUnidade.opcoes = OPCOES_UNIDADE_SESAU;
    }

    return flow;
}

module.exports = {
    OPCOES_UNIDADE_SESAU,
    normalizarFluxoSesau,
    textoNormalizado
};
