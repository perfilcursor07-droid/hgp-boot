// ════════════════════════════════════════════════════════════════════
// Media Manager — Compressão e limpeza de mídia do chat
// ════════════════════════════════════════════════════════════════════
// Objetivo: reduzir o consumo de disco mantendo as mídias visíveis
// durante o atendimento. Após o chamado ser finalizado há X dias,
// os arquivos físicos são removidos (banco mantém registro).
// ════════════════════════════════════════════════════════════════════

const fs = require('fs/promises');
const fsSync = require('fs');
const path = require('path');
const sharp = require('sharp');

const CHAT_MEDIA_DIR = path.join(__dirname, '..', 'public', 'uploads', 'chat-media');

// Configurações
const CONFIG = {
    // Imagens: tamanho máximo e qualidade
    IMAGE_MAX_WIDTH: 1280,
    IMAGE_MAX_HEIGHT: 1280,
    IMAGE_QUALITY: 75,
    
    // Dias após finalização do chamado para apagar mídia física
    DIAS_RETENCAO_POS_FINALIZACAO: 7,
    
    // Intervalo de limpeza automática (em ms) — 24h
    INTERVALO_LIMPEZA: 24 * 60 * 60 * 1000,
};

/**
 * Comprime uma imagem reduzindo dimensões e qualidade.
 * @param {string} filePath - Caminho absoluto do arquivo
 * @param {string} mimeType - MIME type da imagem
 * @returns {Promise<{originalSize: number, newSize: number, ratio: number}>}
 */
async function comprimirImagem(filePath, mimeType) {
    if (!mimeType || !mimeType.startsWith('image/')) {
        return null;
    }
    
    // Não comprimir GIF (animação) nem SVG
    if (mimeType.includes('gif') || mimeType.includes('svg')) {
        return null;
    }

    try {
        const stats = await fs.stat(filePath);
        const originalSize = stats.size;
        
        // Ler buffer original
        const buffer = await fs.readFile(filePath);
        
        let pipeline = sharp(buffer)
            .rotate() // auto-rotate baseado no EXIF
            .resize(CONFIG.IMAGE_MAX_WIDTH, CONFIG.IMAGE_MAX_HEIGHT, {
                fit: 'inside',
                withoutEnlargement: true
            });
        
        // Converter para JPEG (mais eficiente) para fotos comuns
        if (mimeType.includes('png') || mimeType.includes('webp') || mimeType.includes('jpeg') || mimeType.includes('jpg')) {
            pipeline = pipeline.jpeg({ quality: CONFIG.IMAGE_QUALITY, mozjpeg: true });
        }
        
        const novoBuffer = await pipeline.toBuffer();
        
        // Só substitui se houve ganho (>10%)
        if (novoBuffer.length < originalSize * 0.9) {
            await fs.writeFile(filePath, novoBuffer);
            return {
                originalSize,
                newSize: novoBuffer.length,
                ratio: 1 - (novoBuffer.length / originalSize)
            };
        }
        
        return { originalSize, newSize: originalSize, ratio: 0 };
    } catch (err) {
        console.error('[MediaManager] Erro ao comprimir imagem:', err.message);
        return null;
    }
}

/**
 * Apaga arquivos de mídia de chamados finalizados há mais de X dias.
 * Mantém o registro no banco (apenas remove o arquivo físico).
 * @param {object} db - conexão MySQL pool
 * @returns {Promise<{arquivosRemovidos: number, espacoLiberado: number}>}
 */
async function limparMidiaAntiga(db) {
    let arquivosRemovidos = 0;
    let espacoLiberado = 0;
    
    try {
        // Buscar mensagens com mídia de chamados finalizados há mais de N dias
        const [mensagens] = await db.query(
            `SELECT cm.id, cm.media_url, cm.media_filename
             FROM chat_messages cm
             INNER JOIN chamados c ON c.id = cm.chamado_id
             WHERE cm.media_url IS NOT NULL
               AND cm.media_url != ''
               AND cm.media_url NOT LIKE '%[expirado]%'
               AND c.status = 'finalizado'
               AND c.encerrado_em IS NOT NULL
               AND c.encerrado_em < DATE_SUB(NOW(), INTERVAL ? DAY)`,
            [CONFIG.DIAS_RETENCAO_POS_FINALIZACAO]
        );
        
        for (const msg of mensagens) {
            try {
                // Extrair filename do media_url (formato: /uploads/chat-media/arquivo.ext)
                const filename = path.basename(msg.media_url);
                const filePath = path.join(CHAT_MEDIA_DIR, filename);
                
                // Verificar se arquivo existe
                if (fsSync.existsSync(filePath)) {
                    const stats = await fs.stat(filePath);
                    espacoLiberado += stats.size;
                    await fs.unlink(filePath);
                    arquivosRemovidos++;
                }
                
                // Marca no banco que o arquivo foi expirado
                await db.query(
                    `UPDATE chat_messages 
                     SET media_url = CONCAT('[expirado]', COALESCE(media_url, ''))
                     WHERE id = ?`,
                    [msg.id]
                );
            } catch (e) {
                console.error(`[MediaManager] Erro ao remover ${msg.media_url}:`, e.message);
            }
        }
        
        if (arquivosRemovidos > 0) {
            const mb = (espacoLiberado / 1024 / 1024).toFixed(2);
            console.log(`[MediaManager] ✓ Limpeza concluída: ${arquivosRemovidos} arquivos removidos, ${mb} MB liberados.`);
        }
        
        return { arquivosRemovidos, espacoLiberado };
    } catch (err) {
        console.error('[MediaManager] Erro na limpeza de mídia:', err.message);
        return { arquivosRemovidos: 0, espacoLiberado: 0 };
    }
}

/**
 * Apaga arquivos órfãos: arquivos no disco que não têm referência no banco.
 * @param {object} db
 */
async function limparArquivosOrfaos(db) {
    try {
        if (!fsSync.existsSync(CHAT_MEDIA_DIR)) return { removidos: 0 };
        
        const arquivos = await fs.readdir(CHAT_MEDIA_DIR);
        if (arquivos.length === 0) return { removidos: 0 };
        
        // Buscar todas as URLs de mídia do banco
        const [rows] = await db.query(
            `SELECT media_url FROM chat_messages WHERE media_url IS NOT NULL`
        );
        const referenciados = new Set();
        for (const r of rows) {
            const url = String(r.media_url || '').replace('[expirado]', '');
            if (url) referenciados.add(path.basename(url));
        }
        
        let removidos = 0;
        let espaco = 0;
        for (const arquivo of arquivos) {
            if (!referenciados.has(arquivo)) {
                try {
                    const filePath = path.join(CHAT_MEDIA_DIR, arquivo);
                    const stats = await fs.stat(filePath);
                    // Só apaga arquivos com mais de 1 dia (evita race condition com upload em curso)
                    const idadeHoras = (Date.now() - stats.mtime.getTime()) / (1000 * 60 * 60);
                    if (idadeHoras > 24) {
                        espaco += stats.size;
                        await fs.unlink(filePath);
                        removidos++;
                    }
                } catch (e) {}
            }
        }
        
        if (removidos > 0) {
            const mb = (espaco / 1024 / 1024).toFixed(2);
            console.log(`[MediaManager] ✓ Arquivos órfãos removidos: ${removidos}, ${mb} MB.`);
        }
        
        return { removidos };
    } catch (err) {
        console.error('[MediaManager] Erro ao limpar órfãos:', err.message);
        return { removidos: 0 };
    }
}

/**
 * Calcula estatísticas de uso de disco com a mídia.
 * @param {object} db
 */
async function estatisticasMidia(db) {
    try {
        if (!fsSync.existsSync(CHAT_MEDIA_DIR)) {
            return { arquivos: 0, espacoTotal: 0, espacoTotalMB: '0' };
        }
        
        const arquivos = await fs.readdir(CHAT_MEDIA_DIR);
        let espacoTotal = 0;
        for (const arquivo of arquivos) {
            try {
                const stats = await fs.stat(path.join(CHAT_MEDIA_DIR, arquivo));
                espacoTotal += stats.size;
            } catch (e) {}
        }
        
        return {
            arquivos: arquivos.length,
            espacoTotal,
            espacoTotalMB: (espacoTotal / 1024 / 1024).toFixed(2)
        };
    } catch (err) {
        return { arquivos: 0, espacoTotal: 0, espacoTotalMB: '0' };
    }
}

/**
 * Inicia rotina automática de limpeza (executa na inicialização e a cada 24h).
 * @param {object} db
 */
function iniciarLimpezaAutomatica(db) {
    // Executa na inicialização (com delay para não travar o boot)
    setTimeout(async () => {
        console.log('[MediaManager] Executando limpeza inicial...');
        await limparMidiaAntiga(db);
        await limparArquivosOrfaos(db);
        const stats = await estatisticasMidia(db);
        console.log(`[MediaManager] Estado atual: ${stats.arquivos} arquivos, ${stats.espacoTotalMB} MB.`);
    }, 30 * 1000); // 30s após inicialização
    
    // Executa periodicamente
    setInterval(async () => {
        await limparMidiaAntiga(db);
        await limparArquivosOrfaos(db);
    }, CONFIG.INTERVALO_LIMPEZA);
}

module.exports = {
    comprimirImagem,
    limparMidiaAntiga,
    limparArquivosOrfaos,
    estatisticasMidia,
    iniciarLimpezaAutomatica,
    CONFIG
};
