const { Client, GatewayIntentBits, PermissionsBitField } = require('discord.js');
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
            isProcessing = false;  // Permitir procesar la siguiente canción
            return;
        }
    }

    if (queue.length === 0) {
        if (connection) {
            connection.destroy();
            connection = null;
        }
        currentSong = null;  // No hay canción en reproducción
        isProcessing = false;  // Reiniciar estado de procesamiento
        return;
    }

    if (isProcessing) {
        return;  // No continuar si ya hay una canción en proceso
    }

    isProcessing = true;  // Marcar que estamos procesando una canción

    const song = queue[0];

    // Guardar la canción actual como "now playing"
    currentSong = song;

    // Generar un nombre de archivo temporal único para cada canción
    const tempPath = path.join(__dirname, `temp_audio_${Date.now()}.mp3`);

    exec(`yt-dlp -x --audio-format mp3 -o "${tempPath}" "${song.url}"`, (error, stdout, stderr) => {
        if (error) {
            console.error(`Error ejecutando yt-dlp: ${error.message}`);
            song.channel.send('Error al intentar descargar el audio.');
            queue.shift();  // Remover canción fallida de la cola
            isProcessing = false;  // Permitir procesar la siguiente canción
            playNextInQueue(voiceChannel);  // Intentar la siguiente canción
            return;
        }

        const stats = fs.statSync(tempPath);
        if (stats.size < 10000) {  // Verificar que el archivo tenga un tamaño mínimo (10KB)
            console.log('El archivo de audio parece incompleto o muy pequeño, saltando canción.');
            song.channel.send('El archivo de audio parece incompleto, saltando a la siguiente canción.');
            fs.unlinkSync(tempPath);  // Eliminar archivo incompleto
            queue.shift();  // Saltar a la siguiente canción
            isProcessing = false;  // Permitir procesar la siguiente canción
            playNextInQueue(voiceChannel);
            return;
        }

        const resource = createAudioResource(fs.createReadStream(tempPath), {
            inputType: StreamType.Arbitrary,
            inlineVolume: true
        });

        resource.volume.setVolume(currentVolume);  // Ajustar el volumen actual

        player = createAudioPlayer();
        
        if (connection && connection.state.status === 'ready') {
            connection.subscribe(player);
        } else {
            console.error('La conexión de voz no se ha establecido correctamente.');
            song.channel.send('Error al conectarse al canal de voz.');
            isProcessing = false;  // Permitir procesar la siguiente canción
            return;
        }

        player.play(resource);

        player.on(AudioPlayerStatus.Playing, () => {
            console.log(`Reproduciendo: ${song.url}`);
        });

        player.on(AudioPlayerStatus.Idle, () => {
            console.log(`Canción terminada: ${song.url}`);
            fs.unlinkSync(tempPath);  // Eliminar archivo temporal
            queue.shift();  // Remover la canción reproducida
            isProcessing = false;  // Permitir procesar la siguiente canción
            playNextInQueue(voiceChannel);  // Intentar reproducir la siguiente canción
        });

        player.on('error', error => {
            console.error(`Error en la reproducción: ${error.message}`);
            fs.unlinkSync(tempPath);  // Asegurar que el archivo temporal se elimine en caso de error
            queue.shift();  // Remover la canción con error
            isProcessing = false;  // Permitir procesar la siguiente canción
            playNextInQueue(voiceChannel);
        });
    });
}

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

        // Verificar si es una playlist
        if (query.includes('playlist')) {
            // Ejecutar yt-dlp para extraer todas las canciones de la playlist
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

                // Iniciar la reproducción si no hay otra canción en reproducción
                if (!isProcessing) {
                    playNextInQueue(voiceChannel);  // Empezar a procesar si no hay nada en curso
                }
            });

        } else {
            // Añadir una canción individual a la cola
            queue.push({ url: query, member: message.member, channel: message.channel });

            if (!isProcessing) {
                playNextInQueue(voiceChannel);  // Empezar a procesar si no hay nada en curso
            } else {
                message.channel.send('La canción ha sido añadida a la cola.');
            }
        }

    } else if (command === 'skip') {
        if (queue.length > 1) {
            player.stop();  // Detener la canción actual
            message.channel.send('⏭ Saltando a la siguiente canción.');
        } else {
            message.channel.send('No hay más canciones en la cola.');
        }
    }

    if (command === 'pause') {
        if (player) {
            player.pause();
            message.channel.send('⏸ Música pausada.');
        }

    } else if (command === 'resume') {
        if (player) {
            player.unpause();
            message.channel.send('▶️ Música reanudada.');
        }

    } else if (command === 'stop') {
        if (player) {
            player.stop();
            queue = [];
            currentSong = null;  // Limpiar la canción actual
            message.channel.send('⏹ Música detenida y cola eliminada.');
        }

    } else if (command === 'nowplaying') {
        if (currentSong) {
            message.channel.send(`🎶 Reproduciendo ahora: ${currentSong.url}`);
        } else {
            message.channel.send('No se está reproduciendo ninguna canción en este momento.');
        }

    } else if (command === 'queue') {
        if (queue.length === 0) {
            message.channel.send('La cola está vacía.');
        } else {
            const queueList = queue.map((song, index) => `${index + 1}. ${song.url}`).join('\n');
            message.channel.send(`🎶 Cola de reproducción:\n${queueList}`);
        }

    } else if (command === 'volume') {
        const volume = parseFloat(args[0]);
        if (!isNaN(volume) && volume >= 0 && volume <= 100) {
            currentVolume = volume / 100;  // Ajustar el volumen entre 0.0 y 1.0
            message.channel.send(`🔊 Volumen ajustado a ${volume}%`);

            if (queue.length > 0) {
                // Reproducir la canción actual con el nuevo volumen
                playNextInQueue(message.member.voice.channel);
            }
        } else {
            message.channel.send('Proporciona un valor de volumen entre 0 y 100.');
        }

    } else if (command === 'shuffle') {
        shuffleQueue(queue);
        message.channel.send('🔀 La cola ha sido mezclada.');
    }
});

// Función para mezclar la cola
function shuffleQueue(queue) {
    for (let i = queue.length - 1; i > 0; i--) {
        const j = Math.floor(Math.random() * (i + 1));
        [queue[i], queue[j]] = [queue[j], queue[i]];
    }
}



client.login('token de bot aqui');
