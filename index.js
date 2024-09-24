const { Client, GatewayIntentBits, PermissionsBitField } = require('discord.js');
const { joinVoiceChannel, createAudioPlayer, createAudioResource, AudioPlayerStatus, StreamType, VoiceConnectionStatus } = require('@discordjs/voice');
const { exec } = require('child_process');
const fs = require('fs');
const path = require('path');

let queue = [];  // Cola de canciones
let player;  // Reproductor de audio
let currentVolume = 0.5;  // Volumen por defecto (50%)

const client = new Client({
    intents: [
        GatewayIntentBits.Guilds,
        GatewayIntentBits.GuildVoiceStates,
        GatewayIntentBits.GuildMessages,
        GatewayIntentBits.MessageContent
    ]
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

        // Añadir la canción a la cola
        queue.push({ url: query, member: message.member, channel: message.channel });

        if (queue.length === 1) {
            // Si no hay nada reproduciéndose, empieza a reproducir
            playSong(queue[0], voiceChannel);
        } else {
            message.channel.send('La canción ha sido añadida a la cola.');
        }

    } else if (command === 'pause') {
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
            message.channel.send('⏹ Música detenida y cola eliminada.');
        }

    } else if (command === 'skip') {
        if (queue.length > 1) {
            queue.shift();  // Quitar la canción actual
            playSong(queue[0], message.member.voice.channel);
            message.channel.send('⏭ Saltando a la siguiente canción.');
        } else {
            message.channel.send('No hay más canciones en la cola.');
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
                playSong(queue[0], message.member.voice.channel);
            }
        } else {
            message.channel.send('Proporciona un valor de volumen entre 0 y 100.');
        }

    } else if (command === 'shuffle') {
        shuffleQueue(queue);
        message.channel.send('🔀 La cola ha sido mezclada.');
    }
});

// Función para reproducir la canción
function playSong(song, voiceChannel) {
    const connection = joinVoiceChannel({
        channelId: voiceChannel.id,
        guildId: voiceChannel.guild.id,
        adapterCreator: voiceChannel.guild.voiceAdapterCreator,
    });

    const tempPath = path.join(__dirname, 'temp_audio.mp3');

    exec(`yt-dlp -x --audio-format mp3 -o "${tempPath}" "${song.url}"`, (error, stdout, stderr) => {
        if (error) {
            console.error(`Error ejecutando yt-dlp: ${error.message}`);
            song.channel.send('Error al intentar descargar el audio.');
            queue.shift();  // Remover canción fallida de la cola
            if (queue.length > 0) {
                playSong(queue[0], voiceChannel);
            }
            return;
        }

        const resource = createAudioResource(fs.createReadStream(tempPath), {
            inputType: StreamType.Arbitrary,
            inlineVolume: true
        });

        resource.volume.setVolume(currentVolume);  // Ajustar el volumen actual

        player = createAudioPlayer();
        player.play(resource);
        connection.subscribe(player);

        player.on(AudioPlayerStatus.Idle, () => {
            fs.unlinkSync(tempPath);  // Eliminar archivo temporal
            queue.shift();  // Remover la canción reproducida
            if (queue.length > 0) {
                playSong(queue[0], voiceChannel);
            } else {
                connection.destroy();
            }
        });
    });
}

// Función para mezclar la cola
function shuffleQueue(queue) {
    for (let i = queue.length - 1; i > 0; i--) {
        const j = Math.floor(Math.random() * (i + 1));
        [queue[i], queue[j]] = [queue[j], queue[i]];
    }
}


client.login('token del bot aqui');
