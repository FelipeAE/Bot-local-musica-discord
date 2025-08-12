const { Client, GatewayIntentBits, PermissionsBitField, ActionRowBuilder, ButtonBuilder, ButtonStyle } = require('discord.js');
const { joinVoiceChannel, createAudioPlayer, createAudioResource, AudioPlayerStatus, StreamType } = require('@discordjs/voice');
const { exec, spawn } = require('child_process');
const fs = require('fs');
const path = require('path');
const { v4: uuidv4 } = require('uuid');
const { createLogger, format, transports } = require('winston');
const moment = require('moment-timezone');
const { GoogleGenerativeAI } = require('@google/generative-ai');
const config = require('./config.json');

// Verificaciones de token
if (!config.token) {
    console.error('❌ ERROR: Token no configurado en config.json');
    process.exit(1);
}

if (!config.token.startsWith('MT') && !config.token.startsWith('mT')) {
    console.error('❌ ERROR: El token parece no ser válido. Debe comenzar con "MT"');
    process.exit(1);
}

console.log('✅ Token configurado correctamente');

// Configuración de Gemini AI
let genAI = null;
let model = null;
if (config.geminiApiKey && config.geminiApiKey !== 'TU_GEMINI_API_KEY_AQUI') {
    try {
        genAI = new GoogleGenerativeAI(config.geminiApiKey);
        model = genAI.getGenerativeModel({ model: "gemini-1.5-flash" });
        console.log('✅ Google Gemini AI configurado correctamente');
    } catch (error) {
        console.log('⚠️ Error configurando Gemini AI:', error.message);
        console.log('💡 Las sugerencias de IA estarán deshabilitadas');
    }
} else {
    console.log('⚠️ API key de Gemini no configurada');
    console.log('💡 Para habilitar sugerencias de IA, configura geminiApiKey en config.json');
}

// Timeout de conexión
const connectionTimeout = setTimeout(() => {
    logger.error('❌ TIMEOUT: El bot no se conectó en 30 segundos');
    process.exit(1);
}, 30000);

// Logger simplificado
const TIMEZONE = config.timezone || 'America/Santiago';
const logger = createLogger({
    level: 'info',
    format: format.combine(
        format.timestamp(),
        format.printf(({ timestamp, level, message }) => {
            const localTime = moment(timestamp).tz(TIMEZONE).format('DD-MM-YY HH:mm');
            return `${localTime} [${level.toUpperCase()}]: ${message}`;
        })
    ),
    transports: [
        new transports.File({ filename: 'music-bot.log' }),
        new transports.Console()
    ]
});

// Variables principales
let queue = [];
let player;
let connection;
let isProcessing = false;
let currentSong = null;
let controlMessage = null;
const processes = new Set();

// Cliente Discord
const client = new Client({
    intents: [
        GatewayIntentBits.Guilds,
        GatewayIntentBits.GuildVoiceStates,
        GatewayIntentBits.GuildMessages,
        GatewayIntentBits.MessageContent
    ]
});

// Obtener información básica del video (solo título y duración)
async function getVideoInfo(url) {
    return new Promise((resolve, reject) => {
        const cleanedUrl = cleanYouTubeUrl(url);
        
        exec(`yt-dlp --get-title --get-duration --no-warnings "${cleanedUrl}"`, { 
            timeout: 10000, 
            encoding: 'utf8',
            env: { ...process.env, PYTHONIOENCODING: 'utf-8' }
        }, (error, stdout, stderr) => {
            if (error) {
                logger.error(`Error obteniendo info del video: ${error.message}`);
                resolve({ title: 'Título no disponible', duration: null, isLong: false });
                return;
            }

            const lines = stdout.trim().split('\n');
            const title = normalizeUTF8(lines[0] || 'Título no disponible');
            const duration = lines[1] || null;
            
            // Considerar video largo si es mayor a 4 horas (aumentado para pruebas)
            const isLong = duration && parseDurationToSeconds(duration) > 14400; // 4 horas = 4 * 3600 segundos
            
            // Determinar si debería usar streaming (videos > 15 minutos)
            const shouldStream = duration && parseDurationToSeconds(duration) > 900; // 15 minutos = 15 * 60 segundos
            
            resolve({ 
                title: title, 
                originalTitle: title,
                duration: duration,
                isLong: isLong,
                shouldStream: shouldStream
            });
        });
    });
}

// Función para obtener sugerencias de IA
async function getAISuggestions(songTitle) {
    if (!model) {
        return null;
    }

    try {
        logger.info(`🤖 Obteniendo sugerencias de IA para: ${songTitle}`);
        
        const prompt = `Basándote en la canción "${songTitle}", sugiere 4 canciones similares en estilo, género o artista. 
        
        INSTRUCCIONES IMPORTANTES:
        - Responde SOLO con los títulos de las canciones en formato "Artista - Título"
        - Una canción por línea
        - No incluyas números ni guiones al inicio
        - No agregues explicaciones adicionales
        - Asegúrate de que las canciones sean populares y estén disponibles en YouTube
        
        Ejemplo de formato correcto:
        Queen - Somebody to Love
        David Bowie - Heroes
        The Beatles - Come Together
        Led Zeppelin - Stairway to Heaven`;

        const result = await model.generateContent(prompt);
        const response = await result.response;
        const suggestions = response.text().trim();
        
        // Procesar las sugerencias
        const songLines = suggestions.split('\n')
            .map(line => line.trim())
            .filter(line => line.length > 0 && line.includes(' - '))
            .slice(0, 4); // Máximo 4 sugerencias

        logger.info(`✅ IA generó ${songLines.length} sugerencias para: ${songTitle}`);
        return songLines;

    } catch (error) {
        logger.error(`❌ Error obteniendo sugerencias de IA: ${error.message}`);
        return null;
    }
}

// Función para mostrar sugerencias de IA
async function showAISuggestions(channel, songTitle) {
    if (!model) {
        return channel.send('⚠️ Las sugerencias de IA no están habilitadas. Configura la API key de Gemini en config.json');
    }

    const suggestionMsg = await channel.send('🤖 **Generando sugerencias similares...**');
    
    const suggestions = await getAISuggestions(songTitle);
    
    if (!suggestions || suggestions.length === 0) {
        return suggestionMsg.edit('❌ No se pudieron generar sugerencias en este momento.');
    }

    // Crear botones para cada sugerencia
    const buttons = suggestions.map((song, index) => 
        new ButtonBuilder()
            .setCustomId(`suggest_${index}`)
            .setLabel(`${index + 1}. ${song.length > 80 ? song.substring(0, 77) + '...' : song}`)
            .setStyle(ButtonStyle.Secondary)
    );

    // Dividir en rows (máximo 5 botones por row)
    const rows = [];
    for (let i = 0; i < buttons.length; i += 5) {
        const row = new ActionRowBuilder().addComponents(buttons.slice(i, i + 5));
        rows.push(row);
    }

    // Agregar botón para cancelar
    const cancelRow = new ActionRowBuilder().addComponents(
        new ButtonBuilder()
            .setCustomId('suggest_cancel')
            .setLabel('❌ Cancelar')
            .setStyle(ButtonStyle.Danger)
    );
    rows.push(cancelRow);

    const suggestEmbed = {
        color: 0xFF6B35,
        title: '🤖 Sugerencias de IA',
        description: `**Basado en:** ${songTitle}\n\n**Canciones similares sugeridas:**\n${suggestions.map((song, i) => `${i + 1}. ${song}`).join('\n')}`,
        footer: { text: 'Haz clic en una sugerencia para añadirla a la cola' }
    };

    // Guardar sugerencias temporalmente para uso posterior
    if (!suggestionMsg.suggestions) {
        suggestionMsg.suggestions = suggestions;
    }

    await suggestionMsg.edit({
        content: '',
        embeds: [suggestEmbed],
        components: rows
    });

    // Auto-eliminar después de 60 segundos
    setTimeout(async () => {
        try {
            await suggestionMsg.edit({ 
                embeds: [{ ...suggestEmbed, description: suggestEmbed.description + '\n\n⏰ *Sugerencias expiradas*' }], 
                components: [] 
            });
        } catch (error) {
            // Ignorar errores si el mensaje ya fue eliminado
        }
    }, 60000);

    return suggestionMsg;
}
function parseDurationToSeconds(duration) {
    if (!duration || duration === 'N/A') return 0;
    
    const parts = duration.split(':').map(Number);
    if (parts.length === 3) {
        return parts[0] * 3600 + parts[1] * 60 + parts[2]; // HH:MM:SS
    } else if (parts.length === 2) {
        return parts[0] * 60 + parts[1]; // MM:SS
    }
    return 0;
}

// Función para obtener URL de streaming directo
async function getStreamUrl(url) {
    return new Promise((resolve, reject) => {
        const cleanedUrl = cleanYouTubeUrl(url);
        
        exec(`yt-dlp -f "bestaudio/best" --get-url --no-warnings "${cleanedUrl}"`, { 
            timeout: 15000, 
            encoding: 'utf8',
            env: { ...process.env, PYTHONIOENCODING: 'utf-8' }
        }, (error, stdout, stderr) => {
            if (error) {
                logger.error(`Error obteniendo URL de stream: ${error.message}`);
                reject(error);
                return;
            }

            const streamUrl = stdout.trim().split('\n')[0];
            if (streamUrl && streamUrl.startsWith('http')) {
                logger.info(`✅ URL de streaming obtenida: ${streamUrl.substring(0, 50)}...`);
                resolve(streamUrl);
            } else {
                reject(new Error('URL de streaming no válida'));
            }
        });
    });
}

// Añadir canción a la cola (simplificado)
async function addSongToQueue(url, member, channel, voiceChannel) {
    try {
        logger.info(`🔍 Añadiendo canción: ${url}`);
        
        // Verificar duplicados
        const isDuplicate = queue.some(song => song.url === url) || (currentSong && currentSong.url === url);
        if (isDuplicate) {
            return channel.send('❌ Esta canción ya está en la cola o reproduciéndose.');
        }
        
        const videoInfo = await getVideoInfo(url);
        
        // Rechazar videos muy largos (más de 4 horas)
        if (videoInfo.isLong) {
            return channel.send('❌ Este video es demasiado largo (más de 4 horas). Solo se permiten videos de hasta 4 horas.');
        }
        
        // Añadir a la cola
        queue.push({ 
            url, 
            title: videoInfo.title, 
            duration: videoInfo.duration,
            shouldStream: videoInfo.shouldStream, // Nuevo flag para streaming
            member, 
            channel 
        });
        
        logger.info(`✅ Canción añadida: ${videoInfo.title} ${videoInfo.shouldStream ? '(Streaming)' : '(Descarga)'}`);
        
        // Mensaje de confirmación con indicador de método
        const methodIndicator = videoInfo.shouldStream ? '🌐 Streaming' : '📥 Descarga';
        const addedEmbed = {
            color: videoInfo.shouldStream ? 0x00AAFF : 0x00AA00,
            title: '🎵 Canción Añadida',
            description: `**${videoInfo.title}**${videoInfo.duration ? `\nDuración: ${videoInfo.duration}` : ''}\nMétodo: ${methodIndicator}`,
            footer: { text: `Posición en cola: ${queue.length}` }
        };
        
        channel.send({ embeds: [addedEmbed] });

        // Iniciar reproducción si no hay nada procesando
        if (!isProcessing) {
            playNextInQueue(voiceChannel);
        } else {
            logger.info(`Canción añadida a la cola. Cola actual: ${queue.length} elementos`);
        }
    } catch (error) {
        logger.error('❌ Error al obtener información del video:', error);
        channel.send('❌ Error al procesar el video.');
    }
}

// Reproducir siguiente canción (simplificado)
async function playNextInQueue(voiceChannel) {
    if (isProcessing) {
        logger.warn('Ya hay una descarga en proceso');
        return;
    }

    // Establecer conexión si es necesario
    if (!connection || connection.state.status === 'disconnected' || connection.state.status === 'destroyed') {
        try {
            logger.info('Conectando al canal de voz...');
            connection = joinVoiceChannel({
                channelId: voiceChannel.id,
                guildId: voiceChannel.guild.id,
                adapterCreator: voiceChannel.guild.voiceAdapterCreator,
            });
            
            // Esperar a que la conexión esté lista
            await new Promise((resolve, reject) => {
                const timeout = setTimeout(() => {
                    reject(new Error('Timeout en conexión de voz'));
                }, 10000);

                connection.on('stateChange', (oldState, newState) => {
                    if (newState.status === 'ready') {
                        clearTimeout(timeout);
                        logger.info('✅ Conectado al canal de voz');
                        resolve();
                    }
                });
            });
        } catch (error) {
            logger.error(`Error de conexión: ${error.message}`);
            return;
        }
    }

    if (queue.length === 0) {
        // Cola vacía - desconectar
        if (connection) {
            connection.destroy();
            connection = null;
        }
        currentSong = null;
        isProcessing = false;
        if (controlMessage) {
            await controlMessage.edit({ components: [] });
            controlMessage = null;
        }
        return;
    }

    isProcessing = true;
    const song = queue[0];
    currentSong = song;

    // Si la canción no tiene información de duración (ej: de playlist), obtenerla primero
    if (!song.duration) {
        try {
            logger.info(`🔍 Obteniendo información de duración para: ${song.title}`);
            const videoInfo = await getVideoInfo(song.url);
            song.duration = videoInfo.duration;
            song.shouldStream = videoInfo.shouldStream;
            song.isLong = videoInfo.isLong;
            
            // Rechazar si es demasiado largo
            if (song.isLong) {
                song.channel.send(`❌ Video demasiado largo (${song.title}) - Saltando...`);
                queue.shift();
                isProcessing = false;
                playNextInQueue(voiceChannel);
                return;
            }
            
            logger.info(`✅ Duración obtenida: ${song.duration} - ${song.shouldStream ? 'Usará streaming' : 'Usará descarga'}`);
        } catch (error) {
            logger.error(`Error obteniendo duración: ${error.message}`);
            // Continuar sin información de duración (usar descarga por defecto)
            song.shouldStream = false;
        }
    }

    // Decidir entre streaming y descarga
    if (song.shouldStream) {
        logger.info(`🌐 Iniciando streaming para: ${song.title}`);
        await playStreamDirectly(song, voiceChannel);
    } else {
        logger.info(`📥 Iniciando descarga para: ${song.title}`);
        await playWithDownload(song, voiceChannel);
    }
}

// Función para reproducir mediante streaming directo
async function playStreamDirectly(song, voiceChannel) {
    try {
        song.channel.send(`🌐 **Obteniendo stream**: ${song.title}`);
        
        const streamUrl = await getStreamUrl(song.url);
        
        song.channel.send(`🎵 **Iniciando streaming**: ${song.title}`);
        
        const resource = createAudioResource(streamUrl, {
            inputType: StreamType.Arbitrary
        });
        
        player = createAudioPlayer();
        connection.subscribe(player);
        player.play(resource);

        player.on(AudioPlayerStatus.Playing, () => {
            logger.info(`🌐 Streaming: ${song.title}`);
            showMusicControls(song.channel);
        });

        player.on(AudioPlayerStatus.Idle, () => {
            logger.info(`🌐 Stream finalizado: ${song.title}`);
            queue.shift();
            isProcessing = false;
            playNextInQueue(voiceChannel);
        });

        player.on('error', error => {
            logger.error(`❌ Error de streaming: ${error.message}`);
            song.channel.send(`❌ Error en streaming. Intentando descarga como fallback...`);
            // Fallback a descarga
            song.shouldStream = false;
            playWithDownload(song, voiceChannel);
        });

    } catch (error) {
        logger.error(`❌ Error obteniendo stream: ${error.message}`);
        song.channel.send(`❌ Error en streaming. Intentando descarga como fallback...`);
        // Fallback a descarga
        song.shouldStream = false;
        await playWithDownload(song, voiceChannel);
    }
}

// Función para reproducir mediante descarga (método original)
async function playWithDownload(song, voiceChannel) {
    // Archivo temporal único
    const tempPath = path.join(__dirname, `temp_audio_${uuidv4()}.mp3`);
    
    song.channel.send(`📥 **Descargando**: ${song.title}`);

    // Comando yt-dlp simplificado para videos normales
    const ytdlpArgs = [
        '-f', 'bestaudio/best',
        '--no-warnings',
        '--no-playlist',
        '--retries', '3',
        '--socket-timeout', '30',
        '-o', tempPath,
        song.url
    ];

    logger.info(`Ejecutando: yt-dlp ${ytdlpArgs.join(' ')}`);
    const child = spawn('yt-dlp', ytdlpArgs, {
        env: { ...process.env, PYTHONIOENCODING: 'utf-8' },
        stdio: ['pipe', 'pipe', 'pipe']
    });

    // Timeout más largo para descargas (5 minutos)
    const timeoutId = setTimeout(() => {
        logger.error('Timeout en descarga - proceso terminado');
        child.kill('SIGKILL');
        cleanupTempFile(tempPath);
        song.channel.send('⏰ **Timeout en descarga** - La descarga tardó demasiado.');
        queue.shift();
        isProcessing = false;
        playNextInQueue(voiceChannel);
    }, 300000); // 5 minutos

    // Manejo de errores del proceso
    child.on('error', error => {
        clearTimeout(timeoutId);
        logger.error(`Error en yt-dlp: ${error.message}`);
        song.channel.send('❌ Error al descargar el audio.');
        cleanupTempFile(tempPath);
        queue.shift();
        isProcessing = false;
        playNextInQueue(voiceChannel);
    });

    // Manejo de finalización del proceso
    child.on('close', (code) => {
        clearTimeout(timeoutId);
        processes.delete(child);
        
        if (code !== 0) {
            logger.error(`yt-dlp terminó con código ${code}`);
            song.channel.send('❌ Error al descargar el audio. Saltando canción...');
            cleanupTempFile(tempPath);
            queue.shift();
            isProcessing = false;
            playNextInQueue(voiceChannel);
            return;
        }

        // Reproducir archivo descargado
        try {
            if (!fs.existsSync(tempPath)) {
                throw new Error('Archivo no encontrado');
            }

            const stats = fs.statSync(tempPath);
            if (stats.size < 10000) {
                throw new Error('Archivo muy pequeño');
            }

            const resource = createAudioResource(fs.createReadStream(tempPath), {
                inputType: StreamType.Arbitrary
            });
            
            player = createAudioPlayer();
            connection.subscribe(player);
            player.play(resource);

            player.on(AudioPlayerStatus.Playing, () => {
                logger.info(`📥 Reproduciendo: ${song.title}`);
                showMusicControls(song.channel);
            });

            player.on(AudioPlayerStatus.Idle, () => {
                logger.info(`📥 Canción finalizada: ${song.title}`);
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
            song.channel.send('❌ Error al reproducir el audio.');
            cleanupTempFile(tempPath);
            queue.shift();
            isProcessing = false;
            playNextInQueue(voiceChannel);
        }
    });

    processes.add(child);
}

// Mostrar controles de música (simplificado)
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
            .setStyle(ButtonStyle.Secondary)
    );

    const row2 = new ActionRowBuilder().addComponents(
        new ButtonBuilder()
            .setCustomId('show_queue')
            .setLabel('📋 Cola')
            .setStyle(ButtonStyle.Primary),
        new ButtonBuilder()
            .setCustomId('ai_suggest')
            .setLabel('🤖 Sugerir Similar')
            .setStyle(ButtonStyle.Secondary)
            .setDisabled(!model) // Deshabilitar si no hay IA configurada
    );

    try {
        if (controlMessage) {
            await controlMessage.delete().catch(() => {});
        }

        controlMessage = await channel.send({
            content: 'Controla la reproducción de música:',
            components: [row, row2],
        });
    } catch (error) {
        console.error('Error enviando controles:', error);
    }
}

// Manejo de interacciones de botones
client.on('interactionCreate', async interaction => {
    if (!interaction.isButton()) return;

    const voiceChannel = interaction.member.voice.channel;
    if (!voiceChannel) return interaction.reply({ content: 'Entra a un canal de voz primero.', ephemeral: true });

    try {
        switch (interaction.customId) {
            case 'skip':
                if (queue.length > 1) {
                    if (player) player.stop();
                    await interaction.reply('⏭ Saltando a la siguiente canción.');
                } else {
                    await interaction.reply('No hay más canciones en la cola.');
                }
                break;

            case 'pause_resume':
                if (!player) return interaction.reply({ content: 'No hay música en reproducción.', ephemeral: true });
                
                if (player.state.status === AudioPlayerStatus.Playing) {
                    player.pause();
                    await interaction.reply('⏸ Música pausada');
                } else if (player.state.status === AudioPlayerStatus.Paused) {
                    player.unpause();
                    await interaction.reply('▶️ Música reanudada');
                } else {
                    await interaction.reply('No hay música para pausar/reanudar.');
                }
                break;

            case 'shuffle':
                if (queue.length < 2) {
                    return interaction.reply({ content: 'Necesitas al menos 2 canciones para mezclar.', ephemeral: true });
                }
                shuffleQueue(queue);
                await interaction.reply('🔀 Cola mezclada');
                break;

            case 'stop':
                if (player) player.stop();
                queue = [];
                currentSong = null;
                isProcessing = false; // Resetear el estado de procesamiento
                processes.forEach(child => child.kill());
                processes.clear();
                
                if (connection) {
                    connection.destroy();
                    connection = null;
                }
                
                if (controlMessage) {
                    await controlMessage.edit({ components: [] });
                    controlMessage = null;
                }
                
                await interaction.reply('⏹ Música detenida y cola limpiada');
                break;

            case 'nowplaying':
                if (currentSong) {
                    const title = normalizeUTF8(currentSong.title);
                    await interaction.reply(`🎶 Reproduciendo ahora: **${title}**`);
                } else {
                    await interaction.reply('No hay música en reproducción.');
                }
                break;

            case 'ai_suggest':
                if (!currentSong) {
                    return interaction.reply({ content: 'No hay música reproduciéndose para generar sugerencias.', ephemeral: true });
                }
                await interaction.deferReply({ ephemeral: true });
                await showAISuggestions(interaction.channel, currentSong.title);
                await interaction.editReply('🤖 ¡Sugerencias generadas! Revisa el canal para ver las opciones.');
                break;

            case 'show_queue':
                if (queue.length === 0) {
                    return interaction.reply({ content: 'La cola está vacía.', ephemeral: true });
                }

                const queueList = queue.slice(0, 10).map((song, index) => {
                    const duration = song.duration ? ` \`[${song.duration}]\`` : ' `[--:--]`';
                    const method = song.shouldStream ? '🌐' : '📥';
                    return `${index + 1}. ${normalizeUTF8(song.title)}${duration} ${method}`;
                }).join('\n');
                
                const queueEmbed = {
                    title: '🎶 Cola de Reproducción',
                    description: queueList + (queue.length > 10 ? `\n... y ${queue.length - 10} más` : ''),
                    color: 0x00ff00,
                    footer: { text: `Total: ${queue.length} canciones | 🌐 = Streaming, 📥 = Descarga` }
                };

                await interaction.reply({ embeds: [queueEmbed], ephemeral: true });
                break;

            // Manejo de sugerencias de IA
            case 'suggest_cancel':
                await interaction.update({ 
                    embeds: [{ 
                        color: 0x888888, 
                        title: '🤖 Sugerencias Canceladas', 
                        description: 'Sugerencias de IA canceladas por el usuario.' 
                    }], 
                    components: [] 
                });
                break;

            default:
                // Manejo de botones de sugerencias individuales
                if (interaction.customId.startsWith('suggest_')) {
                    const index = parseInt(interaction.customId.split('_')[1]);
                    const message = interaction.message;
                    
                    // Buscar las sugerencias en el embed
                    if (message.embeds && message.embeds[0] && message.embeds[0].description) {
                        const description = message.embeds[0].description;
                        const lines = description.split('\n');
                        let suggestion = null;
                        
                        for (const line of lines) {
                            if (line.startsWith(`${index + 1}.`)) {
                                suggestion = line.substring(3).trim(); // Remover "1. "
                                break;
                            }
                        }
                        
                        if (suggestion) {
                            await interaction.deferReply({ ephemeral: true });
                            
                            // Buscar en YouTube la sugerencia
                            const searchMessage = `🔍 Buscando sugerencia: **${suggestion}**`;
                            await interaction.editReply(searchMessage);
                            
                            exec(`yt-dlp "ytsearch1:${suggestion}" --print "%(id)s" --print "%(title)s" --no-warnings`, { 
                                timeout: 10000,
                                encoding: 'utf8',
                                env: { ...process.env, PYTHONIOENCODING: 'utf-8' }
                            }, async (error, stdout, stderr) => {
                                if (error) {
                                    return interaction.editReply('❌ Error buscando la sugerencia.');
                                }

                                const lines = stdout.trim().split('\n');
                                if (lines.length >= 2) {
                                    const videoId = lines[0];
                                    const title = normalizeUTF8(lines[1]);
                                    const videoUrl = `https://www.youtube.com/watch?v=${videoId}`;
                                    
                                    try {
                                        await addSongToQueue(videoUrl, interaction.member, interaction.channel, voiceChannel);
                                        await interaction.editReply(`✅ **${suggestion}** añadida a la cola`);
                                        
                                        // Actualizar el mensaje de sugerencias para marcar como añadida
                                        const updatedEmbed = { ...message.embeds[0] };
                                        updatedEmbed.description = updatedEmbed.description.replace(
                                            `${index + 1}. ${suggestion}`,
                                            `${index + 1}. ~~${suggestion}~~ ✅`
                                        );
                                        await message.edit({ embeds: [updatedEmbed], components: message.components });
                                        
                                    } catch (addError) {
                                        await interaction.editReply('❌ Error añadiendo la canción a la cola.');
                                    }
                                } else {
                                    await interaction.editReply('❌ No se encontró la canción sugerida.');
                                }
                            });
                        } else {
                            await interaction.reply({ content: 'Error: No se pudo encontrar la sugerencia seleccionada.', ephemeral: true });
                        }
                    }
                }
                break;
        }
    } catch (error) {
        logger.error(`Error en interacción: ${error.message}`);
        if (!interaction.replied && !interaction.deferred) {
            await interaction.reply({ content: 'Ocurrió un error procesando tu solicitud.', ephemeral: true });
        }
    }
});

// Comandos de mensaje (simplificado)
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
            // Procesar playlist
            const playlistMessage = await message.channel.send('📝 Obteniendo playlist...');
            const cleanedPlaylistUrl = cleanYouTubeUrl(query);
            
            exec(`yt-dlp --flat-playlist --print "%(id)s|%(title)s" --no-warnings "${cleanedPlaylistUrl}"`, { 
                maxBuffer: 10 * 1024 * 1024, 
                timeout: 60000,
                encoding: 'utf8',
                env: { ...process.env, PYTHONIOENCODING: 'utf-8' }
            }, (error, stdout, stderr) => {
                if (error) {
                    return playlistMessage.edit('❌ Error al obtener la playlist.');
                }

                try {
                    const lines = stdout.trim().split('\n').filter(line => line.length > 0);
                    let songsAdded = 0;
                    
                    for (const line of lines) {
                        const parts = line.split('|');
                        if (parts.length >= 2) {
                            const videoId = parts[0];
                            const title = normalizeUTF8(parts[1]);
                            
                            if (videoId && !videoId.includes('[Private video]') && !videoId.includes('[Deleted video]')) {
                                const videoUrl = `https://www.youtube.com/watch?v=${videoId}`;
                                
                                // Para playlists, añadir sin información de duración (se detectará después)
                                // Esto permite que el sistema híbrido funcione cuando se procese cada canción
                                queue.push({ 
                                    url: videoUrl, 
                                    title: title,
                                    shouldStream: false, // Se determinará cuando se procese
                                    member: message.member, 
                                    channel: message.channel 
                                });
                                songsAdded++;
                            }
                        }
                    }

                    if (songsAdded > 0) {
                        playlistMessage.edit(`✅ Se añadieron ${songsAdded} canciones a la cola.`);
                        if (!isProcessing) {
                            playNextInQueue(voiceChannel);
                        }
                    } else {
                        playlistMessage.edit('❌ No se encontraron canciones válidas en la playlist.');
                    }
                } catch (parseError) {
                    playlistMessage.edit('❌ Error al procesar la playlist.');
                }
            });
        } else if (query.startsWith('http')) {
            // URL directa
            const cleanedUrl = cleanYouTubeUrl(query);
            
            if (!isValidYouTubeUrl(cleanedUrl)) {
                return message.channel.send('❌ La URL proporcionada no es válida o no es de YouTube.');
            }

            await addSongToQueue(cleanedUrl, message.member, message.channel, voiceChannel);
        } else {
            // Búsqueda en YouTube
            const searchMessage = await message.channel.send('🔍 Buscando en YouTube...');
            const escapedQuery = query.replace(/['"]/g, '');
            
            exec(`yt-dlp "ytsearch1:${escapedQuery}" --print "%(id)s" --print "%(title)s" --no-warnings`, { 
                timeout: 10000,
                encoding: 'utf8',
                env: { ...process.env, PYTHONIOENCODING: 'utf-8' }
            }, async (error, stdout, stderr) => {
                if (error) {
                    return searchMessage.edit('❌ Error en la búsqueda.');
                }

                const lines = stdout.trim().split('\n');
                if (lines.length >= 2) {
                    const videoId = lines[0];
                    const title = normalizeUTF8(lines[1]);
                    const videoUrl = `https://www.youtube.com/watch?v=${videoId}`;
                    
                    searchMessage.delete().catch(() => {});
                    await addSongToQueue(videoUrl, message.member, message.channel, voiceChannel);
                } else {
                    searchMessage.edit('❌ No se encontraron resultados.');
                }
            });
        }
    } else if (command === 'queue') {
        if (queue.length === 0) {
            message.channel.send('La cola está vacía.');
        } else {
            const queueList = queue.slice(0, 10).map((song, index) => {
                const duration = song.duration ? ` \`[${song.duration}]\`` : ' `[--:--]`';
                const method = song.shouldStream ? '🌐' : '📥';
                return `${index + 1}. ${normalizeUTF8(song.title)}${duration} ${method}`;
            }).join('\n');
            
            const queueEmbed = {
                title: '🎶 Cola de Reproducción',
                description: queueList + (queue.length > 10 ? `\n... y ${queue.length - 10} más` : ''),
                color: 0x00ff00,
                footer: { text: `Total: ${queue.length} canciones | 🌐 = Streaming, 📥 = Descarga` }
            };
            
            message.channel.send({ embeds: [queueEmbed] });
        }
    } else if (command === 'suggest') {
        const songQuery = args.join(' ');
        
        if (!songQuery && !currentSong) {
            return message.channel.send('❌ Proporciona el nombre de una canción o reproduce algo para obtener sugerencias.\nEjemplo: `!suggest Bohemian Rhapsody`');
        }
        
        const songTitle = songQuery || currentSong.title;
        await showAISuggestions(message.channel, songTitle);
    }
});

// Evento cuando el bot se conecta
client.on('ready', () => {
    clearTimeout(connectionTimeout);
    logger.info(`✅ Bot conectado como ${client.user.tag}`);
    logger.info('🎵 Bot de música optimizado listo para usar!');
    
    const aiStatus = model ? ' con IA 🤖' : '';
    client.user.setActivity(`🎵 Música${aiStatus} | !play para empezar`, { type: 'LISTENING' });
});

// Manejo de cierre limpio
process.on('SIGINT', () => {
    logger.info('Apagando bot...');
    processes.forEach(child => child.kill());
    if (connection) connection.destroy();
    client.destroy();
    process.exit();
});

// Funciones auxiliares

// Función para reproducir mediante streaming directo
async function playStreamDirectly(song, voiceChannel) {
    try {
        song.channel.send(`🌐 **Obteniendo stream**: ${song.title}`);
        
        const streamUrl = await getStreamUrl(song.url);
        
        song.channel.send(`🎵 **Iniciando streaming**: ${song.title}`);
        
        const resource = createAudioResource(streamUrl, {
            inputType: StreamType.Arbitrary
        });
        
        player = createAudioPlayer();
        connection.subscribe(player);
        player.play(resource);

        player.on(AudioPlayerStatus.Playing, () => {
            logger.info(`🌐 Streaming: ${song.title}`);
            showMusicControls(song.channel);
        });

        player.on(AudioPlayerStatus.Idle, () => {
            logger.info(`🌐 Stream finalizado: ${song.title}`);
            queue.shift();
            isProcessing = false;
            playNextInQueue(voiceChannel);
        });

        player.on('error', error => {
            logger.error(`❌ Error de streaming: ${error.message}`);
            song.channel.send(`❌ Error en streaming. Intentando descarga como fallback...`);
            // Fallback a descarga
            song.shouldStream = false;
            playWithDownload(song, voiceChannel);
        });

    } catch (error) {
        logger.error(`❌ Error obteniendo stream: ${error.message}`);
        song.channel.send(`❌ Error en streaming. Intentando descarga como fallback...`);
        // Fallback a descarga
        song.shouldStream = false;
        await playWithDownload(song, voiceChannel);
    }
}

// Función para reproducir mediante descarga (método original)
async function playWithDownload(song, voiceChannel) {
    // Archivo temporal único
    const tempPath = path.join(__dirname, `temp_audio_${uuidv4()}.mp3`);
    
    song.channel.send(`📥 **Descargando**: ${song.title}`);

    // Comando yt-dlp simplificado para videos normales
    const ytdlpArgs = [
        '-f', 'bestaudio/best',
        '--no-warnings',
        '--no-playlist',
        '--retries', '3',
        '--socket-timeout', '30',
        '-o', tempPath,
        song.url
    ];

    logger.info(`Ejecutando: yt-dlp ${ytdlpArgs.join(' ')}`);
    const child = spawn('yt-dlp', ytdlpArgs, {
        env: { ...process.env, PYTHONIOENCODING: 'utf-8' },
        stdio: ['pipe', 'pipe', 'pipe']
    });

    // Timeout más largo para descargas (5 minutos)
    const timeoutId = setTimeout(() => {
        logger.error('Timeout en descarga - proceso terminado');
        child.kill('SIGKILL');
        cleanupTempFile(tempPath);
        song.channel.send('⏰ **Timeout en descarga** - La descarga tardó demasiado.');
        queue.shift();
        isProcessing = false;
        playNextInQueue(voiceChannel);
    }, 300000); // 5 minutos

    // Manejo de errores del proceso
    child.on('error', error => {
        clearTimeout(timeoutId);
        logger.error(`Error en yt-dlp: ${error.message}`);
        song.channel.send('❌ Error al descargar el audio.');
        cleanupTempFile(tempPath);
        queue.shift();
        isProcessing = false;
        playNextInQueue(voiceChannel);
    });

    // Manejo de finalización del proceso
    child.on('close', (code) => {
        clearTimeout(timeoutId);
        processes.delete(child);
        
        if (code !== 0) {
            logger.error(`yt-dlp terminó con código ${code}`);
            song.channel.send('❌ Error al descargar el audio. Saltando canción...');
            cleanupTempFile(tempPath);
            queue.shift();
            isProcessing = false;
            playNextInQueue(voiceChannel);
            return;
        }

        // Reproducir archivo descargado
        try {
            if (!fs.existsSync(tempPath)) {
                throw new Error('Archivo no encontrado');
            }

            const stats = fs.statSync(tempPath);
            if (stats.size < 10000) {
                throw new Error('Archivo muy pequeño');
            }

            const resource = createAudioResource(fs.createReadStream(tempPath), {
                inputType: StreamType.Arbitrary
            });
            
            player = createAudioPlayer();
            connection.subscribe(player);
            player.play(resource);

            player.on(AudioPlayerStatus.Playing, () => {
                logger.info(`📥 Reproduciendo: ${song.title}`);
                showMusicControls(song.channel);
            });

            player.on(AudioPlayerStatus.Idle, () => {
                logger.info(`📥 Canción finalizada: ${song.title}`);
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
            song.channel.send('❌ Error al reproducir el audio.');
            cleanupTempFile(tempPath);
            queue.shift();
            isProcessing = false;
            playNextInQueue(voiceChannel);
        }
    });

    processes.add(child);
}

function shuffleQueue(queue) {
    for (let i = queue.length - 1; i > 0; i--) {
        const j = Math.floor(Math.random() * (i + 1));
        [queue[i], queue[j]] = [queue[j], queue[i]];
    }
}

function cleanupTempFile(filePath) {
    try {
        if (fs.existsSync(filePath)) {
            fs.unlinkSync(filePath);
            logger.info(`Archivo temporal eliminado: ${filePath}`);
        }
    } catch (error) {
        logger.error(`Error eliminando archivo temporal: ${error.message}`);
    }
}

function cleanYouTubeUrl(url) {
    try {
        let cleanUrl = decodeURIComponent(url);
        cleanUrl = cleanUrl.replace(/[\[\]]/g, '');
        
        if (cleanUrl.includes('youtube.com/watch') || cleanUrl.includes('youtube.com/playlist')) {
            const urlObj = new URL(cleanUrl);
            const videoId = urlObj.searchParams.get('v');
            const listId = urlObj.searchParams.get('list');
            
            if (listId) {
                if (videoId && /^[a-zA-Z0-9_-]{11}$/.test(videoId)) {
                    return `https://www.youtube.com/watch?v=${videoId}&list=${listId}`;
                } else {
                    return `https://www.youtube.com/playlist?list=${listId}`;
                }
            }
            
            if (videoId && /^[a-zA-Z0-9_-]{11}$/.test(videoId)) {
                return `https://www.youtube.com/watch?v=${videoId}`;
            }
        }
        
        if (cleanUrl.includes('youtu.be/')) {
            const match = cleanUrl.match(/youtu\.be\/([a-zA-Z0-9_-]{11})/);
            if (match) {
                return `https://www.youtube.com/watch?v=${match[1]}`;
            }
        }
        
        return url;
    } catch (error) {
        logger.error(`Error limpiando URL: ${error.message}`);
        return url;
    }
}

function isValidYouTubeUrl(url) {
    const youtubeRegex = /^https?:\/\/(www\.)?(youtube\.com\/(watch\?v=|playlist\?list=)|youtu\.be\/)([a-zA-Z0-9_-]+)/;
    return youtubeRegex.test(url);
}

function normalizeUTF8(text) {
    if (!text) return text;
    
    const charMap = {
        'Ã¡': 'á', 'Ã©': 'é', 'Ã­': 'í', 'Ã³': 'ó', 'Ãº': 'ú',
        'Ã¤': 'ä', 'Ã«': 'ë', 'Ã¯': 'ï', 'Ã¶': 'ö', 'Ã¼': 'ü',
        'Ã±': 'ñ', 'Ã‡': 'Ç', 'Ã§': 'ç'
    };
    
    let normalized = text;
    for (const [malformed, correct] of Object.entries(charMap)) {
        normalized = normalized.replace(new RegExp(malformed, 'g'), correct);
    }
    
    return normalized;
}

// Manejo de errores del cliente
client.on('error', error => {
    logger.error(`❌ Error del cliente Discord: ${error.message}`);
});

client.on('warn', warning => {
    logger.warn(`⚠️ Advertencia del cliente Discord: ${warning}`);
});

// Iniciar el bot
client.login(config.token).catch(error => {
    logger.error(`❌ Error al iniciar el bot: ${error.message}`);
    process.exit(1);
});
