const { Client, GatewayIntentBits, PermissionsBitField, ActionRowBuilder, ButtonBuilder, ButtonStyle, StringSelectMenuBuilder } = require('discord.js');
const { joinVoiceChannel, createAudioPlayer, createAudioResource, AudioPlayerStatus, StreamType } = require('@discordjs/voice');
const { exec } = require('child_process');
const fs = require('fs');
const path = require('path');
const { v4: uuidv4 } = require('uuid'); // NEW: Para nombres de archivo únicos
const { createLogger, format, transports } = require('winston');
const moment = require('moment-timezone');
const { title } = require('process');
const { url } = require('inspector');
const { get } = require('http');

// Configura tu zona horaria (cambia 'America/Santiago' por tu zona)
const TIMEZONE = 'America/Santiago';  // Ej: Europe/Madrid, America/Mexico_City

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

async function getVideoTitle(url) {
    return new Promise((resolve, reject) => {
        exec(`yt-dlp --get-title "${url}"`, (error, stdout, stderr) => {
            if (error) {
                console.error(`Error obteniendo título: ${error.message}`);
                reject('Título no disponible');
            } else {
                resolve(stdout.trim());
            }
        });
    });
}

async function addSongToQueue(url, member, channel, voiceChannel, options = {}) {
    try {
        const title = await getVideoTitle(url);
        queue.push({ url, title, member, channel });

        // Solo enviar mensaje si no se desactiva en las opciones
        if (options.sendMessage !== false) {
            channel.send(`🎵 Canción añadida: **${title}**`);
        }

        if (!isProcessing) {
            playNextInQueue(voiceChannel);
        }
    } catch (error) {
        console.error('Error al obtener el título:', error);
        if (options.sendMessage !== false) {
            channel.send('No se pudo obtener el título de la canción.');
        }
    }
}

async function playNextInQueue(voiceChannel) {
    // NEW: Resetear controles al empezar nueva canción
    buttonsSent = false;
    
    if (!connection || connection.state.status === 'disconnected') {
        try {
            connection = joinVoiceChannel({
                channelId: voiceChannel.id,
                guildId: voiceChannel.guild.id,
                adapterCreator: voiceChannel.guild.voiceAdapterCreator,
            });

            connection.on('stateChange', (oldState, newState) => {
                // NEW: Manejo mejorado de reconexión
                if (newState.status === 'disconnected') {
                    logger.warn('Conexión perdida. Intentando reconectar...');
                    setTimeout(() => {
                        playNextInQueue(voiceChannel);
                    }, 5000);
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
        if (connection) {
            connection.destroy();
            connection = null;
        }
        currentSong = null;
        isProcessing = false;
        buttonsSent = false;
        // NEW: Limpiar mensaje de controles
        if (controlMessage) {
            await controlMessage.edit({ components: [] });  // Elimina los botones
            controlMessage = null;
        }
        return;
    }

    if (isProcessing) return;
    isProcessing = true;

    const song = queue[0];
    currentSong = song;

    // NEW: Nombre de archivo único con UUID
    const tempPath = path.join(__dirname, `temp_audio_${uuidv4()}.mp3`);
    const timeout = 60000; // 60 segundos

    // NEW: Manejo de procesos con timeout
    const child = exec(`yt-dlp -x --audio-format mp3 --cookies cookies.txt -o "${tempPath}" "${song.url}"`, { timeout }, (error) => {
        processes.delete(child);
        if (error) {
            logger.error(`Error yt-dlp: ${error.message}`);
            song.channel.send('Error al descargar el audio.');
            queue.shift();
            isProcessing = false;
            playNextInQueue(voiceChannel);
            return;
        }

        try {
            const stats = fs.statSync(tempPath);
            if (stats.size < 10000) {
                logger.warn('Archivo de audio muy pequeño');
                song.channel.send('Audio incompleto, saltando...');
                fs.unlinkSync(tempPath);
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
                showMusicControls(song.channel);
            });

            player.on(AudioPlayerStatus.Idle, () => {
                logger.info(`Canción finalizada: ${song.url}`);
                fs.unlinkSync(tempPath);
                queue.shift();
                isProcessing = false;
                playNextInQueue(voiceChannel);
            });

            player.on('error', error => {
                logger.error(`Error de reproducción: ${error.message}`);
                fs.unlinkSync(tempPath);
                queue.shift();
                isProcessing = false;
                playNextInQueue(voiceChannel);
            });

        } catch (error) {
            logger.error(`Error de reproducción: ${error.message}`);
            fs.unlinkSync(tempPath);
            queue.shift();
            isProcessing = false;
            playNextInQueue(voiceChannel);
        }
    });

    // NEW: Manejar timeout de procesos
    child.on('timeout', () => {
        logger.error('Timeout en descarga');
        child.kill();
        fs.unlinkSync(tempPath);
        song.channel.send('Tiempo excedido al descargar la canción.');
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
        queueButton
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
    if (!interaction.isButton()) return;

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
                player.stop();
                queue = [];
                currentSong = null;
                processes.forEach(child => child.kill()); // NEW: Limpiar procesos
                processes.clear();
                await interaction.reply('⏹ Detenido');
                break;

            case 'nowplaying':
                if (currentSong) {
                    await interaction.reply(`🎶 Reproduciendo ahora: ${currentSong.url}`);
                    await showMusicControls(interaction.channel);  // Actualiza el mensaje existente
                } else {
                    await interaction.reply('No hay música en reproducción.');
                }

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

                        
                
                        function createQueueEmbed(queue, page = 0) {
                            const songsPerPage = 10;
                            const start = page * songsPerPage;
                            const end = start + songsPerPage;
                            const currentQueue = queue.slice(start, end);
                            
                        
                            // Asegurar que siempre haya un valor válido para description
                            const description = currentQueue.length > 0 
                                ? currentQueue.map((song, index) => `${start + index + 1}. ${song.title || song.url}`).join('\n') 
                                : "No hay canciones en la cola."; // Mensaje predeterminado
                        
                            const embed = {
                                title: '🎶 Cola de Reproducción',
                                description: description, // <-- ¡Campo siempre definido!
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
                                    .setDisabled(page === 0),  // Deshabilitar si estamos en la primera página
                                new ButtonBuilder()
                                    .setCustomId('next_page')
                                    .setLabel('Siguiente ➡️')
                                    .setStyle(ButtonStyle.Secondary)
                                    .setDisabled(page >= totalPages - 1)  // Deshabilitar si estamos en la última página
                            );
                        }
    
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
        if (!query) return message.channel.send('Debes proporcionar una URL de YouTube o un nombre de canción.');
    
        const voiceChannel = message.member.voice.channel;
        if (!voiceChannel) return message.channel.send('Debes estar en un canal de voz para reproducir música.');
    
        const permissions = voiceChannel.permissionsFor(message.client.user);
        if (!permissions.has(PermissionsBitField.Flags.Connect) || !permissions.has(PermissionsBitField.Flags.Speak)) {
            return message.channel.send('No tengo permisos para unirme y hablar en tu canal de voz.');
        }
    
        if (query.includes('list=')) {
            exec(`yt-dlp -j --flat-playlist "${query}"`, { maxBuffer: 10 * 1024 * 1024 }, (error, stdout) => {
                if (error) {
                    console.error(`Error ejecutando yt-dlp: ${error.message}`);
                    return message.channel.send('Error al intentar obtener la playlist.');
                }
    
                try {
                    const playlistData = stdout.trim().split('\n').map(JSON.parse);
                    let addedCount = 0;
    
                    // Añadir canciones sin enviar mensajes individuales
                    playlistData.forEach((item) => {
                        const videoUrl = `https://www.youtube.com/watch?v=${item.id}`;
                        addSongToQueue(videoUrl, message.member, message.channel, voiceChannel, { sendMessage: false });
                        addedCount++;
                    });
    
                    message.channel.send(`✅ Se añadieron ${addedCount} canciones a la cola.`);
    
                    if (!isProcessing) {
                        playNextInQueue(voiceChannel);
                    }
                } catch (parseError) {
                    console.error(`Error al analizar la playlist: ${parseError.message}`);
                    message.channel.send('Error al procesar la playlist.');
                }
            });
        } else if (query.startsWith('http')) {
            // Añadir canción individual con mensaje
            addSongToQueue(query, message.member, message.channel, voiceChannel, { sendMessage: true });
        } else {
            // Búsqueda manual con mensaje
            exec(`yt-dlp "ytsearch:${query}" --get-id`, (error, stdout) => {
                if (error) {
                    console.error(`Error en búsqueda: ${error.message}`);
                    return message.channel.send('Error al buscar la canción.');
                }
    
                const videoId = stdout.trim();
                if (!videoId) return message.channel.send('No se encontraron resultados.');
    
                const videoUrl = `https://www.youtube.com/watch?v=${videoId}`;
                addSongToQueue(videoUrl, message.member, message.channel, voiceChannel, { sendMessage: true });
            });
        }
    } else if (command === 'queue') {
        if (queue.length === 0) {
            message.channel.send('La cola está vacía.');
        } else {
            const queueList = queue.map((song, index) => `${index + 1}. ${song.url}`).join('\n');
            message.channel.send(`🎶 Cola de reproducción:\n${queueList}`);
        }
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


client.login('token del bot aqui');
