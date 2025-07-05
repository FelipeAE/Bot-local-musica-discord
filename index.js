const { Client, GatewayIntentBits, PermissionsBitField, ActionRowBuilder, ButtonBuilder, ButtonStyle, StringSelectMenuBuilder } = require('discord.js');
const { joinVoiceChannel, createAudioPlayer, createAudioResource, AudioPlayerStatus, StreamType } = require('@discordjs/voice');
const { exec } = require('child_process');
const { spawn } = require('child_process');
const fs = require('fs');
const path = require('path');
const { v4: uuidv4 } = require('uuid'); // NEW: Para nombres de archivo únicos
const { createLogger, format, transports } = require('winston');
const moment = require('moment-timezone');
const { title } = require('process');
const { url } = require('inspector');
const { get } = require('http');
const config = require('./config.json');

// Configura tu zona horaria desde el archivo de configuración
const TIMEZONE = config.timezone || 'America/Santiago';

const logger = createLogger({
    level: 'info',
    format: format.combine(
        format.timestamp(),
        format.printf(({ timestamp, level, message }) => {
            // Formatea la fecha con tu zona horaria
            const localTime = moment(timestamp).tz(TIMEZONE).format('DD-MM-YY HH:mm');
            return `${localTime} [${level.toUpperCase()}]: ${message}`;
        })
    ),
    transports: [
        new transports.File({ filename: 'music-bot.log' }),
        new transports.Console()
    ]
});

// Guardar el PID del proceso actual en un archivo
const pidFile = path.join(__dirname, 'bot.pid');
fs.writeFileSync(pidFile, process.pid.toString(), 'utf8');

// Al iniciar, matar procesos huérfanos y limpiar archivos temporales
async function cleanupOnStart() {
    try {
        // Limpiar archivos temporales antiguos
        const files = fs.readdirSync(__dirname);
        const tempFiles = files.filter(file => file.startsWith('temp_audio_'));
        
        for (const file of tempFiles) {
            try {
                fs.unlinkSync(path.join(__dirname, file));
                logger.info(`Archivo temporal limpiado al inicio: ${file}`);
            } catch (error) {
                logger.warn(`No se pudo limpiar archivo temporal: ${file}`);
            }
        }
        
        logger.info('Limpieza inicial completada');
    } catch (error) {
        logger.error(`Error en limpieza inicial: ${error.message}`);
    }
}

// Ejecutar limpieza al inicio
cleanupOnStart();

let queue = [];
let player;
let currentVolume = 1;
let connection;
let isProcessing = false;
let currentSong = null;
let buttonsSent = false;
let controlMessage = null;  // Almacena el mensaje de controles
let lastChannelId = null;   // Guarda el ID del último canal donde se enviaron controles 
const processes = new Set(); // NEW: Trackear procesos hijos
// let repeatMode = 'none'; // 'none' | 'song' | 'playlist'
let originalPlaylist = []; // Para guardar la playlist original
const queueButton = new ButtonBuilder()
    .setCustomId('show_queue')
    .setLabel('🎵 Mostrar Cola')
    .setStyle(ButtonStyle.Primary);



const client = new Client({
    intents: [
        GatewayIntentBits.Guilds,
        GatewayIntentBits.GuildVoiceStates,
        GatewayIntentBits.GuildMessages,
        GatewayIntentBits.MessageContent
    ]
});

// Cache para evitar llamadas duplicadas a getVideoInfo
const videoInfoCache = new Map();

async function getVideoInfo(url) {
    return new Promise((resolve, reject) => {
        // Verificar cache para evitar llamadas duplicadas
        if (videoInfoCache.has(url)) {
            logger.info(`Usando información cacheada para: ${url}`);
            resolve(videoInfoCache.get(url));
            return;
        }
        
        // Limpiar la URL antes de obtener el título
        const cleanedUrl = cleanYouTubeUrl(url);
        
        logger.info(`🎯 Obteniendo información del video (timeout 3s)...`);
        
        // Timeout manual muy agresivo para respuesta rápida
        const timeoutId = setTimeout(() => {
            logger.warn(`⏰ Timeout rápido - usando fallback`);
            const fallbackInfo = { 
                title: 'Video de YouTube', 
                duration: 0, 
                isLong: false,
                originalTitle: 'Video de YouTube',
                durationFormatted: ''
            };
            videoInfoCache.set(url, fallbackInfo);
            resolve(fallbackInfo);
        }, 3000); // Solo 3 segundos
        
        exec(`yt-dlp --get-title --get-duration --no-warnings "${cleanedUrl}"`, { 
            timeout: 2000, 
            encoding: 'utf8',
            env: { ...process.env, PYTHONIOENCODING: 'utf-8' }
        }, (error, stdout, stderr) => {
            clearTimeout(timeoutId);
            
            if (error) {
                logger.warn(`⚠️ Error obteniendo información (usando fallback): ${error.message}`);
                const fallbackInfo = { 
                    title: 'Video de YouTube', 
                    duration: 0, 
                    isLong: false,
                    originalTitle: 'Video de YouTube',
                    durationFormatted: ''
                };
                videoInfoCache.set(url, fallbackInfo);
                resolve(fallbackInfo);
            } else {
                // Asegurar que el stdout esté en UTF-8
                const lines = stdout.trim().split('\n');
                let title = lines[0] || 'Video de YouTube';
                const durationFormatted = lines[1] || '';
                
                // Normalizar el título para caracteres especiales
                title = normalizeUTF8(title);
                
                // Convertir duración a segundos
                let durationSeconds = 0;
                if (durationFormatted.includes(':')) {
                    const parts = durationFormatted.split(':').map(p => parseInt(p) || 0);
                    if (parts.length === 3) { // HH:MM:SS
                        durationSeconds = parts[0] * 3600 + parts[1] * 60 + parts[2];
                    } else if (parts.length === 2) { // MM:SS
                        durationSeconds = parts[0] * 60 + parts[1];
                    }
                }
                
                const longThreshold = config.longVideoDurationThreshold || 3600;
                const isLong = durationSeconds > longThreshold;
                
                let finalTitle = title;
                if (durationFormatted) {
                    finalTitle = isLong ? `${title} ⚠️ (${durationFormatted})` : `${title} (${durationFormatted})`;
                }
                
                const videoInfo = { 
                    title: finalTitle, 
                    duration: durationSeconds, 
                    isLong: isLong,
                    originalTitle: title,
                    durationFormatted: durationFormatted
                };
                
                logger.info(`✅ Info obtenida: ${title} (${durationFormatted})`);
                
                // Cache por 5 minutos
                videoInfoCache.set(url, videoInfo);
                setTimeout(() => videoInfoCache.delete(url), 300000);
                
                resolve(videoInfo);
            }
        });
    });
}

// Mantener función anterior para compatibilidad
async function getVideoTitle(url) {
    const info = await getVideoInfo(url);
    return info.title;
}

async function addSongToQueue(url, member, channel, voiceChannel, skipConfirmation = false) {
    try {
        // Verificar si ya se está procesando esta URL para evitar duplicados
        const isDuplicate = queue.some(song => song.url === url) || (currentSong && currentSong.url === url);
        if (isDuplicate) {
            logger.warn(`URL duplicada detectada, ignorando: ${url}`);
            return;
        }
        
        logger.info(`🔍 Iniciando addSongToQueue para: ${url}`);
        const videoInfo = await getVideoInfo(url);  // Obtener información completa
        logger.info(`📊 Información del video obtenida: ${JSON.stringify(videoInfo)}`);
        
        // Verificar si es un video muy largo y no se saltó la confirmación
        if (videoInfo.isLong && !skipConfirmation) {
            logger.info(`⚠️ Video largo detectado, solicitando confirmación...`);
            let warningText = `**${videoInfo.originalTitle}**\n\nDuración: ${videoInfo.durationFormatted}\n\nEste video puede tardar mucho en descargar y consumir mucho espacio.`;
            
            // Advertencia adicional para videos HLS
            if (videoInfo.usesHLS) {
                warningText += `\n\n⚠️ **ADVERTENCIA**: Este video usa formato HLS (streaming) que puede ser inestable para descargas largas. Puede fallar o colgarse.`;
            }
            
            warningText += `\n¿Deseas continuar?`;
            
            const confirmEmbed = {
                color: videoInfo.usesHLS ? 0xFF6600 : 0xFFAA00, // Naranja más intenso para HLS
                title: videoInfo.usesHLS ? '⚠️ Video Largo HLS Detectado' : '⚠️ Video Largo Detectado',
                description: warningText,
                footer: { text: 'Reacciona con ✅ para confirmar o ❌ para cancelar (30 segundos)' }
            };
            
            const confirmMessage = await channel.send({ embeds: [confirmEmbed] });
            
            try {
                await confirmMessage.react('✅');
                await confirmMessage.react('❌');
            } catch (reactionError) {
                logger.error(`Error añadiendo reacciones: ${reactionError.message}`);
                // Continuar sin confirmación si hay error con reacciones
                confirmMessage.edit({ 
                    embeds: [{ 
                        color: 0xFFA500, 
                        title: '⚠️ Sistema de confirmación no disponible', 
                        description: 'Añadiendo video largo sin confirmación...' 
                    }] 
                });
            }
            
            // Esperar reacción del usuario
            const filter = (reaction, user) => {
                return ['✅', '❌'].includes(reaction.emoji.name) && user.id === member.user.id;
            };
            
            try {
                const collected = await confirmMessage.awaitReactions({ 
                    filter, 
                    max: 1, 
                    time: 30000, 
                    errors: ['time'] 
                });
                
                const reaction = collected.first();
                
                if (reaction.emoji.name === '❌') {
                    const cancelEmbed = {
                        color: 0xFF0000,
                        title: '❌ Video Cancelado',
                        description: 'El video no se añadió a la cola.'
                    };
                    confirmMessage.edit({ embeds: [cancelEmbed], components: [] });
                    return;
                }
                
                if (reaction.emoji.name === '✅') {
                    const acceptEmbed = {
                        color: 0x00FF00,
                        title: '✅ Video Confirmado',
                        description: `Añadiendo **${videoInfo.originalTitle}** a la cola...`
                    };
                    confirmMessage.edit({ embeds: [acceptEmbed], components: [] });
                }
            } catch (error) {
                const timeoutEmbed = {
                    color: 0x888888,
                    title: '⏱️ Tiempo Agotado',
                    description: 'No se recibió confirmación. El video no se añadió a la cola.'
                };
                confirmMessage.edit({ embeds: [timeoutEmbed], components: [] });
                return;
            }
        }
        
        // Añadir información completa a la cola
        queue.push({ 
            url, 
            title: videoInfo.title, 
            originalTitle: videoInfo.originalTitle,
            duration: videoInfo.duration,
            isLong: videoInfo.isLong,
            member, 
            channel 
        });
        
        logger.info(`✅ Canción añadida a la cola: ${videoInfo.title}`);
        logger.info(`📋 Cola actual tiene ${queue.length} elementos`);
        
        // Mensaje de confirmación
        const addedEmbed = {
            color: 0x00AA00,
            title: '🎵 Canción Añadida',
            description: `**${videoInfo.originalTitle}**${videoInfo.durationFormatted ? `\nDuración: ${videoInfo.durationFormatted}` : ''}`,
            footer: { text: `Posición en cola: ${queue.length}` }
        };
        
        channel.send({ embeds: [addedEmbed] });

        // Si no hay ninguna canción en reproducción, iniciar la reproducción
        if (!isProcessing) {
            logger.info(`🎮 Iniciando reproducción inmediata (no hay procesamiento activo)`);
            playNextInQueue(voiceChannel);
        } else {
            logger.info(`⏳ Video añadido a la cola, hay reproducción en progreso`);
        }
    } catch (error) {
        logger.error('❌ Error al obtener información del video:', error);
        // Agregar sin información como fallback
        queue.push({ url, title: 'Título no disponible', member, channel, isLong: false });
        if (!isProcessing) {
            playNextInQueue(voiceChannel);
        }
    }
}

async function playNextInQueue(voiceChannel) {
    // Resetear controles al iniciar una nueva canción
    buttonsSent = false;

    // Verificación adicional para evitar procesamiento múltiple
    if (isProcessing) {
        logger.warn('playNextInQueue llamado mientras ya se está procesando, ignorando');
        return;
    }

    // Establecer o reestablecer conexión si es necesario
    if (!connection || connection.state.status === 'disconnected') {
        try {
            connection = joinVoiceChannel({
                channelId: voiceChannel.id,
                guildId: voiceChannel.guild.id,
                adapterCreator: voiceChannel.guild.voiceAdapterCreator,
            });
            connection.on('stateChange', (oldState, newState) => {
                if (newState.status === 'disconnected') {
                    logger.warn('Conexión perdida. Intentando reconectar...');
                    setTimeout(() => playNextInQueue(voiceChannel), 5000);
                }
            });
        } catch (error) {
            logger.error(`Error de conexión: ${error.message}`);
            voiceChannel.send('Error al conectar al canal de voz.');
            isProcessing = false;
            return;
        }
    }

    if (queue.length === 0) {
        // Reproducir mensaje de despedida antes de desconectar
        if (connection && voiceChannel) {
            logger.info('🎵 Cola vacía, reproduciendo mensaje de despedida...');
            
            // Buscar el último canal de texto usado
            let lastTextChannel = null;
            if (currentSong && currentSong.channel) {
                lastTextChannel = currentSong.channel;
            }
            
            // Reproducir despedida
            await playGoodbyeMessage(voiceChannel, lastTextChannel);
        }
        
        if (connection) {
            connection.destroy();
            connection = null;
        }
        currentSong = null;
        isProcessing = false;
        buttonsSent = false;
        if (controlMessage) {
            await controlMessage.edit({ components: [] });
            controlMessage = null;
        }
        return;
    }

    // Verificación robusta para evitar procesamiento doble
    if (isProcessing) {
        logger.warn('Ya hay una descarga en proceso, evitando duplicado');
        return;
    }
    
    isProcessing = true;

    const song = queue[0];
    currentSong = song;

    // Generamos un nombre de archivo único para el audio descargado
    const tempPath = path.join(__dirname, `temp_audio_${uuidv4()}.mp3`);
    
    // Timeout unificado de 5 minutos para todos los videos
    const timeout = 300000; // 5 minutos para todos los videos
    
    let downloadMessage = `📥 **Descargando**: ${song.originalTitle || song.title}\n⏰ Tiempo límite: ${Math.round(timeout/60000)} minutos`;
    
    if (song.isLong) {
        downloadMessage = `🕐 **Descargando video largo**: ${song.originalTitle || song.title}\n⏰ Tiempo límite: ${Math.round(timeout/60000)} minutos`;
    }
    
    if (song.usesHLS) {
        downloadMessage += `\n⚠️ **Formato HLS detectado** - La descarga puede ser más lenta o inestable`;
    }
    
    song.channel.send(downloadMessage);

    // Ejecutar yt-dlp con spawn - comando compatible y optimizado
    let ytdlpArgs = [];
    
    // Configurar formato según el tipo de video y si es un reintento
    if (song.customFormat) {
        // Usar formato específico proporcionado por el usuario
        ytdlpArgs.push('-f', song.customFormat);
        logger.info(`🎯 Usando formato específico ${song.customFormat}: ${song.originalTitle}`);
    } else if (song.forceAlternativeFormat) {
        // Múltiples formatos alternativos para videos problemáticos
        if (song.retryAttempt === 1) {
            ytdlpArgs.push('-f', 'worst[ext=mp4]/worst[ext=webm]/worst');
            logger.info(`🔄 Reintento 1 - Usando formato worst: ${song.originalTitle}`);
        } else if (song.retryAttempt === 2) {
            ytdlpArgs.push('-f', 'bestaudio[ext=m4a]/bestaudio[ext=webm]/bestaudio');
            logger.info(`🔄 Reintento 2 - Usando bestaudio específico: ${song.originalTitle}`);
        } else {
            ytdlpArgs.push('-f', 'best[height<=360]/worst');
            logger.info(`🔄 Reintento 3 - Usando calidad baja: ${song.originalTitle}`);
        }
    } else {
        ytdlpArgs.push('-f', 'bestaudio/best');
    }
    
    ytdlpArgs.push(
        '--no-warnings',
        '--no-playlist',
        '-o', tempPath
    );

    // Añadir opciones específicas para videos largos (opciones probadas y compatibles)
    if (song.isLong || song.forceHLS || song.forceAlternativeFormat) {
        ytdlpArgs.push(
            '--retries', '5',
            '--fragment-retries', '5',
            '--socket-timeout', '60',
            '--no-continue',  // Evitar archivos .part problemáticos
            '--concurrent-fragments', '1',  // Un fragmento a la vez para estabilidad
            '--no-part'  // Evitar archivos .part completamente
        );
        
        // Opciones adicionales para HLS forzado
        if (song.forceHLS) {
            ytdlpArgs.push(
                '--hls-use-mpegts',  // Mejor manejo de HLS
                '--hls-prefer-native',  // Usar extractor nativo de HLS
                '--extractor-args', 'youtube:player_client=android'  // Usar cliente Android que a veces evita HLS
            );
            logger.info(`Descargando con configuración experimental HLS: ${song.originalTitle}`);
        } else if (song.forceAlternativeFormat) {
            // Configuración diferente según el intento
            if (song.retryAttempt === 1) {
                ytdlpArgs.push(
                    '--extractor-args', 'youtube:player_client=web',
                    '--prefer-free-formats'
                );
                logger.info(`Reintento 1 con cliente web: ${song.originalTitle}`);
            } else if (song.retryAttempt === 2) {
                ytdlpArgs.push(
                    '--extractor-args', 'youtube:player_client=ios',
                    '--no-check-certificate'
                );
                logger.info(`Reintento 2 con cliente iOS: ${song.originalTitle}`);
            } else {
                ytdlpArgs.push(
                    '--extractor-args', 'youtube:player_client=android',
                    '--format-sort', '+size,+br'
                );
                logger.info(`Reintento 3 con cliente Android: ${song.originalTitle}`);
            }
        } else {
            ytdlpArgs.push('--hls-use-mpegts');
            logger.info(`Descargando video largo con opciones robustas para HLS: ${song.originalTitle}`);
        }
    } else {
        ytdlpArgs.push(
            '--retries', '3',
            '--fragment-retries', '3',
            '--socket-timeout', '30'
        );
    }

    ytdlpArgs.push(song.url);

    logger.info(`Ejecutando: yt-dlp ${ytdlpArgs.join(' ')}`);
    const child = spawn('yt-dlp', ytdlpArgs, {
        env: { ...process.env, PYTHONIOENCODING: 'utf-8' },
        stdio: ['pipe', 'pipe', 'pipe']
    });

    // Configurar timeout manualmente con mensaje específico
    let lastProgressTime = Date.now();
    let progressCheckInterval;
    
    const timeoutId = setTimeout(() => {
        const timeoutMinutes = Math.round(timeout/60000);
        logger.error(`Timeout en descarga después de ${timeout}ms (${timeoutMinutes} min) - proceso terminado`);
        child.kill('SIGKILL');
        cleanupTempFile(tempPath);
        cleanupPartFiles(tempPath);
        
        if (progressCheckInterval) clearInterval(progressCheckInterval);
        
        let timeoutMessage;
        if (song.isLong) {
            timeoutMessage = `⏰ **Timeout en video largo** (${timeoutMinutes} min)\n` +
                           `El video era demasiado grande para descargar. Intenta con un video más corto o verifica tu conexión.`;
        } else {
            timeoutMessage = `⏰ **Timeout en descarga** (${timeoutMinutes} min)\n` +
                           `La descarga tardó demasiado. Intenta con una canción más corta.`;
        }
        
        song.channel.send(timeoutMessage);
        queue.shift();
        isProcessing = false;
        playNextInQueue(voiceChannel);
    }, timeout);

    // Heartbeat para detectar procesos colgados (solo para videos largos)
    if (song.isLong) {
        progressCheckInterval = setInterval(() => {
            const now = Date.now();
            const timeSinceLastProgress = now - lastProgressTime;
            
            // Si no hay progreso por 5 minutos, matar el proceso
            if (timeSinceLastProgress > 300000) { // 5 minutos sin progreso
                logger.warn(`Proceso sin progreso por ${Math.round(timeSinceLastProgress/60000)} minutos. Terminando...`);
                clearTimeout(timeoutId);
                clearInterval(progressCheckInterval);
                child.kill('SIGKILL');
                cleanupTempFile(tempPath);
                cleanupPartFiles(tempPath);
                
                song.channel.send(`⚠️ **Descarga estancada**: El video se quedó sin progreso por más de 5 minutos. Cancelando descarga.`);
                queue.shift();
                isProcessing = false;
                playNextInQueue(voiceChannel);
            }
        }, 30000); // Verificar cada 30 segundos
    }

    // Manejo de error al iniciar el proceso
    child.on('error', error => {
        clearTimeout(timeoutId);
        if (progressCheckInterval) clearInterval(progressCheckInterval);
        logger.error(`Error en spawn de yt-dlp: ${error.message}`);
        song.channel.send('❌ Error al iniciar la descarga.');
        cleanupTempFile(tempPath);
        cleanupPartFiles(tempPath);
        queue.shift();
        isProcessing = false; // Asegurar reset del estado
        playNextInQueue(voiceChannel);
    });

    // Recopilar datos de stderr y mostrar progreso
    let stderrData = '';
    let progressMessage = null;
    let lastProgressText = '';
    let progressUpdateTimeout;
    
    child.stderr.on('data', data => {
        stderrData += data;
        const output = data.toString();
        
        // Actualizar tiempo de último progreso
        lastProgressTime = Date.now();
        
        // Mostrar progreso de descarga
        if (output.includes('[download]')) {
            const progressMatch = output.match(/(\d+\.\d+)%/);
            const speedMatch = output.match(/(\d+\.\d+\w+\/s)/);
            const etaMatch = output.match(/ETA (\d+:\d+)/);
            
            if (progressMatch) {
                const progress = progressMatch[1];
                const speed = speedMatch ? speedMatch[1] : '';
                const eta = etaMatch ? etaMatch[1] : '';
                
                const newProgressText = `⬬ **Descargando**: ${song.originalTitle || song.title}\n` +
                                       `📊 Progreso: ${progress}%${speed ? ` | 🚀 ${speed}` : ''}${eta ? ` | ⏱️ ETA: ${eta}` : ''}`;
                
                if (newProgressText !== lastProgressText) {
                    lastProgressText = newProgressText;
                    
                    // Evitar spam de mensajes, actualizar cada 10 segundos máximo
                    if (progressUpdateTimeout) clearTimeout(progressUpdateTimeout);
                    progressUpdateTimeout = setTimeout(async () => {
                        try {
                            if (!progressMessage) {
                                progressMessage = await song.channel.send(newProgressText);
                            } else {
                                await progressMessage.edit(newProgressText);
                            }
                        } catch (editError) {
                            // Si falla editar, crear nuevo mensaje
                            try {
                                progressMessage = await song.channel.send(newProgressText);
                            } catch (sendError) {
                                logger.warn(`Error enviando progreso: ${sendError.message}`);
                            }
                        }
                    }, 10000);
                }
            }
        }
    });

    child.on('close', (code, signal) => {
        // Limpiar timeouts y intervalos
        clearTimeout(timeoutId);
        if (progressCheckInterval) clearInterval(progressCheckInterval);
        if (progressUpdateTimeout) clearTimeout(progressUpdateTimeout);
        
        // Remover el proceso del conjunto de procesos activos
        processes.delete(child);
        
        if (signal === 'SIGKILL') {
            logger.warn('Proceso terminado por timeout o heartbeat (SIGKILL)');
            // Ya se manejó en el timeout/heartbeat, no hacer nada más
            return;
        }
        
        if (code === null && signal) {
            logger.error(`yt-dlp terminado por señal: ${signal}`);
            song.channel.send('❌ Descarga interrumpida.');
            cleanupTempFile(tempPath);
            cleanupPartFiles(tempPath);
            queue.shift();
            isProcessing = false;
            playNextInQueue(voiceChannel);
            return;
        }
        
        if (code !== 0) {
            logger.error(`yt-dlp terminó con código ${code}. Mensaje de error: ${stderrData}`);
            
            // Usar la nueva función para manejar videos problemáticos
            const { errorMessage, shouldRetry } = handleProblematicVideo(song, stderrData, tempPath);
            
            // Si debería reintentar y no es un reintento ya, intentar con formato alternativo
            if (shouldRetry && (!song.isRetry || (song.retryAttempt && song.retryAttempt < 3))) {
                const attemptNumber = (song.retryAttempt || 0) + 1;
                logger.info(`🔄 Reintentando (intento ${attemptNumber}/3) con formato alternativo...`);
                
                song.isRetry = true;
                song.retryAttempt = attemptNumber;
                song.forceAlternativeFormat = true;
                
                // Limpiar archivos temporales antes del reintento
                cleanupTempFile(tempPath);
                cleanupPartFiles(tempPath);
                
                // Mostrar mensaje de reintento específico
                const retryMessages = [
                    '🔄 **Reintento 1/3**: Probando con formato worst...',
                    '🔄 **Reintento 2/3**: Probando con bestaudio específico...',
                    '🔄 **Reintento 3/3**: Probando con calidad baja...'
                ];
                song.channel.send(retryMessages[attemptNumber - 1]);
                
                // Delay progresivo antes del reintento
                const delaySeconds = (attemptNumber - 1) * 5; // 0s, 5s, 10s
                if (delaySeconds > 0) {
                    song.channel.send(`⏱️ Esperando ${delaySeconds} segundos antes del reintento...`);
                }
                
                // Reintentar con delay progresivo
                setTimeout(() => {
                    isProcessing = false;
                    playNextInQueue(voiceChannel);
                }, delaySeconds * 1000);
                return;
            }
            
            // Si no se puede reintentar o ya es un reintento, saltar la canción
            let finalErrorMessage = errorMessage;
            if (song.retryAttempt >= 3) {
                finalErrorMessage = `❌ **Video no compatible después de 3 intentos**\n` +
                                  `🚫 Este video (${song.originalTitle || 'Video'}) no se puede descargar con ningún formato.\n` +
                                  `💡 **Sugerencia**: Usa \`!formats ${song.url}\` para ver formatos disponibles\n` +
                                  `⏭️ Saltando a la siguiente canción...`;
            }
            
            song.channel.send(finalErrorMessage);
            cleanupTempFile(tempPath);
            cleanupPartFiles(tempPath);
            queue.shift();
            isProcessing = false;
            playNextInQueue(voiceChannel);
            return;
        }

        // Descarga exitosa - actualizar mensaje de progreso
        if (progressMessage) {
            try {
                progressMessage.edit(`✅ **Descarga completada**: ${song.originalTitle || song.title}`);
            } catch (error) {
                logger.warn(`Error actualizando mensaje de progreso: ${error.message}`);
            }
        }

        try {
            if (!fs.existsSync(tempPath)) {
                logger.error('Archivo temporal no existe después de la descarga');
                song.channel.send('Error: archivo de audio no encontrado.');
                queue.shift();
                isProcessing = false;
                playNextInQueue(voiceChannel);
                return;
            }

            const stats = fs.statSync(tempPath);
            if (stats.size < 10000) {
                logger.warn('Archivo de audio muy pequeño');
                song.channel.send('Audio incompleto, saltando...');
                cleanupTempFile(tempPath);
                queue.shift();
                isProcessing = false;
                playNextInQueue(voiceChannel);
                return;
            }

            const resource = createAudioResource(fs.createReadStream(tempPath), {
                inputType: StreamType.Arbitrary,
                inlineVolume: true
            });
            resource.volume.setVolume(currentVolume);
            player = createAudioPlayer();

            if (connection && connection.state.status === 'ready') {
                connection.subscribe(player);
            } else {
                throw new Error('Conexión no establecida');
            }

            player.play(resource);

            player.on(AudioPlayerStatus.Playing, () => {
                logger.info(`Reproduciendo: ${song.url}`);
                currentSong = queue[0]; // Actualiza la canción actual
                showMusicControls(song.channel);
            });

            player.on(AudioPlayerStatus.Idle, () => {
                logger.info(`Canción finalizada: ${song.url}`);
                cleanupTempFile(tempPath);
                queue.shift();
                isProcessing = false;
                playNextInQueue(voiceChannel);
            });

            player.on('error', error => {
                logger.error(`Error de reproducción: ${error.message}`);
                cleanupTempFile(tempPath);
                queue.shift();
                isProcessing = false;
                playNextInQueue(voiceChannel);
            });
        } catch (error) {
            logger.error(`Error de reproducción: ${error.message}`);
            cleanupTempFile(tempPath);
            queue.shift();
            isProcessing = false;
            playNextInQueue(voiceChannel);
        }
    });

    processes.add(child);
}

// NEW: Función actualizada para manejar un único mensaje de controles
async function showMusicControls(channel) {
    const row = new ActionRowBuilder().addComponents(
        new ButtonBuilder()
            .setCustomId('skip')
            .setLabel('⏭ Saltar')
            .setStyle(ButtonStyle.Primary),
        new ButtonBuilder()
            .setCustomId('pause_resume')
            .setLabel('⏸ Pausar/▶️ Reanudar')
            .setStyle(ButtonStyle.Secondary),
        new ButtonBuilder()
            .setCustomId('shuffle')
            .setLabel('🔀 Mezclar')
            .setStyle(ButtonStyle.Success),
        new ButtonBuilder()
            .setCustomId('stop')
            .setLabel('⏹ Detener')
            .setStyle(ButtonStyle.Danger),
        new ButtonBuilder()
            .setCustomId('nowplaying')
            .setLabel('🎶 Now Playing')
            .setStyle(ButtonStyle.Secondary),   
    );

    const row2 = new ActionRowBuilder().addComponents(
        queueButton,
        // new ButtonBuilder()
        //     .setCustomId('repeat_song')
        //     .setLabel('🔂 Repetir Canción')
        //     .setStyle(ButtonStyle.Secondary),
        // new ButtonBuilder()
        //     .setCustomId('repeat_playlist')
        //     .setLabel('🔁 Repetir Playlist')
        //     .setStyle(ButtonStyle.Secondary)
    );

    try {
 
        // Si hay un mensaje anterior, lo eliminamos
 
        if (controlMessage) {
 
            await controlMessage.delete().catch(() => {});  // Ignorar errores si el mensaje ya no existe
 
        }
 

 
        // Enviamos un nuevo mensaje con botones
 
        controlMessage = await channel.send({
 
            content: 'Controla la reproducción de música:',
 
            components: [row, row2],
 
        });
 
    } catch (error) {
 
        console.error('Error enviando controles:', error);
 
    }
}


client.on('interactionCreate', async interaction => {
    if (!interaction.isButton()){
        if (interaction.replied || interaction.deferred) {
            return; // Evitar responder dos veces
        }
    }

    const voiceChannel = interaction.member.voice.channel;
    if (!voiceChannel) return interaction.reply({ content: 'Entra a un canal de voz primero.', ephemeral: true });
    if (!player) return interaction.reply({ content: 'No hay música en reproducción.', ephemeral: true });

    try {
        switch (interaction.customId) {
            case 'skip':
                if (queue.length > 1) {
                    player.stop();
                    await interaction.reply('⏭ Saltando a la siguiente canción.');
                    await showMusicControls(interaction.channel);  // Actualiza el mensaje existente
                } else {
                    await interaction.reply('No hay más canciones.');
                }
                break;

            case 'pause_resume':
                if (player.state.status === AudioPlayerStatus.Playing) {
                    player.pause();
                    await interaction.reply('⏸ Pausada');
                } else if (player.state.status === AudioPlayerStatus.Paused) {
                    player.unpause();
                    await interaction.reply('▶️ Reanudada');
                }
                break;

            case 'shuffle':
                shuffleQueue(queue);
                await interaction.reply('🔀 Cola mezclada');
                break;

            case 'stop':
                // Reproducir despedida antes de detener
                const voiceChannel = interaction.member.voice.channel;
                if (voiceChannel && connection) {
                    await playGoodbyeMessage(voiceChannel, interaction.channel);
                }
                
                player.stop();
                queue = [];
                currentSong = null;
                processes.forEach(child => child.kill()); // NEW: Limpiar procesos
                processes.clear();
                await interaction.reply('⏹ Detenido');
                break;

            case 'nowplaying':
                if (currentSong) {
                    const title = normalizeUTF8(currentSong.title || currentSong.url);
                    await interaction.reply(`🎶 Reproduciendo ahora: **${title}**`);
                } else {
                    await interaction.reply('No hay música en reproducción.');
                }
                break;
            
            // case 'repeat_song':
            //     // Alternar el modo de repetición
            //     repeatMode = repeatMode === 'song' ? 'none' : 'song';
                    
            //     // Si se desactiva la repetición, eliminar la copia de la canción actual
            //     if (repeatMode === 'none' && currentSong) {
            //         const index = queue.findIndex(song => song.url === currentSong.url);
            //         if (index !== -1) queue.splice(index, 1); // Eliminar duplicado
            //     }
                
            //     await interaction.reply({
            //         content: `🔂 Modo repetición: ${repeatMode === 'song' ? 'Activado' : 'Desactivado'}`,
            //         ephemeral: true
            //     });
            //     break;

            // case 'repeat_playlist':
            //     repeatMode = repeatMode === 'playlist' ? 'none' : 'playlist';
            //     if (repeatMode === 'playlist') originalPlaylist = [...queue]; // Guarda copia de la playlist
            //     await interaction.reply({ content: `Modo repetición: ${repeatMode === 'playlist' ? 'Playlist activada' : 'Desactivada'}`, ephemeral: true });
            //     break;

            case 'show_queue':
                if (queue.length === 0) {
                    return interaction.reply({ content: 'La cola está vacía.', ephemeral: true });
                }
        
                const totalPages = Math.ceil(queue.length / 10);
                const embed = createQueueEmbed(queue, 0);
                const buttons = createPaginationButtons(0, totalPages);
        
                await interaction.reply({
                    embeds: [embed],
                    components: [buttons],
                    ephemeral: true,
                });
                break;
            
            
                case 'prev_page':
                    case 'next_page': {
                        const currentPage = parseInt(interaction.message.embeds[0].footer.text.split(' ')[1]) - 1;
                        let newPage = currentPage;
            
                        if (interaction.customId === 'prev_page') {
                            newPage = Math.max(0, currentPage - 1);
                        } else if (interaction.customId === 'next_page') {
                            newPage = Math.min(Math.ceil(queue.length / 10) - 1, currentPage + 1);
                        }
            
                        const embed = createQueueEmbed(queue, newPage);
                        const buttons = createPaginationButtons(newPage, Math.ceil(queue.length / 10));
            
                        await interaction.update({
                            embeds: [embed],
                            components: [buttons],
                        });
                        break;
                    }
            
                    default:
                        break;
    
        }
    } catch (error) {
        logger.error(`Error en interacción: ${error.message}`);
    }
});

client.on('messageCreate', async message => {
    if (!message.content.startsWith('!') || message.author.bot) return;

    const args = message.content.slice(1).trim().split(/ +/);
    const command = args.shift().toLowerCase();

    

    if (command === 'play') {
        const query = args.join(' ');
        if (!query) {
            return message.channel.send('Debes proporcionar una URL de YouTube o un nombre de canción.');
        }

        const voiceChannel = message.member.voice.channel;
        if (!voiceChannel) {
            return message.channel.send('Debes estar en un canal de voz para reproducir música.');
        }

        const permissions = voiceChannel.permissionsFor(message.client.user);
        if (!permissions.has(PermissionsBitField.Flags.Connect) || !permissions.has(PermissionsBitField.Flags.Speak)) {
            return message.channel.send('No tengo permisos para unirme y hablar en tu canal de voz.');
        }

        if (query.includes('list=')) {
            // Respuesta inmediata al usuario
            const playlistMessage = await message.channel.send('📝 Obteniendo playlist...');
            
            // Limpiar la URL de la playlist
            const cleanedPlaylistUrl = cleanYouTubeUrl(query);
            logger.info(`🎵 Procesando playlist: ${cleanedPlaylistUrl}`);
            
            // Usar formato simple más confiable
            exec(`yt-dlp --flat-playlist --print "%(id)s|%(title)s" --no-warnings "${cleanedPlaylistUrl}"`, { 
                maxBuffer: 10 * 1024 * 1024, 
                timeout: 60000,
                encoding: 'utf8',
                env: { ...process.env, PYTHONIOENCODING: 'utf-8' }
            }, (error, stdout, stderr) => {
                if (error) {
                    logger.error(`Error ejecutando yt-dlp para playlist: ${error.message}`);
                    return playlistMessage.edit('❌ Error al obtener la playlist.');
                }

                try {
                    const lines = stdout.trim().split('\n').filter(line => line.length > 0);
                    let songsAdded = 0;
                    let skippedPrivate = 0;
                    
                    for (const line of lines) {
                        const parts = line.split('|');
                        if (parts.length >= 2) {
                            const videoId = parts[0].trim();
                            let title = parts[1].trim();
                            
                            // Normalizar caracteres UTF-8
                            title = normalizeUTF8(title);
                            
                            // Saltar videos privados o eliminados
                            if (title.includes('[Private video]') || title.includes('[Deleted video]')) {
                                skippedPrivate++;
                                continue;
                            }
                            
                            // Validar ID del video
                            if (videoId && videoId.length >= 10 && videoId.length <= 15) {
                                const videoUrl = `https://www.youtube.com/watch?v=${videoId}`;
                                queue.push({ 
                                    url: videoUrl, 
                                    title: title || 'Título no disponible', 
                                    member: message.member, 
                                    channel: message.channel 
                                });
                                songsAdded++;
                            }
                        }
                    }

                    if (songsAdded > 0) {
                        let resultMessage = `✅ Se añadieron ${songsAdded} canciones a la cola.`;
                        if (skippedPrivate > 0) {
                            resultMessage += ` (${skippedPrivate} videos privados omitidos)`;
                        }
                        playlistMessage.edit(resultMessage);
                        
                        if (!isProcessing) {
                            playNextInQueue(voiceChannel);
                        }
                    } else {
                        playlistMessage.edit('❌ No se encontraron canciones válidas en la playlist.');
                    }
                } catch (parseError) {
                    logger.error(`Error al procesar respuesta de playlist: ${parseError.message}`);
                    playlistMessage.edit('❌ Error al procesar la playlist.');
                }
            });
        } else if (query.startsWith('http')) {
            // Respuesta inmediata al usuario
            const initialMessage = await message.channel.send('🔄 Procesando URL...');
            
            // Limpiar la URL antes de procesarla
            const cleanedUrl = cleanYouTubeUrl(query);
            logger.info(`🔗 URL recibida: ${query}`);
            logger.info(`🧹 URL limpia: ${cleanedUrl}`);
            
            if (!isValidYouTubeUrl(cleanedUrl)) {
                logger.warn(`❌ URL inválida: ${cleanedUrl}`);
                return initialMessage.edit('❌ La URL proporcionada no es válida o no es de YouTube.');
            }

            logger.info(`✅ URL válida, llamando a addSongToQueue...`);
            
            try {
                // Si el query es un enlace de YouTube individual, añadirlo usando addSongToQueue
                await addSongToQueue(cleanedUrl, message.member, message.channel, voiceChannel);
                
                // Eliminar el mensaje inicial ya que addSongToQueue envía su propio mensaje de confirmación
                initialMessage.delete().catch(() => {});
            } catch (error) {
                logger.error(`Error en addSongToQueue: ${error.message}`);
                initialMessage.edit('❌ Error al procesar la canción.');
            }
        } else {
            // Respuesta inmediata para búsqueda
            const searchMessage = await message.channel.send('🔍 Buscando en YouTube...');
            
            // Buscar en YouTube el primer resultado usando yt-dlp
            logger.info(`Buscando en YouTube: "${query}"`);
            exec(`yt-dlp "ytsearch1:${query}" --print "%(id)s" --print "%(title)s" --no-warnings`, { 
                timeout: 5000,
                encoding: 'utf8',
                env: { ...process.env, PYTHONIOENCODING: 'utf-8' }
            }, (error, stdout, stderr) => {
                if (error) {
                    logger.error(`Error ejecutando yt-dlp para búsqueda: ${error.message}`);
                    return searchMessage.edit('❌ Error al buscar en YouTube.');
                }

                logger.info(`Respuesta de yt-dlp: "${stdout.trim()}"`);
                const lines = stdout.trim().split('\n').filter(line => line.length > 0);
                
                if (lines.length < 2) {
                    logger.warn(`Pocas líneas en respuesta: ${lines.length}`);
                    return searchMessage.edit('❌ No se encontraron resultados.');
                }

                const videoId = lines[0].trim();
                let title = lines[1].trim();
                
                // Normalizar caracteres UTF-8
                title = normalizeUTF8(title);
                
                logger.info(`Video ID obtenido: "${videoId}", Título: "${title}"`);
                
                // Validar que el ID del video tenga el formato correcto
                if (!videoId || videoId.length !== 11) {
                    logger.warn(`ID de video inválido: "${videoId}"`);
                    return searchMessage.edit('❌ No se pudo obtener un resultado válido.');
                }
                
                const videoUrl = `https://www.youtube.com/watch?v=${videoId}`;
                
                queue.push({ url: videoUrl, title: title || 'Título no disponible', member: message.member, channel: message.channel });

                if (!isProcessing) {
                    searchMessage.edit(`🎵 Reproduciendo: **${title}**`);
                    playNextInQueue(voiceChannel);
                } else {
                    searchMessage.edit(`✅ Añadido a la cola: **${title}**`);
                }
            });
        }

    } else if (command === 'queue') {
        if (queue.length === 0) {
            message.channel.send('La cola está vacía.');
        } else {
            const queueList = queue.map((song, index) => `${index + 1}. ${song.title || song.url}`).join('\n');
            message.channel.send(`🎶 Cola de reproducción:\n${queueList}`);
        }
    }
    else if (command === 'playlong') {
        const query = args.join(' ');
        if (!query) {
            return message.channel.send('Debes proporcionar una URL de YouTube para videos largos.');
        }

        const voiceChannel = message.member.voice.channel;
        if (!voiceChannel) {
            return message.channel.send('Debes estar en un canal de voz para reproducir música.');
        }

        const permissions = voiceChannel.permissionsFor(message.client.user);
        if (!permissions.has(PermissionsBitField.Flags.Connect) || !permissions.has(PermissionsBitField.Flags.Speak)) {
            return message.channel.send('No tengo permisos para unirme y hablar en tu canal de voz.');
        }

        if (query.startsWith('http')) {
            // Limpiar la URL antes de procesarla
            const cleanedUrl = cleanYouTubeUrl(query);
            
            if (!isValidYouTubeUrl(cleanedUrl)) {
                return message.channel.send('❌ La URL proporcionada no es válida o no es de YouTube.');
            }

            // Verificar si ya está en la cola para evitar duplicados
            const isDuplicate = queue.some(song => song.url === cleanedUrl) || (currentSong && currentSong.url === cleanedUrl);
            if (isDuplicate) {
                return message.channel.send('❌ Esta canción ya está en la cola o reproduciéndose.');
            }

            // Agregar directamente sin confirmación para el comando playlong
            // Solo enviar mensaje si addSongToQueue no envía el suyo propio
            const playLongMessage = await message.channel.send('🎵 **Comando playlong**: Saltando confirmación para video largo...');
            
            try {
                await addSongToQueue(cleanedUrl, message.member, message.channel, voiceChannel, true); // true = skip confirmation
                // Eliminar el mensaje inicial ya que addSongToQueue envía su propio mensaje
                playLongMessage.delete().catch(() => {});
            } catch (error) {
                playLongMessage.edit('❌ Error al procesar el video largo.');
            }
        } else {
            message.channel.send('❌ Para videos largos usa una URL directa de YouTube.');
        }
    }
    else if (command === 'playhls') {
        const query = args.join(' ');
        if (!query) {
            return message.channel.send('Debes proporcionar una URL de YouTube (comando experimental para videos HLS problemáticos).');
        }

        const voiceChannel = message.member.voice.channel;
        if (!voiceChannel) {
            return message.channel.send('Debes estar en un canal de voz para reproducir música.');
        }

        const permissions = voiceChannel.permissionsFor(message.client.user);
        if (!permissions.has(PermissionsBitField.Flags.Connect) || !permissions.has(PermissionsBitField.Flags.Speak)) {
            return message.channel.send('No tengo permisos para unirme y hablar en tu canal de voz.');
        }

        if (query.startsWith('http')) {
            const cleanedUrl = cleanYouTubeUrl(query);
            
            if (!isValidYouTubeUrl(cleanedUrl)) {
                return message.channel.send('❌ La URL proporcionada no es válida o no es de YouTube.');
            }

            // Verificar duplicados
            const isDuplicate = queue.some(song => song.url === cleanedUrl) || (currentSong && currentSong.url === cleanedUrl);
            if (isDuplicate) {
                return message.channel.send('❌ Esta canción ya está en la cola o reproduciéndose.');
            }

            message.channel.send('🧪 **Comando experimental playhls**: Intentando descargar video HLS con configuración especial...');
            
            // Añadir flag especial para identificar que es comando HLS
            const videoInfo = await getVideoInfo(cleanedUrl);
            queue.push({ 
                url: cleanedUrl, 
                title: videoInfo.title, 
                originalTitle: videoInfo.originalTitle,
                duration: videoInfo.duration,
                isLong: videoInfo.isLong,
                usesHLS: true,
                forceHLS: true, // Flag especial para este comando
                member: message.member, 
                channel: message.channel 
            });

            if (!isProcessing) {
                playNextInQueue(voiceChannel);
            }
        } else {
            message.channel.send('❌ Para el comando playhls usa una URL directa de YouTube.');
        }
    }
    else if (command === 'move') {
        if (queue.length < 2) return message.channel.send('Necesitas al menos 2 canciones en la cola.');
        
        const [oldPos, newPos] = args.map(Number).filter(n => !isNaN(n));
        if (!oldPos || !newPos || oldPos < 1 || newPos < 1 || oldPos > queue.length || newPos > queue.length) {
            return message.channel.send('Posiciones inválidas. Uso: `!move <posición actual> <nueva posición>`');
        }
    
        const song = queue.splice(oldPos - 1, 1)[0];
        queue.splice(newPos - 1, 0, song);
        
        message.channel.send(`🎵 Canción movida de posición ${oldPos} a ${newPos}`);
    }
    else if (command === 'playnext') {
        const query = args.join(' ');
        if (!query) {
            return message.channel.send('Debes proporcionar una URL de YouTube o un nombre de canción.');
        }
    
        const voiceChannel = message.member.voice.channel;
        if (!voiceChannel) {
            return message.channel.send('Debes estar en un canal de voz para reproducir música.');
        }
    
        const permissions = voiceChannel.permissionsFor(message.client.user);
        if (!permissions.has(PermissionsBitField.Flags.Connect) || !permissions.has(PermissionsBitField.Flags.Speak)) {
            return message.channel.send('No tengo permisos para unirme y hablar en tu canal de voz.');
        }        if (query.includes('list=')) {
            // Limpiar la URL de la playlist
            const cleanedPlaylistUrl = cleanYouTubeUrl(query);
            
            // Lógica para playlists
            exec(`yt-dlp -j --flat-playlist --no-warnings "${cleanedPlaylistUrl}"`, { 
                maxBuffer: 10 * 1024 * 1024,
                encoding: 'utf8',
                env: { ...process.env, PYTHONIOENCODING: 'utf-8' }
            }, (error, stdout) => {
                if (error) {
                    logger.error(`Error en yt-dlp: ${error.message}`);
                    return message.channel.send('❌ Error al obtener la playlist.');
                }

                try {
                    const playlistData = stdout.trim().split('\n').map(JSON.parse);
                    const songs = [];
                    
                    for (const item of playlistData) {
                        // Validar que el ID sea válido antes de crear la URL (más flexible)
                        if (item.id && item.id.length >= 10 && item.id.length <= 15) {
                            songs.push({
                                url: `https://www.youtube.com/watch?v=${item.id}`,
                                title: item.title || 'Título no disponible',
                                member: message.member,
                                channel: message.channel
                            });
                        }
                    }

                    if (songs.length > 0) {
                        // Insertar después de la canción actual (posición 1 si hay una reproducción activa)
                        const insertPosition = isProcessing ? 1 : 0;
                        queue.splice(insertPosition, 0, ...songs);

                        message.channel.send(`⏭ Se añadieron ${songs.length} canciones para reproducir a continuación.`);

                        if (!isProcessing) {
                            playNextInQueue(voiceChannel);
                        }
                    } else {
                        message.channel.send('❌ No se encontraron canciones válidas en la playlist.');
                    }
                } catch (parseError) {
                    logger.error(`Error al procesar la playlist: ${parseError.message}`);
                    message.channel.send('❌ Error al procesar la playlist.');
                }
            });
        } else if (query.startsWith('http')) {
            // Limpiar la URL antes de procesarla
            const cleanedUrl = cleanYouTubeUrl(query);
            
            if (!isValidYouTubeUrl(cleanedUrl)) {
                return message.channel.send('❌ La URL proporcionada no es válida o no es de YouTube.');
            }

            // Lógica para enlaces directos
            const newSong = { url: cleanedUrl, member: message.member, channel: message.channel };
            
            // Insertar después de la canción actual (posición 1 si hay una reproducción activa)
            const insertPosition = isProcessing ? 1 : 0;
            queue.splice(insertPosition, 0, newSong);
    
            message.channel.send('⏭ Canción añadida para reproducir a continuación.');
    
            if (!isProcessing) {
                playNextInQueue(voiceChannel);
            }
        } else {            // Búsqueda de YouTube
            exec(`yt-dlp "ytsearch1:${query}" --print "%(id)s" --print "%(title)s" --no-warnings`, {
                encoding: 'utf8',
                env: { ...process.env, PYTHONIOENCODING: 'utf-8' }
            }, (error, stdout, stderr) => {
                if (error) {
                    logger.error(`Error en la búsqueda: ${error.message}`);
                    return message.channel.send('❌ Error al buscar la canción.');
                }

                const lines = stdout.trim().split('\n').filter(line => line.length > 0);
                if (lines.length < 2) {
                    return message.channel.send('❌ No se encontraron resultados.');
                }

                const videoId = lines[0].trim();
                let title = lines[1].trim();
                
                // Normalizar caracteres UTF-8
                title = normalizeUTF8(title);
                
                // Validar que el ID del video tenga el formato correcto
                if (!videoId || videoId.length !== 11) {
                    logger.warn(`ID de video inválido: "${videoId}"`);
                    return message.channel.send('❌ No se pudo obtener un resultado válido de la búsqueda.');
                }

                const videoUrl = `https://www.youtube.com/watch?v=${videoId}`;
                const newSong = { url: videoUrl, title: title || 'Título no disponible', member: message.member, channel: message.channel };

                // Insertar después de la canción actual (posición 1 si hay una reproducción activa)
                const insertPosition = isProcessing ? 1 : 0;
                queue.splice(insertPosition, 0, newSong);

                message.channel.send(`⏭ Canción añadida para reproducir a continuación: **${title}**`);

                if (!isProcessing) {
                    playNextInQueue(voiceChannel);
                }
            });
        }
    } else if (command === 'formats' || command === 'f') {
        const query = args.join(' ');
        if (!query || !query.startsWith('http')) {
            return message.channel.send('Debes proporcionar una URL de YouTube para ver los formatos disponibles.');
        }

        const cleanedUrl = cleanYouTubeUrl(query);
        if (!isValidYouTubeUrl(cleanedUrl)) {
            return message.channel.send('❌ La URL proporcionada no es válida o no es de YouTube.');
        }

        message.channel.send('🔍 Obteniendo formatos disponibles...');
        
        exec(`yt-dlp --list-formats --no-warnings "${cleanedUrl}"`, {
            timeout: 10000,
            encoding: 'utf8',
            env: { ...process.env, PYTHONIOENCODING: 'utf-8' }
        }, (error, stdout, stderr) => {
            if (error) {
                return message.channel.send('❌ Error al obtener formatos: ' + error.message);
            }
            
            // Procesar la salida para mostrar solo lo más relevante
            const lines = stdout.split('\n');
            const formatLines = lines.filter(line => 
                line.includes('mp4') || 
                line.includes('webm') || 
                line.includes('m4a') ||
                line.includes('audio only') ||
                line.includes('video only')
            ).slice(0, 15); // Límite de 15 líneas para no saturar el chat
            
            if (formatLines.length > 0) {
                const formatText = '```\n' + formatLines.join('\n') + '\n```';
                message.channel.send(`📋 **Formatos disponibles**:\n${formatText}`);
            } else {
                message.channel.send('❌ No se pudieron obtener los formatos o el video no está disponible.');
            }
        });
    } else if (command === 'playformat' || command === 'pf') {
        const args_copy = [...args];
        const formatId = args_copy.shift(); // Primer argumento es el ID del formato
        const query = args_copy.join(' '); // El resto es la URL
        
        if (!formatId || !query || !query.startsWith('http')) {
            return message.channel.send('Uso: `!playformat <format_id> <URL>`\nEjemplo: `!playformat 140 https://youtube.com/watch?v=...`');
        }

        const voiceChannel = message.member.voice.channel;
        if (!voiceChannel) {
            return message.channel.send('Debes estar en un canal de voz para reproducir música.');
        }

        const cleanedUrl = cleanYouTubeUrl(query);
        if (!isValidYouTubeUrl(cleanedUrl)) {
            return message.channel.send('❌ La URL proporcionada no es válida o no es de YouTube.');
        }

        // Verificar duplicados
        const isDuplicate = queue.some(song => song.url === cleanedUrl) || (currentSong && currentSong.url === cleanedUrl);
        if (isDuplicate) {
            return message.channel.send('❌ Esta canción ya está en la cola o reproduciéndose.');
        }

        // Enviar mensaje inicial que será reemplazado por playNextInQueue
        const formatMessage = await message.channel.send(`🎵 **Formato específico**: Preparando descarga con formato ${formatId}...`);
        
        const videoInfo = await getVideoInfo(cleanedUrl);
        queue.push({ 
            url: cleanedUrl, 
            title: videoInfo.title, 
            originalTitle: videoInfo.originalTitle,
            duration: videoInfo.duration,
            isLong: videoInfo.isLong,
            customFormat: formatId, // Flag especial para formato específico
            member: message.member, 
            channel: message.channel 
        });

        if (!isProcessing) {
            playNextInQueue(voiceChannel);
        }
        
        // Eliminar el mensaje inicial después de un breve delay
        setTimeout(() => {
            formatMessage.delete().catch(() => {});
        }, 2000);
    } else if (command === 'help' || command === 'h') {
        const helpEmbed = {
            color: 0x0099ff,
            title: '🎵 Bot de Música - Comandos Disponibles',
            fields: [
                {
                    name: '🎶 Reproducción Básica',
                    value: '`!play <URL/búsqueda>` - Reproducir música\n`!queue` - Ver cola de reproducción\n`!playnext <URL/búsqueda>` - Añadir a la siguiente posición',
                    inline: false
                },
                {
                    name: '🎮 Controles',
                    value: 'Usa los **botones** que aparecen cuando reproduces música:\n• ⏭ Saltar • ⏸ Pausar/▶️ Reanudar • 🔀 Mezclar\n• ⏹ Detener • 🎶 Now Playing • 🎵 Mostrar Cola',
                    inline: false
                },
                {
                    name: '🛠️ Comandos Especiales',
                    value: '`!playlong <URL>` - Videos largos (salta confirmación)\n`!playhls <URL>` - Videos HLS problemáticos\n`!move <pos1> <pos2>` - Mover canción en la cola\n`!formats <URL>` - Ver formatos disponibles\n`!playformat <id> <URL>` - Reproducir con formato específico',
                    inline: false
                },
                {
                    name: '🔧 Utilidades',
                    value: '`!test` - Verificar que el bot funciona\n`!goodbye` - Probar mensaje de despedida\n`!help` - Mostrar esta ayuda',
                    inline: false
                },
                {
                    name: '✨ Características',
                    value: '• Soporte para playlists de YouTube\n• Detección automática de videos problemáticos\n• Reintento automático con formatos alternativos\n• Manejo de caracteres especiales (tildes, ñ, etc.)\n• Timeout inteligente para videos largos\n• Mensaje de despedida automático al finalizar',
                    inline: false
                }
            ],
            footer: {
                text: 'Usa los botones de control para una experiencia más fluida'
            }
        };
        
        message.channel.send({ embeds: [helpEmbed] });
        return;
    } else if (command === 'goodbye' || command === 'bye') {
        const voiceChannel = message.member.voice.channel;
        if (!voiceChannel) {
            return message.channel.send('Debes estar en un canal de voz para probar la despedida.');
        }

        await playGoodbyeMessage(voiceChannel, message.channel);
        return;
    } else if (command === 'test' || command === 't') {
        message.channel.send('🤖 Bot respondiendo correctamente y rápido!');
        return;
    }
});

// NEW: Manejar cierre limpio del bot
process.on('SIGINT', () => {
    logger.info('Apagando bot...');
    processes.forEach(child => child.kill());
    if (connection) connection.destroy();
    client.destroy();
    process.exit();
});

// Función para mezclar la cola
function shuffleQueue(queue) {
    for (let i = queue.length - 1; i > 0; i--) {
        const j = Math.floor(Math.random() * (i + 1));
        [queue[i], queue[j]] = [queue[j], queue[i]];
    }
}

// Funciones auxiliares para la cola
function createQueueEmbed(queue, page = 0) {
    const songsPerPage = 10;
    const start = page * songsPerPage;
    const end = start + songsPerPage;
    const currentQueue = queue.slice(start, end);
    
    // Asegurar que siempre haya un valor válido para description
    const description = currentQueue.length > 0 
        ? currentQueue.map((song, index) => {
            const title = normalizeUTF8(song.title || song.url);
            return `${start + index + 1}. ${title}`;
        }).join('\n') 
        : "No hay canciones en la cola.";

    const embed = {
        title: '🎶 Cola de Reproducción',
        description: description,
        color: 0x00ff00,
        footer: {
            text: `Página ${page + 1} de ${Math.ceil(queue.length / songsPerPage)}`,
        },
    };

    return embed;
}

function createPaginationButtons(page, totalPages) {
    return new ActionRowBuilder().addComponents(
        new ButtonBuilder()
            .setCustomId('prev_page')
            .setLabel('⬅️ Anterior')
            .setStyle(ButtonStyle.Secondary)
            .setDisabled(page === 0),
        new ButtonBuilder()
            .setCustomId('next_page')
            .setLabel('Siguiente ➡️')
            .setStyle(ButtonStyle.Secondary)
            .setDisabled(page >= totalPages - 1)
    );
}

// Función mejorada para limpiar archivos temporales
function cleanupTempFile(filePath) {
    try {
        if (fs.existsSync(filePath)) {
            fs.unlinkSync(filePath);
            logger.info(`Archivo temporal eliminado: ${filePath}`);
        }
    } catch (error) {
        logger.error(`Error eliminando archivo temporal ${filePath}: ${error.message}`);
    }
}

// Función para limpiar archivos .part y temporales relacionados
function cleanupPartFiles(basePath) {
    try {
        const dir = path.dirname(basePath);
        const baseName = path.basename(basePath, path.extname(basePath));
        
        // Buscar archivos relacionados (.part, .part-Frag*, .ytdl, etc.)
        const files = fs.readdirSync(dir);
        const relatedFiles = files.filter(file => 
            file.includes(baseName) && 
            (file.endsWith('.part') || file.includes('.part-') || file.endsWith('.ytdl') || file.endsWith('.temp'))
        );
        
        relatedFiles.forEach(file => {
            const fullPath = path.join(dir, file);
            try {
                fs.unlinkSync(fullPath);
                logger.info(`Archivo relacionado eliminado: ${file}`);
            } catch (error) {
                logger.warn(`No se pudo eliminar ${file}: ${error.message}`);
            }
        });
        
        if (relatedFiles.length > 0) {
            logger.info(`Limpiados ${relatedFiles.length} archivos temporales relacionados`);
        }
    } catch (error) {
        logger.error(`Error limpiando archivos relacionados: ${error.message}`);
    }
}

// Función para limpiar y validar URLs de YouTube
function cleanYouTubeUrl(url) {
    try {
        // Decodificar la URL
        let cleanUrl = decodeURIComponent(url);
        
        // Remover caracteres problemáticos adicionales
        cleanUrl = cleanUrl.replace(/[\[\]]/g, '');
        
        // Para URLs de YouTube
        if (cleanUrl.includes('youtube.com/watch') || cleanUrl.includes('youtube.com/playlist')) {
            const urlObj = new URL(cleanUrl);
            const videoId = urlObj.searchParams.get('v');
            const listId = urlObj.searchParams.get('list');
            
            // Si es una playlist, mantener ambos parámetros
            if (listId) {
                if (videoId && /^[a-zA-Z0-9_-]{11}$/.test(videoId)) {
                    return `https://www.youtube.com/watch?v=${videoId}&list=${listId}`;
                } else {
                    return `https://www.youtube.com/playlist?list=${listId}`;
                }
            }
            
            // Si es solo un video, limpiar normalmente
            if (videoId && /^[a-zA-Z0-9_-]{11}$/.test(videoId)) {
                return `https://www.youtube.com/watch?v=${videoId}`;
            }
        }
        
        // Para URLs de youtu.be
        if (cleanUrl.includes('youtu.be/')) {
            const match = cleanUrl.match(/youtu\.be\/([a-zA-Z0-9_-]{11})/);
            if (match) {
                return `https://www.youtube.com/watch?v=${match[1]}`;
            }
        }
        
        // Validar que sea una URL válida de YouTube usando regex como fallback
        const youtubeRegex = /^https?:\/\/(www\.)?(youtube\.com\/watch\?v=|youtu\.be\/)([a-zA-Z0-9_-]+)/;
        
        if (youtubeRegex.test(cleanUrl)) {
            // Extraer el ID del video y reconstruir la URL limpia
            const match = cleanUrl.match(/[?&]v=([a-zA-Z0-9_-]{11})/);
            if (match) {
                return `https://www.youtube.com/watch?v=${match[1]}`;
            }
        }
        
        // Si no se puede limpiar, devolver la URL original
        return url;
    } catch (error) {
        logger.error(`Error limpiando URL: ${error.message}`);
        return url;
    }
}

// Función para validar si una URL es de YouTube
function isValidYouTubeUrl(url) {
    const youtubeRegex = /^https?:\/\/(www\.)?(youtube\.com\/(watch\?v=|playlist\?list=)|youtu\.be\/)([a-zA-Z0-9_-]+)/;
    return youtubeRegex.test(url);
}

// Función para normalizar caracteres UTF-8 mal codificados
// Función para normalizar caracteres UTF-8 mal codificados
function normalizeUTF8(text) {
    if (!text) return text;
    
    // Mapear caracteres especiales comunes mal codificados
    const charMap = {
        'Ã¡': 'á', 'Ã©': 'é', 'Ã­': 'í', 'Ã³': 'ó', 'Ãº': 'ú',
        'Ã¤': 'ä', 'Ã«': 'ë', 'Ã¯': 'ï', 'Ã¶': 'ö', 'Ã¼': 'ü',
        'Ã±': 'ñ', 'Ã‡': 'Ç', 'Ã§': 'ç',
        'Ã': 'À', 'Ã€': 'À', 'Ã‰': 'É', 'Ã"': 'Ó', 'Ãš': 'Ú',
        'Ã¿': 'ÿ', 'Ã½': 'ý', 'Ã¦': 'æ', 'Ã¸': 'ø', 'Ã¥': 'å',
        'Ã¢': 'â', 'Ã™': 'Ù', 'Ã¹': 'ù', 'Ã¨': 'è', 'Ã ': 'à',
        'Ã´': 'ô', 'Ã®': 'î'
    };
    
    let normalized = text;
    for (const [malformed, correct] of Object.entries(charMap)) {
        normalized = normalized.replace(new RegExp(malformed, 'g'), correct);
    }
    
    return normalized;
}

// Función para detectar videos problemáticos con formato HLS
function detectProblematicVideo(stderrData) {
    const hlsIndicators = [
        'hls',
        'HLS',
        'm3u8',
        'manifest',
        'fragment',
        'segmentation',
        'live stream',
        'stream',
        'playlist.m3u8'
    ];
    
    const errorIndicators = [
        'Unable to download webpage',
        'HTTP Error 403',
        'format not available',
        'requested format not available',
        'fragment',
        'connection broken',
        'timeout',
        'unable to extract',
        'extraction failed',
        'manifest'
    ];
    
    const isHLS = hlsIndicators.some(indicator => 
        stderrData.toLowerCase().includes(indicator.toLowerCase())
    );
    
    const hasError = errorIndicators.some(indicator => 
        stderrData.toLowerCase().includes(indicator.toLowerCase())
    );
    
    return { isHLS, hasError };
}

// Función para manejar videos problemáticos
function handleProblematicVideo(song, stderrData, tempPath) {
    const { isHLS, hasError } = detectProblematicVideo(stderrData);
    
    let errorMessage = '❌ Error al descargar el audio.';
    let shouldRetry = false;
    
    if (stderrData.includes('Requested format is not available')) {
        errorMessage = '🔄 **Formato no disponible**\n' +
                      '⚠️ Intentando con formato alternativo...';
        shouldRetry = true;
    } else if (isHLS && hasError) {
        errorMessage = '🚫 **Video HLS Problemático Detectado**\n' +
                      '❌ Este video usa formato HLS que no se puede descargar correctamente.\n' +
                      '⏭️ Saltando automáticamente a la siguiente canción...';
        shouldRetry = false;
    } else if (isHLS) {
        errorMessage = '⚠️ **Video HLS Detectado**\n' +
                      '🔄 Formato de streaming detectado. Reintentando con configuración especial...';
        shouldRetry = true;
    } else if (stderrData.includes('HTTP Error 403')) {
        errorMessage = '❌ **Error 403**: Acceso denegado al video.\n' +
                      '🔄 Intentando con configuración alternativa...';
        shouldRetry = true;
    } else if (stderrData.includes('Video unavailable')) {
        errorMessage = '❌ **Video no disponible**\n' +
                      '⏭️ Puede estar privado, eliminado o restringido. Saltando...';
        shouldRetry = false;
    } else if (stderrData.includes('Sign in to confirm your age')) {
        errorMessage = '❌ **Verificación de edad requerida**\n' +
                      '⏭️ Este video requiere verificación de edad. Saltando...';
        shouldRetry = false;
    } else if (stderrData.includes('Private video')) {
        errorMessage = '❌ **Video privado**\n' +
                      '⏭️ No se puede acceder a este video. Saltando...';
        shouldRetry = false;
    } else if (stderrData.includes('This video is not available')) {
        errorMessage = '❌ **Video no disponible en tu región**\n' +
                      '⏭️ Restricción geográfica detectada. Saltando...';
        shouldRetry = false;
    } else if (stderrData.includes('Unable to download webpage')) {
        errorMessage = '🔄 **Error de conexión**\n' +
                      '⚠️ Reintentando con configuración alternativa...';
        shouldRetry = true;
    } else if (stderrData.includes('extraction failed')) {
        errorMessage = '🔄 **Error de extracción**\n' +
                      '⚠️ Reintentando con formato alternativo...';
        shouldRetry = true;
    } else if (stderrData.includes('network unreachable') || stderrData.includes('Connection refused')) {
        errorMessage = '❌ **Error de red**\n' +
                      '⏭️ Problemas de conexión. Saltando...';
        shouldRetry = false;
    } else if (stderrData.includes('too many requests') || stderrData.includes('429')) {
        errorMessage = '❌ **Demasiadas solicitudes**\n' +
                      '⏭️ Límite de rate alcanzado. Saltando...';
        shouldRetry = false;
    }
    
    return { errorMessage, shouldRetry };
}

// Función para reproducir mensaje de despedida antes de desconectar
async function playGoodbyeMessage(voiceChannel, textChannel) {
    try {
        logger.info('🔊 Reproduciendo mensaje de despedida...');
        
        // Crear una conexión temporal para la despedida
        const goodbyeConnection = joinVoiceChannel({
            channelId: voiceChannel.id,
            guildId: voiceChannel.guild.id,
            adapterCreator: voiceChannel.guild.voiceAdapterCreator,
        });

        // Esperar a que la conexión esté lista
        await new Promise((resolve, reject) => {
            const timeout = setTimeout(() => {
                reject(new Error('Timeout en conexión de despedida'));
            }, 5000);

            goodbyeConnection.on('stateChange', (oldState, newState) => {
                if (newState.status === 'ready') {
                    clearTimeout(timeout);
                    resolve();
                }
            });
        });

        // Crear el audio resource con un mensaje de despedida
        // En lugar de usar TTS real, podemos usar un archivo de audio simple
        // o hacer que el bot "hable" con mensajes de texto
        
        // Opción 1: Mensaje de texto de despedida
        if (textChannel) {
            const goodbyeEmbed = {
                color: 0xFF6B6B,
                title: '👋 ¡Hasta luego!',
                description: '🎵 **Gracias por usar el bot de música**\n' +
                           '✨ ¡Espero haber alegrado tu día con buena música!\n' +
                           '🔄 Puedes volver a llamarme cuando quieras con `!play`\n' +
                           '💖 ¡Que tengas un excelente día!',
                footer: { text: 'Bot desconectándose...' },
                timestamp: new Date()
            };
            
            await textChannel.send({ embeds: [goodbyeEmbed] });
        }

        // Opción 2: Si queremos usar un archivo de audio de despedida
        // Podríamos agregar aquí la lógica para reproducir un archivo MP3 de despedida
        // Por ahora usaremos un delay simulado
        await new Promise(resolve => setTimeout(resolve, 2000));

        // Desconectar suavemente
        goodbyeConnection.destroy();
        logger.info('✅ Mensaje de despedida completado');
        
    } catch (error) {
        logger.error(`Error en mensaje de despedida: ${error.message}`);
        // Si hay error en la despedida, continuar con la desconexión normal
    }
}
