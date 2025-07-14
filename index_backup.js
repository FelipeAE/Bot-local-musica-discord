const { Client, GatewayIntentBits, PermissionsBitField, ActionRowBuilder, ButtonBuilder, ButtonStyle } = require('discord.js');
const { joinVoiceChannel, createAudioPlayer, createAudioResource, AudioPlayerStatus, StreamType } = require('@discordjs/voice');
const { exec, spawn } = require('child_process');
const fs = require('fs');
const path = require('path');
const { v4: uuidv4 } = require('uuid');
const { createLogger, format, transports } = require('winston');
const moment = require('moment-timezone');
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
            
            // Considerar video largo si es mayor a 1 hora (solo para información)
            const isLong = duration && parseDurationToSeconds(duration) > 3600;
            
            resolve({ 
                title: title, 
                originalTitle: title,
                duration: duration,
                isLong: isLong 
            });
        });
    });
}

// Función para parsear duración a segundos
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
        
        // Rechazar videos muy largos (más de 1 hora)
        if (videoInfo.isLong) {
            return channel.send('❌ Este video es demasiado largo (más de 1 hora). Solo se permiten videos de hasta 1 hora.');
        }
        
        // Añadir a la cola
        queue.push({ 
            url, 
            title: videoInfo.title, 
            duration: videoInfo.duration,
            member, 
            channel 
        });
        
        logger.info(`✅ Canción añadida: ${videoInfo.title}`);
        
        // Mensaje de confirmación
        const addedEmbed = {
            color: 0x00AA00,
            title: '🎵 Canción Añadida',
            description: `**${videoInfo.title}**${videoInfo.duration ? `\nDuración: ${videoInfo.duration}` : ''}`,
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

    // Timeout de 3 minutos para videos normales
    const timeoutId = setTimeout(() => {
        logger.error('Timeout en descarga - proceso terminado');
        child.kill('SIGKILL');
        cleanupTempFile(tempPath);
        song.channel.send('⏰ **Timeout en descarga** - La descarga tardó demasiado.');
        queue.shift();
        isProcessing = false;
        playNextInQueue(voiceChannel);
    }, 180000); // 3 minutos

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
                logger.info(`Reproduciendo: ${song.title}`);
                showMusicControls(song.channel);
            });

            player.on(AudioPlayerStatus.Idle, () => {
                logger.info(`Canción finalizada: ${song.title}`);
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
            .setStyle(ButtonStyle.Primary)
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

            case 'show_queue':
                if (queue.length === 0) {
                    return interaction.reply({ content: 'La cola está vacía.', ephemeral: true });
                }

                const queueList = queue.slice(0, 10).map((song, index) => 
                    `${index + 1}. ${normalizeUTF8(song.title)}`
                ).join('\n');
                
                const queueEmbed = {
                    title: '🎶 Cola de Reproducción',
                    description: queueList + (queue.length > 10 ? `\n... y ${queue.length - 10} más` : ''),
                    color: 0x00ff00,
                    footer: { text: `Total: ${queue.length} canciones` }
                };

                await interaction.reply({ embeds: [queueEmbed], ephemeral: true });
                break;
        }
    } catch (error) {
        logger.error(`Error en interacción: ${error.message}`);
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
                                queue.push({ 
                                    url: videoUrl, 
                                    title: title, 
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
            const queueList = queue.slice(0, 10).map((song, index) => 
                `${index + 1}. ${normalizeUTF8(song.title)}`
            ).join('\n');
            message.channel.send(`🎶 Cola de reproducción:\n${queueList}${queue.length > 10 ? `\n... y ${queue.length - 10} más` : ''}`);
        }
    }
});

// Evento cuando el bot se conecta
client.on('ready', () => {
    clearTimeout(connectionTimeout);
    logger.info(`✅ Bot conectado como ${client.user.tag}`);
    logger.info('🎵 Bot de música optimizado listo para usar!');
    client.user.setActivity('🎵 Música | Usa !play para comandos', { type: 'LISTENING' });
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
