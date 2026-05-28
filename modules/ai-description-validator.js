// ════════════════════════════════════════════════════════════════════
// AI Description Validator — DeepSeek Flash V4
// ════════════════════════════════════════════════════════════════════
// Valida se a descrição do problema é suficientemente detalhada.
// Se for vaga, retorna uma mensagem pedindo mais informações.
// ════════════════════════════════════════════════════════════════════

const axios = require('axios');

const DEEPSEEK_API_KEY = process.env.DEEPSEEK_API_KEY || '';
const DEEPSEEK_BASE_URL = process.env.DEEPSEEK_BASE_URL || 'https://api.deepseek.com';

const SYSTEM_PROMPT = `Você é um assistente de triagem de chamados de TI em um hospital.
Sua função é avaliar se a descrição do problema enviada pelo usuário é clara e específica o suficiente para que um técnico entenda o que precisa ser feito.

REGRAS OBRIGATÓRIAS:
- A descrição DEVE informar qual é o DEFEITO ou SINTOMA (ex: "não liga", "papel preso", "tela preta", "erro ao imprimir", "sem internet").
- Descrições que contêm APENAS o nome de um equipamento, local, setor, pessoa, ou apenas repetem a categoria são INSUFICIENTES.
- Descrições com UMA ÚNICA PALAVRA são SEMPRE insuficientes (ex: "Impressora", "Computador", "Internet", "Soul").
- Mesmo com duas palavras, se não descrever um defeito/sintoma, é INSUFICIENTE (ex: "Impressora Recepção" → não diz o que tem de errado).
- Descrições curtas MAS que indicam o problema são ACEITAS (ex: "mouse sem funcionar", "sem internet", "tela azul", "não imprime").

RESPONDA APENAS em formato JSON:
- Se a descrição for suficiente: {"aprovado": true}
- Se a descrição for insuficiente: {"aprovado": false, "motivo": "breve explicação do que falta", "sugestao": "pergunta para guiar o usuário a detalhar melhor"}

Exemplos de descrições INSUFICIENTES:
- "Impressora" → apenas o nome do equipamento, não diz o defeito
- "Computador" → apenas o tipo de equipamento
- "Recepção do SVO" → não diz qual é o problema
- "Farmácia" → apenas o nome do setor
- "Soul MV" → apenas o nome do sistema
- "Maria" → apenas um nome
- "ajuda" → muito genérico
- "Impressora Recepção" → não indica o defeito

Exemplos de descrições SUFICIENTES:
- "Impressora não imprime"
- "Impressora com papel preso"
- "Computador da recepção não liga"
- "Não consigo acessar o Soul MV, dá erro de senha"
- "Internet caiu no setor de farmácia"
- "Mouse sem funcionar"
- "Tela azul ao ligar"
- "Erro ao imprimir relatório"`;

/**
 * Valida a descrição do problema usando DeepSeek AI.
 * @param {string} descricao - Texto da descrição enviada pelo usuário
 * @param {string} categoria - Categoria do chamado (para contexto)
 * @returns {Promise<{aprovado: boolean, mensagem?: string}>}
 */
async function validarDescricao(descricao, categoria = '') {
    // Se não tem API key configurada, aprovar sempre (fallback)
    if (!DEEPSEEK_API_KEY) {
        console.warn('[AI-Validator] DEEPSEEK_API_KEY não configurada, aprovando descrição automaticamente.');
        return { aprovado: true };
    }

    // Validação básica de comprimento (menos de 3 caracteres é sempre insuficiente)
    if (!descricao || descricao.trim().length < 3) {
        return {
            aprovado: false,
            mensagem: '⚠️ Sua descrição está muito curta. Por favor, descreva o problema com mais detalhes.\n\n💡 *Exemplo:* "Computador não liga", "Impressora com erro", "Sistema travando ao abrir tal módulo"'
        };
    }

    // Validação local: descrição com apenas 1 palavra é sempre insuficiente
    const palavras = descricao.trim().split(/\s+/);
    if (palavras.length <= 1) {
        return {
            aprovado: false,
            mensagem: '⚠️ Sua descrição está muito vaga. Diga *qual é o problema* com o equipamento ou sistema.\n\n💡 *Exemplos:*\n• "Impressora não imprime"\n• "Computador travando"\n• "Sem internet"\n• "Erro ao abrir o sistema"\n\n📝 Envie uma nova descrição:'
        };
    }

    try {
        const userMessage = categoria
            ? `Categoria do chamado: ${categoria}\nDescrição enviada pelo usuário: "${descricao}"`
            : `Descrição enviada pelo usuário: "${descricao}"`;

        const response = await axios.post(
            `${DEEPSEEK_BASE_URL}/chat/completions`,
            {
                model: 'deepseek-chat',
                messages: [
                    { role: 'system', content: SYSTEM_PROMPT },
                    { role: 'user', content: userMessage }
                ],
                temperature: 0.1,
                max_tokens: 200,
                stream: false
            },
            {
                headers: {
                    'Content-Type': 'application/json',
                    'Authorization': `Bearer ${DEEPSEEK_API_KEY}`
                },
                timeout: 10000 // 10 segundos timeout
            }
        );

        const content = response.data?.choices?.[0]?.message?.content || '';
        
        // Tentar parsear o JSON da resposta
        const jsonMatch = content.match(/\{[\s\S]*\}/);
        if (!jsonMatch) {
            // Se não conseguiu parsear, aprovar (fail-safe)
            console.warn('[AI-Validator] Resposta não-JSON da IA, aprovando:', content);
            return { aprovado: true };
        }

        const resultado = JSON.parse(jsonMatch[0]);

        if (resultado.aprovado) {
            return { aprovado: true };
        }

        // Montar mensagem amigável para o usuário
        const mensagem = [
            '⚠️ Sua descrição parece *insuficiente* para abrirmos o chamado.',
            '',
            resultado.motivo ? `📋 *Motivo:* ${resultado.motivo}` : '',
            '',
            resultado.sugestao ? `💡 *${resultado.sugestao}*` : '💡 *Por favor, descreva especificamente qual é o problema.*',
            '',
            '_Exemplos: "computador não liga", "impressora com erro de papel", "sistema travando ao abrir módulo X"_',
            '',
            '📝 Envie uma nova descrição:'
        ].filter(Boolean).join('\n');

        return { aprovado: false, mensagem };

    } catch (error) {
        // Em caso de erro na API, aprovar a descrição (não bloquear o usuário)
        console.error('[AI-Validator] Erro ao validar descrição:', error.message);
        return { aprovado: true };
    }
}

module.exports = { validarDescricao };
