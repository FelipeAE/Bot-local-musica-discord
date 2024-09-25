const { Client, GatewayIntentBits, PermissionsBitField, ActionRowBuilder, ButtonBuilder, ButtonStyle } = require('discord.js');
const { joinVoiceChannel, createAudioPlayer, createAudioResource, AudioPlayerStatus, StreamType } = require('@discordjs/voice');
const { exec } = require('child_process');
const fs = require('fs');
const path = require('path');

let queue = [];  // Cola de canciones
let player;  // Reproductor de audio
let currentVolume = 0.5;  // Volumen por defecto (50%)
let connection;  // Conexión de voz
let isProcessing = false;  // Variable para controlar si ya se está procesando una canción
let currentSong = null;  // Variable para almacenar la canción que se está reproduciendo

const client = new Client({
    intents: [
        GatewayIntentBits.Guilds,
        GatewayIntentBits.GuildVoiceStates,
        GatewayIntentBits.GuildMessages,
        GatewayIntentBits.MessageContent
    ]
});

async function playNextInQueue(voiceChannel) {
    if (!connection || connection.state.status === 'disconnected') {
        try {
            connection = joinVoiceChannel({
                channelId: voiceChannel.id,
                guildId: voiceChannel.guild.id,
                adapterCreator: voiceChannel.guild.voiceAdapterCreator,
            });

            connection.on('stateChange', (oldState, newState) => {
                if (newState.status === 'disconnected') {
                    console.log('La conexión de voz se ha desconectado.');
                    connection.destroy();
                    connection = null;
                }
            });

        } catch (error) {
            console.error('Error al intentar unirse al canal de voz:', error.message);
            voiceChannel.send('No puedo unirme al canal de voz. Verifica mis permisos.');
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
        return;
    }

    if (isProcessing) {
        return;
    }

    isProcessing = true;

    const song = queue[0];
    currentSong = song;  // Guardar la canción actual como "now playing"

    // Generar un nombre de archivo temporal único para cada canción
    const tempPath = path.join(__dirname, `temp_audio_${Date.now()}.mp3`);

    exec(`yt-dlp -x --audio-format mp3 -o "${tempPath}" "${song.url}"`, (error, stdout, stderr) => {
        if (error) {
            console.error(`Error ejecutando yt-dlp: ${error.message}`);
            song.channel.send('Error al intentar descargar el audio.');
            queue.shift();
            isProcessing = false;
            playNextInQueue(voiceChannel);
            return;
        }

        const stats = fs.statSync(tempPath);
        if (stats.size < 10000) {  // Verificar que el archivo tenga un tamaño mínimo (10KB)
            console.log('El archivo de audio parece incompleto o muy pequeño, saltando canción.');
            song.channel.send('El archivo de audio parece incompleto, saltando a la siguiente canción.');
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
            console.error('La conexión de voz no se ha establecido correctamente.');
            song.channel.send('Error al conectarse al canal de voz.');
            isProcessing = false;
            return;
        }

        player.play(resource);

        player.on(AudioPlayerStatus.Playing, () => {
            console.log(`Reproduciendo: ${song.url}`);
            showMusicControls(song.channel);  // Mostrar los botones de control cuando empiece la música
        });

        player.on(AudioPlayerStatus.Idle, () => {
            console.log(`Canción terminada: ${song.url}`);
            fs.unlinkSync(tempPath);
            queue.shift();
            isProcessing = false;
            playNextInQueue(voiceChannel);
        });

        player.on('error', error => {
            console.error(`Error en la reproducción: ${error.message}`);
            fs.unlinkSync(tempPath);
            queue.shift();
            isProcessing = false;
            playNextInQueue(voiceChannel);
        });
    });
}

// Mostrar los botones de control en el chat
function showMusicControls(channel) {
    const row = new ActionRowBuilder()
        .addComponents(
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

    channel.send({
        content: 'Controla la reproducción de música:',
        components: [row]
    });
}

// Manejar la interacción con los botones
client.on('interactionCreate', async interaction => {
    if (!interaction.isButton()) return;

    const voiceChannel = interaction.member.voice.channel;

    if (!voiceChannel) {
        return interaction.reply({ content: 'Debes estar en un canal de voz para controlar la música.', ephemeral: true });
    }

    if (!player) {
        return interaction.reply({ content: 'No hay música en reproducción.', ephemeral: true });
    }

    if (interaction.customId === 'skip') {
        if (queue.length > 1) {
            player.stop();
            interaction.reply('⏭ Saltando a la siguiente canción.');
        } else {
            interaction.reply('No hay más canciones en la cola.');
        }
    } else if (interaction.customId === 'pause_resume') {
        if (player.state.status === AudioPlayerStatus.Playing) {
            player.pause();
            interaction.reply('⏸ Música pausada.');
        } else if (player.state.status === AudioPlayerStatus.Paused) {
            player.unpause();
            interaction.reply('▶️ Música reanudada.');
        } else {
            interaction.reply('No hay música en reproducción.');
        }
    } else if (interaction.customId === 'shuffle') {
        shuffleQueue(queue);
        interaction.reply('🔀 La cola ha sido mezclada.');
    } else if (interaction.customId === 'stop') {
        if (player) {
            player.stop();
            queue = [];
            currentSong = null;  // Limpiar la canción actual
            interaction.reply('⏹ Música detenida y cola eliminada.');
        }
    } else if (interaction.customId === 'nowplaying') {
        if (currentSong) {
            interaction.reply(`🎶 Reproduciendo ahora: ${currentSong.url}`);
        } else {
            interaction.reply('No se está reproduciendo ninguna canción en este momento.');
        }
    }
});

client.on('messageCreate', async message => {
    if (!message.content.startsWith('!') || message.author.bot) return;

    const args = message.content.slice(1).trim().split(/ +/);
    const command = args.shift().toLowerCase();

    if (command === 'play') {
        const query = args.join(' ');
        if (!query) {
            return message.channel.send('Debes proporcionar una URL de YouTube.');
        }

        const voiceChannel = message.member.voice.channel;
        if (!voiceChannel) {
            return message.channel.send('Debes estar en un canal de voz para reproducir música.');
        }

        const permissions = voiceChannel.permissionsFor(message.client.user);
        if (!permissions.has(PermissionsBitField.Flags.Connect) || !permissions.has(PermissionsBitField.Flags.Speak)) {
            return message.channel.send('No tengo permisos para unirme y hablar en tu canal de voz.');
        }

        if (query.includes('playlist')) {
            exec(`yt-dlp -j --flat-playlist "${query}"`, (error, stdout, stderr) => {
                if (error) {
                    console.error(`Error ejecutando yt-dlp: ${error.message}`);
                    return message.channel.send('Error al intentar obtener la playlist.');
                }

                const playlistData = stdout.trim().split('\n').map(JSON.parse);
                for (const item of playlistData) {
                    const videoUrl = `https://www.youtube.com/watch?v=${item.id}`;
                    queue.push({ url: videoUrl, member: message.member, channel: message.channel });
                }

                message.channel.send(`Se añadieron ${playlistData.length} canciones a la cola.`);

                if (!isProcessing) {
                    playNextInQueue(voiceChannel);
                }
            });

        } else {
            queue.push({ url: query, member: message.member, channel: message.channel });

            if (!isProcessing) {
                playNextInQueue(voiceChannel);
            } else {
                message.channel.send('La canción ha sido añadida a la cola.');
            }
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

// Función para mezclar la cola
function shuffleQueue(queue) {
    for (let i = queue.length - 1; i > 0; i--) {
        const j = Math.floor(Math.random() * (i + 1));
        [queue[i], queue[j]] = [queue[j], queue[i]];
    }
}



client.login('token del bot aqui');
