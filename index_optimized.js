require('dotenv').config();
const { Client, GatewayIntentBits, PermissionsBitField, ActionRowBuilder, ButtonBuilder, ButtonStyle, StringSelectMenuBuilder, StringSelectMenuOptionBuilder, MessageFlags } = require('discord.js');
const { joinVoiceChannel, createAudioPlayer, createAudioResource, AudioPlayerStatus, StreamType } = require('@discordjs/voice');

// Configurar librerías de encriptación para Discord Voice
try {
    require('tweetnacl');
    console.log('✅ tweetnacl cargado para encriptación de voz');
} catch (error) {
    try {
        require('libsodium-wrappers');
        console.log('✅ libsodium-wrappers cargado como fallback');
    } catch (error2) {
        console.warn('⚠️ No hay librerías de encriptación disponibles');
    }
}
const { exec, spawn } = require('child_process');
const fs = require('fs');
const path = require('path');
const { v4: uuidv4 } = require('uuid');
const { createLogger, format, transports } = require('winston');
const moment = require('moment-timezone');
const { GoogleGenerativeAI } = require('@google/generative-ai');

// Configuración desde variables de entorno y config.json (fallback)
let config = {
    token: process.env.DISCORD_TOKEN,
    timezone: process.env.TIMEZONE || 'America/Santiago',
    geminiApiKey: process.env.GEMINI_API_KEY,
    maxFileSize: parseInt(process.env.MAX_FILE_SIZE) || 50000000,
    downloadTimeout: parseInt(process.env.DOWNLOAD_TIMEOUT) || 300000,
    downloadTimeoutLong: parseInt(process.env.DOWNLOAD_TIMEOUT_LONG) || 1800000,
    longVideoDurationThreshold: parseInt(process.env.LONG_VIDEO_DURATION_THRESHOLD) || 3600
};

// Fallback a config.json si no hay variables de entorno
if (!config.token) {
    try {
        const configFile = JSON.parse(fs.readFileSync('./config.json', 'utf8'));
        config = {
            token: configFile.token || config.token,
            timezone: configFile.timezone || config.timezone,
            geminiApiKey: configFile.geminiApiKey || config.geminiApiKey,
            maxFileSize: configFile.maxFileSize || config.maxFileSize,
            downloadTimeout: configFile.downloadTimeout || config.downloadTimeout,
            downloadTimeoutLong: configFile.downloadTimeoutLong || config.downloadTimeoutLong,
            longVideoDurationThreshold: configFile.longVideoDurationThreshold || config.longVideoDurationThreshold
        };
        logger.info('📄 Configuración cargada desde config.json');
    } catch (error) {
        logger.warn('⚠️ No se encontró config.json, usando solo variables de entorno');
    }
}

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
        model = genAI.getGenerativeModel({ model: "gemini-2.5-flash" });
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
let isSeeking = false; // Variable para identificar cuando estamos haciendo seek
let currentSong = null;
let controlMessage = null;
let isRepeatMode = false; // Modo repetir playlist
let isLoopingSong = false; // Modo loop canción individual
let originalPlaylist = []; // Guardar playlist original para repeat
let currentVolume = 0.5; // Volumen inicial (50%)
let currentSeekPosition = 0; // Posición actual en segundos para seek
let audioFilters = {
    bass: 0,      // Bass boost (-10 a +10)
    treble: 0,    // Treble boost (-10 a +10)  
    speed: 1.0,   // Velocidad (0.5 a 2.0)
    preset: null  // Preset activo
};
const processes = new Set();
const addingSongs = new Set(); // Protección contra duplicación

// Cache de metadatos para evitar consultas repetidas
const metadataCache = new Map();
const CACHE_EXPIRY = 30 * 60 * 1000; // 30 minutos

// Archivo para persistencia
const QUEUE_BACKUP_FILE = './queue_backup.json';
const FAVORITES_FILE = './favorites.json';

// Función para limpiar cache expirado
function cleanupExpiredCache() {
    const now = Date.now();
    for (const [key, value] of metadataCache.entries()) {
        if (now - value.timestamp > CACHE_EXPIRY) {
            metadataCache.delete(key);
        }
    }
}

// Limpiar cache cada 10 minutos
setInterval(cleanupExpiredCache, 10 * 60 * 1000);

// Función para guardar la cola
function saveQueue() {
    try {
        const queueData = {
            queue: queue.map(song => ({
                url: song.url,
                title: song.title,
                duration: song.duration,
                shouldStream: song.shouldStream
            })),
            originalPlaylist: originalPlaylist.map(song => ({
                url: song.url,
                title: song.title,
                duration: song.duration,
                shouldStream: song.shouldStream
            })),
            isRepeatMode: isRepeatMode,
            isLoopingSong: isLoopingSong,
            currentVolume: currentVolume,
            currentSong: currentSong ? {
                url: currentSong.url,
                title: currentSong.title,
                duration: currentSong.duration,
                shouldStream: currentSong.shouldStream
            } : null,
            timestamp: new Date().toISOString()
        };
        
        fs.writeFileSync(QUEUE_BACKUP_FILE, JSON.stringify(queueData, null, 2));
        logger.info('💾 Cola guardada correctamente');
    } catch (error) {
        logger.error(`❌ Error guardando cola: ${error.message}`);
    }
}

// Función para cargar la cola
function loadQueue() {
    try {
        if (!fs.existsSync(QUEUE_BACKUP_FILE)) {
            logger.info('📂 No hay backup de cola para cargar');
            return;
        }
        
        const data = fs.readFileSync(QUEUE_BACKUP_FILE, 'utf8');
        const queueData = JSON.parse(data);
        
        // Restaurar solo los datos básicos (sin member y channel)
        queue = queueData.queue || [];
        originalPlaylist = queueData.originalPlaylist || [];
        isRepeatMode = queueData.isRepeatMode || false;
        isLoopingSong = queueData.isLoopingSong || false;
        currentVolume = queueData.currentVolume || 0.5;
        
        logger.info(`📂 Cola cargada: ${queue.length} canciones, Repeat: ${isRepeatMode ? 'ON' : 'OFF'}, Volumen: ${Math.round(currentVolume * 100)}%`);
        
        if (queue.length > 0) {
            logger.info('💡 Usa !play para reanudar la reproducción');
        }
        
    } catch (error) {
        logger.error(`❌ Error cargando cola: ${error.message}`);
    }
}

// Función para cargar favoritos
function loadFavorites() {
    try {
        if (!fs.existsSync(FAVORITES_FILE)) {
            return {};
        }
        const data = fs.readFileSync(FAVORITES_FILE, 'utf8');
        return JSON.parse(data);
    } catch (error) {
        logger.error(`❌ Error cargando favoritos: ${error.message}`);
        return {};
    }
}

// Función para guardar favoritos
function saveFavorites(favorites) {
    try {
        fs.writeFileSync(FAVORITES_FILE, JSON.stringify(favorites, null, 2));
        logger.info('💾 Favoritos guardados correctamente');
    } catch (error) {
        logger.error(`❌ Error guardando favoritos: ${error.message}`);
    }
}

// Función para añadir favorito
function addFavorite(userId, songData) {
    const favorites = loadFavorites();
    if (!favorites[userId]) {
        favorites[userId] = [];
    }
    
    // Evitar duplicados
    const exists = favorites[userId].some(fav => fav.url === songData.url);
    if (exists) {
        return false;
    }
    
    favorites[userId].push({
        url: songData.url,
        title: songData.title,
        duration: songData.duration,
        shouldStream: songData.shouldStream,
        addedAt: new Date().toISOString()
    });
    
    saveFavorites(favorites);
    return true;
}

// Función para remover favorito
function removeFavorite(userId, position) {
    const favorites = loadFavorites();
    if (!favorites[userId] || position < 1 || position > favorites[userId].length) {
        return null;
    }
    
    const removed = favorites[userId].splice(position - 1, 1)[0];
    saveFavorites(favorites);
    return removed;
}

// Función para obtener favoritos de usuario
function getUserFavorites(userId) {
    const favorites = loadFavorites();
    return favorites[userId] || [];
}

// Función para parsear tiempo en formato MM:SS o segundos a segundos
function parseTimeToSeconds(timeStr) {
    if (!timeStr) return 0;
    
    // Si es un número puro (segundos)
    if (!isNaN(timeStr)) {
        return parseInt(timeStr);
    }
    
    // Si contiene ":" es formato MM:SS o HH:MM:SS
    const parts = timeStr.split(':');
    let seconds = 0;
    
    if (parts.length === 2) { // MM:SS
        seconds = parseInt(parts[0]) * 60 + parseInt(parts[1]);
    } else if (parts.length === 3) { // HH:MM:SS
        seconds = parseInt(parts[0]) * 3600 + parseInt(parts[1]) * 60 + parseInt(parts[2]);
    }
    
    return seconds;
}

// Función para formatear segundos a MM:SS
function formatSecondsToTime(seconds) {
    const hours = Math.floor(seconds / 3600);
    const mins = Math.floor((seconds % 3600) / 60);
    const secs = seconds % 60;
    
    if (hours > 0) {
        return `${hours}:${mins.toString().padStart(2, '0')}:${secs.toString().padStart(2, '0')}`;
    }
    return `${mins}:${secs.toString().padStart(2, '0')}`;
}

// Función para hacer seek (solo funciona con archivos descargados)
async function seekToPosition(seconds, song, voiceChannel) {
    if (!currentSong || !player) {
        return { success: false, error: 'No hay música reproduciéndose' };
    }
    
    // Solo funciona si la canción NO está en streaming
    if (song.shouldStream) {
        return { success: false, error: 'Seek no disponible en modo streaming. Solo funciona con canciones descargadas (📥).' };
    }
    
    try {
        // Establecer nueva posición de seek
        currentSeekPosition = seconds;
        
        // Marcar que estamos haciendo seek (no skip) - IMPORTANTE para evitar que se salte a la siguiente
        isProcessing = true;
        isSeeking = true; // Nueva variable para identificar seek vs stop normal
        
        // Detener el player actual
        if (player.state.status !== 'idle') {
            player.stop();
        }
        
        // Reproducir desde la nueva posición SIN quitar la canción de la cola
        setTimeout(async () => {
            await playWithSeek(song, voiceChannel, seconds);
            isSeeking = false;
        }, 500);
        
        return { success: true, position: formatSecondsToTime(seconds) };
        
    } catch (error) {
        isSeeking = false;
        return { success: false, error: error.message };
    }
}

// Función especial para reproducir con seek (evita cambiar la cola)
async function playWithSeek(song, voiceChannel, seekSeconds = 0) {
    // Archivo temporal único
    const tempPath = path.join(__dirname, `temp_audio_${uuidv4()}.mp3`);
    
    song.channel.send(`⏩ **Navegando a**: ${formatSecondsToTime(seekSeconds)} - ${song.title}`);

    // Comando yt-dlp con seek
    const ytdlpArgs = [
        '-f', 'bestaudio/best',
        '--no-warnings',
        '--no-playlist',
        '--retries', '3',
        '--socket-timeout', '30',
        '--download-sections', `*${seekSeconds}-inf`,
        '-o', tempPath, 
        song.url
    ];

    logger.info(`Ejecutando seek: yt-dlp ${ytdlpArgs.join(' ')}`);
    const child = spawn('yt-dlp', ytdlpArgs, {
        env: { ...process.env, PYTHONIOENCODING: 'utf-8' },
        stdio: ['pipe', 'pipe', 'pipe']
    });

    // Timeout para descarga
    const timeoutId = setTimeout(() => {
        logger.error('Timeout en descarga de seek');
        child.kill('SIGKILL');
        cleanupTempFile(tempPath);
        song.channel.send('⏰ **Timeout en seek** - Reintentando...');
        isSeeking = false;
        isProcessing = false;
    }, 60000); // 1 minuto para seek

    child.on('error', error => {
        clearTimeout(timeoutId);
        logger.error(`Error en yt-dlp seek: ${error.message}`);
        song.channel.send('❌ Error en navegación.');
        cleanupTempFile(tempPath);
        isSeeking = false;
        isProcessing = false;
    });

    child.on('close', async (code) => {
        clearTimeout(timeoutId);
        
        if (code === 0 && fs.existsSync(tempPath)) {
            try {
                // Generar filtros de audio si están activos
                const audioFilter = generateAudioFilter();
                let audioArgs = ['-i', tempPath];
                
                if (audioFilter) {
                    audioArgs.push('-af', audioFilter);
                }
                
                audioArgs.push('-f', 'mp3', 'pipe:1');
                
                // Crear resource con FFmpeg
                const ffmpegProcess = spawn('ffmpeg', audioArgs, {
                    stdio: ['pipe', 'pipe', 'pipe']
                });
                
                const resource = createAudioResource(ffmpegProcess.stdout, {
                    inputType: StreamType.Arbitrary,
                    inlineVolume: true
                });
                
                resource.volume.setVolume(currentVolume);
                
                // Reproducir sin crear nuevos event listeners
                player.play(resource);
                connection.subscribe(player);
                
                // Actualizar posición actual
                currentSeekPosition = seekSeconds;
                isProcessing = false;
                
                song.channel.send(`▶️ **Reproduciendo desde**: ${formatSecondsToTime(seekSeconds)}`);
                
                // Cleanup del proceso FFmpeg cuando termine
                ffmpegProcess.on('close', () => {
                    cleanupTempFile(tempPath);
                });
                
            } catch (error) {
                logger.error(`Error en reproducción de seek: ${error.message}`);
                cleanupTempFile(tempPath);
                isSeeking = false;
                isProcessing = false;
            }
        } else {
            song.channel.send('❌ Error descargando para navegación.');
            cleanupTempFile(tempPath);
            isSeeking = false;
            isProcessing = false;
        }
    });
}

// Función para generar filtros de audio FFmpeg
function generateAudioFilter() {
    const filters = [];
    
    // Bass boost (filtro de 60Hz)
    if (audioFilters.bass !== 0) {
        filters.push(`equalizer=f=60:width_type=h:width=2:g=${audioFilters.bass}`);
    }
    
    // Treble boost (filtro de 10kHz)
    if (audioFilters.treble !== 0) {
        filters.push(`equalizer=f=10000:width_type=h:width=2:g=${audioFilters.treble}`);
    }
    
    // Cambio de velocidad
    if (audioFilters.speed !== 1.0) {
        filters.push(`atempo=${audioFilters.speed}`);
    }
    
    return filters.length > 0 ? filters.join(',') : null;
}

// Presets de ecualizador
const EQUALIZER_PRESETS = {
    rock: { bass: 3, treble: 2, speed: 1.0 },
    pop: { bass: 1, treble: 3, speed: 1.0 },
    jazz: { bass: -1, treble: 1, speed: 1.0 },
    classical: { bass: 0, treble: 0, speed: 1.0 },
    electronic: { bass: 5, treble: 4, speed: 1.0 },
    bass_boost: { bass: 8, treble: -2, speed: 1.0 },
    nightcore: { bass: -3, treble: 2, speed: 1.25 },
    slowdown: { bass: 2, treble: -1, speed: 0.8 },
    clear: { bass: 0, treble: 0, speed: 1.0 }
};

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
        
        // Verificar cache primero
        const cachedData = metadataCache.get(cleanedUrl);
        if (cachedData && (Date.now() - cachedData.timestamp < CACHE_EXPIRY)) {
            logger.info(`📦 Usando información cacheada para: ${cachedData.data.title}`);
            resolve(cachedData.data);
            return;
        }
        
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
            
            const videoData = { 
                title: title, 
                originalTitle: title,
                duration: duration,
                isLong: isLong,
                shouldStream: shouldStream
            };
            
            // Cachear la información
            metadataCache.set(cleanedUrl, {
                data: videoData,
                timestamp: Date.now()
            });
            
            resolve(videoData);
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
        
        const prompt = `Analiza la canción "${songTitle}" y sugiere exactamente 10 canciones similares siguiendo estos criterios de prioridad:

        CRITERIOS DE SUGERENCIA (en orden de importancia):
        1. 🎤 MISMO ARTISTA: 3-4 canciones del mismo artista/grupo si es posible
        2. 🎵 MISMO GÉNERO: 3-4 canciones del mismo género musical 
        3. 🎶 MISMA ÉPOCA: 2-3 canciones de la misma década/era musical
        4. 🔥 POPULARIDAD: Todas deben ser canciones reconocidas y disponibles en YouTube
        
        FORMATO REQUERIDO:
        - Responde SOLO con los títulos en formato "Artista - Título de la canción"
        - Una canción por línea (exactamente 10 líneas)
        - No incluyas números, guiones o símbolos al inicio
        - No agregues explicaciones, comentarios o texto adicional
        - Asegúrate de que sean canciones reales y populares
        
        EJEMPLOS DE ANÁLISIS:
        - Si es anime/J-pop: sugiere más anime songs y J-pop
        - Si es rock clásico: sugiere más rock de esa época
        - Si es reggaeton: sugiere más reggaeton y artistas similares
        - Si es pop: sugiere pop mainstream y artistas relacionados
        
        Ejemplo de formato correcto:
        LiSA - Gurenge
        Aimer - Brave Shine
        YOASOBI - Yoru ni Kakeru
        Kenshi Yonezu - Lemon`;

        const result = await model.generateContent(prompt);
        const response = await result.response;
        const suggestions = response.text().trim();
        
        // Procesar las sugerencias
        const songLines = suggestions.split('\n')
            .map(line => line.trim())
            .filter(line => line.length > 0 && line.includes(' - '))
            .slice(0, 10); // Máximo 10 sugerencias

        logger.info(`✅ IA generó ${songLines.length} sugerencias para: ${songTitle}`);
        return songLines;

    } catch (error) {
        if (error.message.includes('overloaded') || error.message.includes('503')) {
            logger.warn(`⚠️ Modelo de IA sobrecargado: ${error.message}`);
            return 'OVERLOADED';
        } else {
            logger.error(`❌ Error obteniendo sugerencias de IA: ${error.message}`);
            return null;
        }
    }
}

// Función para mostrar sugerencias de IA
async function showAISuggestions(channel, songTitle) {
    if (!model) {
        return channel.send('⚠️ Las sugerencias de IA no están habilitadas. Configura la API key de Gemini en config.json');
    }

    const suggestionMsg = await channel.send('🤖 **Generando sugerencias similares...**');
    
    const suggestions = await getAISuggestions(songTitle);
    
    if (suggestions === 'OVERLOADED') {
        return suggestionMsg.edit({
            embeds: [{
                color: 0xFFAA00,
                title: '⚠️ Servicio temporalmente no disponible',
                description: '🤖 El modelo de IA está sobrecargado en este momento.\n\n⏰ **Por favor, intenta de nuevo en unos minutos**\n\nPuedes seguir usando el bot para reproducir música normalmente.',
                footer: { text: 'Error 503 - Servicio temporalmente no disponible' }
            }]
        });
    }
    
    if (!suggestions || suggestions.length === 0) {
        return suggestionMsg.edit({
            embeds: [{
                color: 0xFF0000,
                title: '❌ Error generando sugerencias',
                description: 'No se pudieron generar sugerencias en este momento.\n\nPuedes intentar de nuevo más tarde o usar `!play [canción]` para añadir música manualmente.',
                footer: { text: 'Servicio de IA temporalmente no disponible' }
            }]
        });
    }

    // Crear menú desplegable de sugerencias
    const selectMenu = new StringSelectMenuBuilder()
        .setCustomId('ai_suggestions')
        .setPlaceholder('🤖 10 sugerencias inteligentes - Haz clic para seleccionar')
        .addOptions(
            suggestions.map((song, index) => 
                new StringSelectMenuOptionBuilder()
                    .setLabel(song.length > 100 ? song.substring(0, 97) + '...' : song)
                    .setDescription('🎵 Standard Quality • 128kbps ⭐ 5.0 ⬆️ Trending')
                    .setValue(`suggestion_${index}`)
                    .setEmoji('🎵')
            )
        );

    const row = new ActionRowBuilder().addComponents(selectMenu);

    const suggestEmbed = {
        color: 0x1DB954, // Verde Spotify
        title: `🎵 Now Playing - ${songTitle}`,
        description: `🎵 Standard Quality • 128kbps\n⭐ 5.0 ⬆️ Trending\nRequested by user`,
        footer: { text: '🤖 10 sugerencias inteligentes - Selecciona del menú desplegable para añadir a la cola' }
    };

    // Guardar sugerencias en el mensaje para uso posterior
    suggestionMsg.suggestions = suggestions;

    await suggestionMsg.edit({
        content: '',
        embeds: [suggestEmbed],
        components: [row]
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
    // Protección contra duplicación - verificar si ya se está procesando esta URL
    if (addingSongs.has(url)) {
        logger.warn(`⚠️ La canción ${url} ya se está procesando, ignorando duplicado`);
        return;
    }
    
    addingSongs.add(url); // Marcar como en proceso
    
    try {
        logger.info(`🔍 Añadiendo canción: ${url}`);
        
        // Verificar duplicados
        const isDuplicate = queue.some(song => song.url === url) || (currentSong && currentSong.url === url);
        if (isDuplicate) {
            addingSongs.delete(url); // Limpiar semáforo
            return channel.send('❌ Esta canción ya está en la cola o reproduciéndose.');
        }
        
        const videoInfo = await getVideoInfo(url);
        
        // Rechazar videos muy largos (más de 4 horas)
        if (videoInfo.isLong) {
            addingSongs.delete(url); // Limpiar semáforo
            return channel.send('❌ Este video es demasiado largo (más de 4 horas). Solo se permiten videos de hasta 4 horas.');
        }
        
        // Añadir a la cola
        const songData = { 
            url, 
            title: videoInfo.title, 
            duration: videoInfo.duration,
            shouldStream: videoInfo.shouldStream, // Nuevo flag para streaming
            member, 
            channel 
        };
        
        queue.push(songData);
        
        // También añadir a la playlist original para repeat
        if (!originalPlaylist.some(song => song.url === url)) {
            originalPlaylist.push({...songData});
        }
        
        // Guardar cola después de añadir canción
        saveQueue();
        
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
        
        addingSongs.delete(url); // Limpiar semáforo
    } catch (error) {
        logger.error('❌ Error al obtener información del video:', error);
        channel.send('❌ Error al procesar el video.');
        addingSongs.delete(url); // Limpiar semáforo en caso de error
    }
}

// Reproducir siguiente canción (simplificado)
async function playNextInQueue(voiceChannel, channel = null) {
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
                selfDeaf: false,
                selfMute: false,
                useDAVE: false // Deshabilitar protocolo DAVE
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
        // Si está en modo repeat y hay una playlist original, repetirla
        if (isRepeatMode && originalPlaylist.length > 0) {
            logger.info('🔁 Modo repeat activado: reiniciando playlist...');
            queue = [...originalPlaylist]; // Copiar la playlist original
            // Continuar con la primera canción de la playlist repetida
            // No hacer return aquí, continuar con la lógica normal de reproducción
        } else {
            // Cola vacía y sin repeat - desconectar
            if (connection) {
                connection.destroy();
                connection = null;
            }
            currentSong = null;
            isProcessing = false;
            originalPlaylist = []; // Limpiar playlist original
            if (controlMessage) {
                await controlMessage.edit({ components: [] });
                controlMessage = null;
            }
            return;
        }
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
        await playStreamDirectly(song, voiceChannel, channel);
    } else {
        logger.info(`📥 Iniciando descarga para: ${song.title}`);
        await playWithDownload(song, voiceChannel, 0, channel);
    }
}

// Función para reproducir mediante streaming directo
async function playStreamDirectly(song, voiceChannel, channel = null) {
    try {
        const sendChannel = channel || song.channel;
        if (sendChannel) sendChannel.send(`🌐 **Obteniendo stream**: ${song.title}`);
        
        const streamUrl = await getStreamUrl(song.url);
        
        if (sendChannel) sendChannel.send(`🎵 **Iniciando streaming**: ${song.title}`);
        
        const resource = createAudioResource(streamUrl, {
            inputType: StreamType.Arbitrary,
            inlineVolume: true
        });
        
        resource.volume.setVolume(currentVolume);
        
        player = createAudioPlayer();
        connection.subscribe(player);
        player.play(resource);

        player.on(AudioPlayerStatus.Playing, () => {
            logger.info(`🌐 Streaming: ${song.title}`);
            const controlChannel = channel || song.channel;
            if (controlChannel) showMusicControls(controlChannel);
        });

        player.on(AudioPlayerStatus.Idle, () => {
            logger.info(`🌐 Stream finalizado: ${song.title}`);
            
            // Si estamos haciendo seek, no avanzar a la siguiente canción
            if (isSeeking) {
                logger.info(`⏩ Seek en progreso - no avanzar cola`);
                return;
            }
            
            if (isLoopingSong) {
                // Repetir la misma canción
                logger.info(`🔁 Looping canción: ${song.title}`);
                isProcessing = false;
                playNextInQueue(voiceChannel);
            } else {
                queue.shift();
                saveQueue(); // Guardar después de remover canción
                isProcessing = false;
                playNextInQueue(voiceChannel);
            }
        });

        player.on('error', error => {
            logger.error(`❌ Error de streaming: ${error.message}`);
            const fallbackChannel = channel || song.channel;
            if (fallbackChannel) fallbackChannel.send(`❌ Error en streaming. Intentando descarga como fallback...`);
            // Fallback a descarga
            song.shouldStream = false;
            playWithDownload(song, voiceChannel, 0, channel);
        });

    } catch (error) {
        logger.error(`❌ Error obteniendo stream: ${error.message}`);
        const errorChannel = channel || song.channel;
        if (errorChannel) errorChannel.send(`❌ Error en streaming. Intentando descarga como fallback...`);
        // Fallback a descarga
        song.shouldStream = false;
        await playWithDownload(song, voiceChannel, 0, channel);
    }
}

// Función para reproducir mediante descarga (método original)
async function playWithDownload(song, voiceChannel, seekSeconds = 0, channel = null) {
    // Archivo temporal único
    const tempPath = path.join(__dirname, `temp_audio_${uuidv4()}.mp3`);
    
    const sendChannel = channel || song.channel;
    if (sendChannel) sendChannel.send(`📥 **Descargando**: ${song.title}`);

    // Comando yt-dlp simplificado para videos normales
    const ytdlpArgs = [
        '-f', 'bestaudio/best',
        '--no-warnings',
        '--no-playlist',
        '--retries', '3',
        '--socket-timeout', '30'
    ];
    
    // Agregar seek si se especifica
    if (seekSeconds > 0) {
        ytdlpArgs.push('--download-sections', `*${seekSeconds}-inf`);
        if (sendChannel) sendChannel.send(`⏩ **Iniciando desde**: ${formatSecondsToTime(seekSeconds)}`);
    }
    
    ytdlpArgs.push('-o', tempPath, song.url);

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
        if (sendChannel) sendChannel.send('⏰ **Timeout en descarga** - La descarga tardó demasiado.');
        queue.shift();
        isProcessing = false;
        playNextInQueue(voiceChannel);
    }, 300000); // 5 minutos

    // Manejo de errores del proceso
    child.on('error', error => {
        clearTimeout(timeoutId);
        logger.error(`Error en yt-dlp: ${error.message}`);
        if (sendChannel) sendChannel.send('❌ Error al descargar el audio.');
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
            if (sendChannel) sendChannel.send('❌ Error al descargar el audio. Saltando canción...');
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

            // Aplicar filtros de audio si están activos
            const audioFilter = generateAudioFilter();
            let audioSource;
            
            if (audioFilter && !song.shouldStream) {
                // Solo aplicar filtros a archivos descargados
                logger.info(`🎛️ Aplicando filtros: ${audioFilter}`);
                const ffmpegArgs = [
                    '-i', tempPath,
                    '-af', audioFilter,
                    '-f', 'mp3',
                    'pipe:1'
                ];
                
                const ffmpeg = spawn('ffmpeg', ffmpegArgs, { stdio: ['pipe', 'pipe', 'pipe'] });
                audioSource = ffmpeg.stdout;
                
                // Manejo de errores del proceso FFmpeg
                ffmpeg.on('error', (error) => {
                    logger.error(`❌ Error en FFmpeg: ${error.message}`);
                });
                
                ffmpeg.stderr.on('data', (data) => {
                    // Silenciar logs de FFmpeg (son muy verbosos)
                });
                
            } else {
                audioSource = fs.createReadStream(tempPath);
            }

            const resource = createAudioResource(audioSource, {
                inputType: StreamType.Arbitrary,
                inlineVolume: true
            });
            
            resource.volume.setVolume(currentVolume);
            
            player = createAudioPlayer();
            connection.subscribe(player);
            player.play(resource);

            player.on(AudioPlayerStatus.Playing, () => {
                logger.info(`📥 Reproduciendo: ${song.title}`);
                const controlChannel = channel || song.channel;
                if (controlChannel) showMusicControls(controlChannel);
            });

            player.on(AudioPlayerStatus.Idle, () => {
                logger.info(`📥 Canción finalizada: ${song.title}`);
                cleanupTempFile(tempPath);
                
                // Si estamos haciendo seek, no avanzar a la siguiente canción
                if (isSeeking) {
                    logger.info(`⏩ Seek en progreso - no avanzar cola`);
                    return;
                }
                
                if (isLoopingSong) {
                    // Repetir la misma canción
                    logger.info(`🔁 Looping canción: ${song.title}`);
                    isProcessing = false;
                    playNextInQueue(voiceChannel);
                } else {
                    queue.shift();
                    saveQueue(); // Guardar después de remover canción
                    isProcessing = false;
                    playNextInQueue(voiceChannel);
                }
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
            if (sendChannel) sendChannel.send('❌ Error al reproducir el audio.');
            cleanupTempFile(tempPath);
            queue.shift();
            isProcessing = false;
            playNextInQueue(voiceChannel);
        }
    });

    processes.add(child);
}

// Función para mostrar cola con paginación para mensajes
async function showQueueMessage(channel, page = 0) {
    if (queue.length === 0) {
        return channel.send('La cola está vacía.');
    }

    const itemsPerPage = 10;
    const totalPages = Math.ceil(queue.length / itemsPerPage);
    const startIndex = page * itemsPerPage;
    const endIndex = Math.min(startIndex + itemsPerPage, queue.length);
    
    const queueList = queue.slice(startIndex, endIndex).map((song, index) => {
        const globalIndex = startIndex + index + 1;
        const duration = song.duration ? ` \`[${song.duration}]\`` : ' `[--:--]`';
        const method = song.shouldStream ? '🌐' : '📥';
        return `${globalIndex}. ${normalizeUTF8(song.title)}${duration} ${method}`;
    }).join('\n');

    const queueEmbed = {
        title: '🎶 Cola de Reproducción',
        description: queueList,
        color: 0x00ff00,
        footer: { 
            text: `Página ${page + 1}/${totalPages} | ${queue.length} canciones totales | 🌐 = Streaming, 📥 = Descarga`
        }
    };

    // Crear botones de navegación solo si hay más de una página
    const components = [];
    if (queue.length > 10) {
        const row = new ActionRowBuilder().addComponents(
            new ButtonBuilder()
                .setCustomId(`queue_msg_prev_${page}`)
                .setLabel('◀️ Anterior')
                .setStyle(ButtonStyle.Secondary)
                .setDisabled(page === 0),
            new ButtonBuilder()
                .setCustomId(`queue_msg_next_${page}`)
                .setLabel('Siguiente ▶️')
                .setStyle(ButtonStyle.Secondary)
                .setDisabled(page === totalPages - 1),
            new ButtonBuilder()
                .setCustomId('queue_msg_close')
                .setLabel('❌ Cerrar')
                .setStyle(ButtonStyle.Danger)
        );
        components.push(row);
    }

    const message = await channel.send({ embeds: [queueEmbed], components });
    
    // Auto-eliminar después de 5 minutos si tiene botones de navegación
    if (components.length > 0) {
        setTimeout(async () => {
            try {
                await message.delete();
            } catch (error) {
                // Ignorar errores si el mensaje ya fue eliminado
            }
        }, 5 * 60 * 1000);
    }
    
    return message;
}

// Función para mostrar cola con paginación
async function showQueuePaginated(interaction, page = 0) {
    if (queue.length === 0) {
        return interaction.reply({ content: 'La cola está vacía', flags: MessageFlags.Ephemeral });
    }

    const itemsPerPage = 10;
    const totalPages = Math.ceil(queue.length / itemsPerPage);
    const startIndex = page * itemsPerPage;
    const endIndex = Math.min(startIndex + itemsPerPage, queue.length);
    
    const queueList = queue.slice(startIndex, endIndex).map((song, index) => {
        const globalIndex = startIndex + index + 1;
        const duration = song.duration ? ` \`[${song.duration}]\`` : ' `[--:--]`';
        const method = song.shouldStream ? '🌐' : '📥';
        return `${globalIndex}. ${normalizeUTF8(song.title)}${duration} ${method}`;
    }).join('\n');

    const queueEmbed = {
        title: '🎶 Cola de Reproducción',
        description: queueList,
        color: 0x00ff00,
        footer: { 
            text: `Página ${page + 1}/${totalPages} | ${queue.length} canciones totales | 🌐 = Streaming, 📥 = Descarga`
        }
    };

    // Crear botones de navegación solo si hay más de una página
    const components = [];
    if (queue.length > 10) {
        const row = new ActionRowBuilder().addComponents(
            new ButtonBuilder()
                .setCustomId(`queue_prev_${page}`)
                .setLabel('◀️ Anterior')
                .setStyle(ButtonStyle.Secondary)
                .setDisabled(page === 0),
            new ButtonBuilder()
                .setCustomId(`queue_next_${page}`)
                .setLabel('Siguiente ▶️')
                .setStyle(ButtonStyle.Secondary)
                .setDisabled(page === totalPages - 1),
            new ButtonBuilder()
                .setCustomId('queue_close')
                .setLabel('❌ Cerrar')
                .setStyle(ButtonStyle.Danger)
        );
        components.push(row);
    }

    if (interaction.replied || interaction.deferred) {
        await interaction.editReply({ embeds: [queueEmbed], components });
    } else {
        // Para colas grandes (>10 canciones), usar mensaje normal con botones
        // Para colas pequeñas (≤10 canciones), usar mensaje ephemeral sin botones
        if (queue.length > 10) {
            const reply = await interaction.reply({ embeds: [queueEmbed], components });
            console.log(`🐛 Sent non-ephemeral queue with ${components.length} components`);
            // Auto-eliminar después de 5 minutos para mantener el canal limpio
            setTimeout(async () => {
                try {
                    await reply.delete();
                } catch (error) {
                    // Ignorar errores si el mensaje ya fue eliminado
                }
            }, 5 * 60 * 1000);
        } else {
            await interaction.reply({ embeds: [queueEmbed], flags: MessageFlags.Ephemeral });
            console.log(`🐛 Sent ephemeral queue (small queue)`);
        }
    }
}

// Mostrar controles de música (simplificado)
async function showMusicControls(channel) {
    if (!channel || !channel.send) {
        logger.warn('Canal no válido para mostrar controles');
        return;
    }
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
            .setCustomId('repeat_toggle')
            .setLabel(isRepeatMode ? '🔁 Repetir: ON' : '🔁 Repetir: OFF')
            .setStyle(isRepeatMode ? ButtonStyle.Success : ButtonStyle.Secondary),
        new ButtonBuilder()
            .setCustomId('ai_suggest')
            .setLabel('🤖 Sugerir Similar')
            .setStyle(ButtonStyle.Secondary)
            .setDisabled(!model), // Deshabilitar si no hay IA configurada
        new ButtonBuilder()
            .setCustomId('loop_song')
            .setLabel(isLoopingSong ? '🔂 Loop: ON' : '🔂 Loop: OFF')
            .setStyle(isLoopingSong ? ButtonStyle.Success : ButtonStyle.Secondary)
    );
    
    const row3 = new ActionRowBuilder().addComponents(
        new ButtonBuilder()
            .setCustomId('volume_down')
            .setLabel('🔉 -10%')
            .setStyle(ButtonStyle.Secondary),
        new ButtonBuilder()
            .setCustomId('volume_current')
            .setLabel(`🔊 ${Math.round(currentVolume * 100)}%`)
            .setStyle(ButtonStyle.Secondary)
            .setDisabled(true),
        new ButtonBuilder()
            .setCustomId('volume_up')
            .setLabel('🔊 +10%')
            .setStyle(ButtonStyle.Secondary),
        new ButtonBuilder()
            .setCustomId('add_favorite')
            .setLabel('⭐ Favorito')
            .setStyle(ButtonStyle.Secondary)
    );

    try {
        if (controlMessage) {
            await controlMessage.delete().catch(() => {});
        }

        controlMessage = await channel.send({
            content: 'Controla la reproducción de música:',
            components: [row, row2, row3],
        });
    } catch (error) {
        console.error('Error enviando controles:', error);
    }
}

// Manejo de interacciones de botones y slash commands
client.on('interactionCreate', async interaction => {
    // Manejo de slash commands
    if (interaction.isChatInputCommand()) {
        const voiceChannel = interaction.member.voice.channel;
        
        switch (interaction.commandName) {
            case 'play':
                if (!voiceChannel) {
                    return interaction.reply({ content: 'Debes estar en un canal de voz para reproducir música.', flags: MessageFlags.Ephemeral });
                }
                
                const query = interaction.options.getString('cancion');
                await interaction.deferReply();
                
                // Validar que no estamos procesando múltiples canciones a la vez
                if (isProcessing) {
                    return interaction.editReply('⏳ Ya se está procesando una canción. Espera un momento.');
                }
                
                if (query.startsWith('http')) {
                    const cleanedUrl = cleanYouTubeUrl(query);
                    if (!isValidYouTubeUrl(cleanedUrl)) {
                        return interaction.editReply('❌ URL de YouTube no válida');
                    }
                    
                    // Verificar si es una playlist
                    if (query.includes('list=')) {
                        // Procesar playlist completa
                        await interaction.editReply('📝 Obteniendo playlist...');
                        
                        exec(`yt-dlp --flat-playlist --print "%(id)s|%(title)s" --no-warnings "${cleanedUrl}"`, { 
                            maxBuffer: 10 * 1024 * 1024, 
                            timeout: 60000,
                            encoding: 'utf8',
                            env: { ...process.env, PYTHONIOENCODING: 'utf-8' }
                        }, (error, stdout, stderr) => {
                            if (error) {
                                return interaction.editReply('❌ Error al obtener la playlist.');
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
                                            const songData = { 
                                                url: videoUrl, 
                                                title: title,
                                                shouldStream: false, // Se determinará cuando se procese
                                                member: interaction.member, 
                                                channel: interaction.channel 
                                            };
                                            
                                            queue.push(songData);
                                            
                                            // También añadir a la playlist original para repeat
                                            if (!originalPlaylist.some(song => song.url === videoUrl)) {
                                                originalPlaylist.push({...songData});
                                            }
                                            
                                            songsAdded++;
                                        }
                                    }
                                }

                                if (songsAdded > 0) {
                                    interaction.editReply(`✅ Se añadieron ${songsAdded} canciones a la cola.`);
                                    saveQueue(); // Guardar después de añadir playlist
                                    if (!isProcessing) {
                                        playNextInQueue(voiceChannel);
                                    }
                                } else {
                                    interaction.editReply('❌ No se encontraron canciones válidas en la playlist.');
                                }
                            } catch (parseError) {
                                interaction.editReply('❌ Error al procesar la playlist.');
                            }
                        });
                    } else {
                        // URL de canción individual
                        await addSongToQueue(cleanedUrl, interaction.member, interaction.channel, voiceChannel);
                        await interaction.editReply('✅ Canción añadida a la cola');
                    }
                } else {
                    // Búsqueda
                    exec(`yt-dlp "ytsearch1:${query}" --print "%(id)s" --print "%(title)s" --no-warnings`, { 
                        timeout: 10000,
                        encoding: 'utf8',
                        env: { ...process.env, PYTHONIOENCODING: 'utf-8' }
                    }, async (error, stdout, stderr) => {
                        if (error) {
                            return interaction.editReply('❌ Error en la búsqueda');
                        }
                        
                        const lines = stdout.trim().split('\n');
                        if (lines.length >= 2) {
                            const videoId = lines[0];
                            const videoTitle = normalizeUTF8(lines[1]);
                            const videoUrl = `https://www.youtube.com/watch?v=${videoId}`;
                            await addSongToQueue(videoUrl, interaction.member, interaction.channel, voiceChannel);
                            await interaction.editReply(`✅ Canción encontrada y añadida: **${videoTitle}**`);
                        } else {
                            await interaction.editReply('❌ No se encontraron resultados');
                        }
                    });
                }
                break;
                
            case 'volume':
                const volume = interaction.options.getInteger('nivel');
                
                if (!player || !player.state.resource) {
                    return interaction.reply({ content: '❌ No hay música reproduciéndose', flags: MessageFlags.Ephemeral });
                }
                
                currentVolume = volume / 100;
                if (player.state.resource.volume) {
                    player.state.resource.volume.setVolume(currentVolume);
                }
                
                saveQueue();
                await interaction.reply(`🔊 Volumen cambiado a ${volume}%`);
                
                if (controlMessage && controlMessage.channel) {
                    showMusicControls(controlMessage.channel).catch(console.error);
                }
                break;
                
            case 'skip':
                const skipCount = interaction.options.getInteger('cantidad') || 1;
                
                if (!currentSong && queue.length === 0) {
                    return interaction.reply({ content: '❌ No hay música para saltar', flags: MessageFlags.Ephemeral });
                }
                
                if (skipCount > queue.length + (currentSong ? 1 : 0)) {
                    return interaction.reply({ content: `❌ Solo hay ${queue.length + (currentSong ? 1 : 0)} canción(es) disponible(s)`, flags: MessageFlags.Ephemeral });
                }
                
                if (currentSong && skipCount >= 1) {
                    if (player) player.stop();
                }
                
                const additionalSkips = Math.max(0, skipCount - 1);
                for (let i = 0; i < additionalSkips && queue.length > 0; i++) {
                    queue.shift();
                }
                
                if (additionalSkips > 0) saveQueue();
                
                await interaction.reply(`⏭️ Saltando ${skipCount} canción(es)`);
                break;
                
            case 'queue':
                await showQueuePaginated(interaction, 0);
                break;
                
            case 'favorites':
                const action = interaction.options.getString('accion');
                
                if (action === 'list') {
                    const userFavs = getUserFavorites(interaction.user.id);
                    if (userFavs.length === 0) {
                        return interaction.reply({ content: '⭐ No tienes favoritos guardados', flags: MessageFlags.Ephemeral });
                    }
                    
                    const favsList = userFavs.slice(0, 10).map((fav, index) => {
                        const duration = fav.duration ? ` \`[${fav.duration}]\`` : ' `[--:--]`';
                        return `${index + 1}. ${normalizeUTF8(fav.title)}${duration}`;
                    }).join('\n');
                    
                    const favsEmbed = {
                        title: '⭐ Tus Favoritos',
                        description: favsList,
                        color: 0xFFD700,
                        footer: { text: `Total: ${userFavs.length} favoritos` }
                    };
                    
                    await interaction.reply({ embeds: [favsEmbed], flags: MessageFlags.Ephemeral });
                    
                } else if (action === 'add') {
                    if (!currentSong) {
                        return interaction.reply({ content: '❌ No hay música reproduciéndose', flags: MessageFlags.Ephemeral });
                    }
                    
                    const added = addFavorite(interaction.user.id, currentSong);
                    if (added) {
                        await interaction.reply(`⭐ **${normalizeUTF8(currentSong.title)}** añadida a tus favoritos`);
                    } else {
                        await interaction.reply({ content: '❌ Esta canción ya está en tus favoritos', flags: MessageFlags.Ephemeral });
                    }
                    
                } else if (action === 'clear') {
                    const favorites = loadFavorites();
                    const userFavCount = favorites[interaction.user.id]?.length || 0;
                    
                    if (userFavCount === 0) {
                        return interaction.reply({ content: '❌ No tienes favoritos para limpiar', flags: MessageFlags.Ephemeral });
                    }
                    
                    favorites[interaction.user.id] = [];
                    saveFavorites(favorites);
                    await interaction.reply(`🗑️ Se limpiaron ${userFavCount} favorito(s)`);
                }
                break;
                
            case 'seek':
                if (!currentSong) {
                    return interaction.reply({ content: '❌ No hay música reproduciéndose', flags: MessageFlags.Ephemeral });
                }
                
                if (!voiceChannel) {
                    return interaction.reply({ content: 'Debes estar en un canal de voz', flags: MessageFlags.Ephemeral });
                }
                
                const timeArg = interaction.options.getString('tiempo');
                let targetSeconds = 0;
                
                if (timeArg.startsWith('+')) {
                    targetSeconds = currentSeekPosition + parseTimeToSeconds(timeArg.substring(1));
                } else if (timeArg.startsWith('-')) {
                    targetSeconds = Math.max(0, currentSeekPosition - parseTimeToSeconds(timeArg.substring(1)));
                } else {
                    targetSeconds = parseTimeToSeconds(timeArg);
                }
                
                if (targetSeconds < 0) targetSeconds = 0;
                
                await interaction.deferReply();
                const result = await seekToPosition(targetSeconds, currentSong, voiceChannel);
                
                if (result.success) {
                    await interaction.editReply(`⏩ Posición cambiada a: **${result.position}**`);
                } else {
                    await interaction.editReply(`❌ Error: ${result.error}`);
                }
                break;
        }
        return;
    }
    
    if (!interaction.isButton() && !interaction.isStringSelectMenu()) return;

    const voiceChannel = interaction.member.voice.channel;
    if (!voiceChannel) return interaction.reply({ content: 'Entra a un canal de voz primero.', flags: MessageFlags.Ephemeral });

    try {
        // Manejo de menú desplegable de sugerencias de IA
        if (interaction.isStringSelectMenu() && interaction.customId === 'ai_suggestions') {
            const selectedIndex = parseInt(interaction.values[0].split('_')[1]);
            const message = interaction.message;
            
            if (message.suggestions && message.suggestions[selectedIndex]) {
                const suggestion = message.suggestions[selectedIndex];
                
                await interaction.deferReply({ flags: MessageFlags.Ephemeral });
                
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
                            
                            // Actualizar el menú para marcar como añadida
                            const updatedEmbed = { ...message.embeds[0] };
                            updatedEmbed.description = updatedEmbed.description + `\n\n✅ **${suggestion}** añadida a la cola`;
                            await message.edit({ embeds: [updatedEmbed], components: message.components });
                            
                        } catch (addError) {
                            await interaction.editReply('❌ Error añadiendo la canción a la cola.');
                        }
                    } else {
                        await interaction.editReply('❌ No se encontró la canción sugerida.');
                    }
                });
            } else {
                await interaction.reply({ content: 'Error: No se pudo encontrar la sugerencia seleccionada.', flags: MessageFlags.Ephemeral });
            }
            return;
        }

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
                if (!player) return interaction.reply({ content: 'No hay música en reproducción.', flags: MessageFlags.Ephemeral });
                
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
                    return interaction.reply({ content: 'Necesitas al menos 2 canciones para mezclar.', flags: MessageFlags.Ephemeral });
                }
                shuffleQueue(queue);
                await interaction.reply('🔀 Cola mezclada');
                break;

            case 'stop':
                if (player) player.stop();
                queue = [];
                originalPlaylist = []; // Limpiar playlist original
                isRepeatMode = false; // Desactivar repeat al detener
                isLoopingSong = false; // Desactivar loop al detener
                currentSong = null;
                isProcessing = false; // Resetear el estado de procesamiento
                processes.forEach(child => child.kill());
                processes.clear();
                
                // Guardar estado vacío
                saveQueue();
                
                // Limpiar archivos temporales al detener
                cleanupAllTempFiles();
                
                if (connection) {
                    connection.destroy();
                    connection = null;
                }
                
                if (controlMessage) {
                    await controlMessage.edit({ components: [] });
                    controlMessage = null;
                }
                
                await interaction.reply('⏹ Música detenida, cola limpiada, repeat desactivado y archivos temporales eliminados');
                break;

            case 'nowplaying':
                if (currentSong) {
                    const title = normalizeUTF8(currentSong.title);
                    await interaction.reply(`🎶 Reproduciendo ahora: **${title}**`);
                } else {
                    await interaction.reply('No hay música en reproducción.');
                }
                break;

            case 'repeat_toggle':
                isRepeatMode = !isRepeatMode;
                saveQueue(); // Guardar cambio de modo repeat
                await interaction.reply(`🔁 Modo repetir: ${isRepeatMode ? '**ACTIVADO**' : '**DESACTIVADO**'}`);
                // Actualizar los controles para reflejar el cambio
                if (controlMessage && controlMessage.channel) {
                    showMusicControls(controlMessage.channel).catch(console.error);
                }
                break;

            case 'loop_song':
                isLoopingSong = !isLoopingSong;
                saveQueue(); // Guardar cambio de modo loop
                await interaction.reply(`🔂 Loop individual: ${isLoopingSong ? '**ACTIVADO**' : '**DESACTIVADO**'}`);
                // Actualizar los controles para reflejar el cambio
                if (controlMessage && controlMessage.channel) {
                    showMusicControls(controlMessage.channel).catch(console.error);
                }
                break;

            case 'ai_suggest':
                if (!currentSong) {
                    return interaction.reply({ content: 'No hay música reproduciéndose para generar sugerencias.', flags: MessageFlags.Ephemeral });
                }
                await interaction.deferReply({ flags: MessageFlags.Ephemeral });
                await showAISuggestions(interaction.channel, currentSong.title);
                await interaction.editReply('🤖 ¡Sugerencias generadas! Revisa el canal para ver las opciones.');
                break;

            case 'volume_up':
                if (currentVolume < 1.0) {
                    currentVolume = Math.min(1.0, currentVolume + 0.1);
                    if (player && player.state.resource && player.state.resource.volume) {
                        player.state.resource.volume.setVolume(currentVolume);
                    }
                    saveQueue(); // Guardar cambio de volumen
                    await interaction.reply(`🔊 Volumen aumentado a ${Math.round(currentVolume * 100)}%`);
                    // Actualizar controles para mostrar nuevo volumen
                    if (controlMessage && controlMessage.channel) {
                        showMusicControls(controlMessage.channel).catch(console.error);
                    }
                } else {
                    await interaction.reply({ content: 'El volumen ya está al máximo (100%)', flags: MessageFlags.Ephemeral });
                }
                break;

            case 'volume_down':
                if (currentVolume > 0.1) {
                    currentVolume = Math.max(0.1, currentVolume - 0.1);
                    if (player && player.state.resource && player.state.resource.volume) {
                        player.state.resource.volume.setVolume(currentVolume);
                    }
                    saveQueue(); // Guardar cambio de volumen
                    await interaction.reply(`🔉 Volumen reducido a ${Math.round(currentVolume * 100)}%`);
                    // Actualizar controles para mostrar nuevo volumen
                    if (controlMessage && controlMessage.channel) {
                        showMusicControls(controlMessage.channel).catch(console.error);
                    }
                } else {
                    await interaction.reply({ content: 'El volumen ya está al mínimo (10%)', flags: MessageFlags.Ephemeral });
                }
                break;

            case 'add_favorite':
                if (!currentSong) {
                    return interaction.reply({ content: '❌ No hay música reproduciéndose para añadir a favoritos', flags: MessageFlags.Ephemeral });
                }
                
                const added = addFavorite(interaction.user.id, currentSong);
                if (added) {
                    await interaction.reply(`⭐ **${normalizeUTF8(currentSong.title)}** añadida a tus favoritos`);
                } else {
                    await interaction.reply({ content: '❌ Esta canción ya está en tus favoritos', flags: MessageFlags.Ephemeral });
                }
                break;

            case 'show_queue':
                if (queue.length === 0) {
                    return interaction.reply({ content: 'La cola está vacía.', flags: MessageFlags.Ephemeral });
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

                await interaction.reply({ embeds: [queueEmbed], flags: MessageFlags.Ephemeral });
                break;

            default:
                // Manejo de botones de paginación de cola
                if (interaction.customId.startsWith('queue_prev_')) {
                    const currentPage = parseInt(interaction.customId.split('_')[2]);
                    const newPage = Math.max(0, currentPage - 1);
                    await showQueuePaginated(interaction, newPage);
                    return;
                }
                
                if (interaction.customId.startsWith('queue_next_')) {
                    const currentPage = parseInt(interaction.customId.split('_')[2]);
                    const newPage = currentPage + 1;
                    await showQueuePaginated(interaction, newPage);
                    return;
                }
                
                if (interaction.customId.startsWith('queue_msg_prev_')) {
                    const currentPage = parseInt(interaction.customId.split('_')[3]);
                    const newPage = Math.max(0, currentPage - 1);
                    await interaction.message.edit({ embeds: [], components: [] });
                    await showQueueMessage(interaction.channel, newPage);
                    await interaction.deferUpdate();
                    return;
                }
                
                if (interaction.customId.startsWith('queue_msg_next_')) {
                    const currentPage = parseInt(interaction.customId.split('_')[3]);
                    const newPage = currentPage + 1;
                    await interaction.message.edit({ embeds: [], components: [] });
                    await showQueueMessage(interaction.channel, newPage);
                    await interaction.deferUpdate();
                    return;
                }
                
                if (interaction.customId === 'queue_close' || interaction.customId === 'queue_msg_close') {
                    await interaction.message.delete().catch(() => {});
                    return;
                }
                
                // Manejo de IDs de interacción no reconocidos
                await interaction.reply({ content: 'Interacción no reconocida.', flags: MessageFlags.Ephemeral });
                break;
        }
    } catch (error) {
        logger.error(`Error en interacción: ${error.message}`);
        if (!interaction.replied && !interaction.deferred) {
            await interaction.reply({ content: 'Ocurrió un error procesando tu solicitud.', flags: MessageFlags.Ephemeral });
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

        // Si hay canciones en la cola restaurada pero no hay reproducción activa, reanudar
        if (!isProcessing && queue.length > 0 && !currentSong) {
            // Restaurar información de member y channel en las canciones de la cola
            queue.forEach(song => {
                song.member = message.member;
                song.channel = message.channel;
            });
            message.channel.send('🔄 **Reanudando cola guardada...**');
            playNextInQueue(voiceChannel);
            return;
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
                                const songData = { 
                                    url: videoUrl, 
                                    title: title,
                                    shouldStream: false, // Se determinará cuando se procese
                                    member: message.member, 
                                    channel: message.channel 
                                };
                                
                                queue.push(songData);
                                
                                // También añadir a la playlist original para repeat
                                if (!originalPlaylist.some(song => song.url === videoUrl)) {
                                    originalPlaylist.push({...songData});
                                }
                                
                                songsAdded++;
                            }
                        }
                    }

                    if (songsAdded > 0) {
                        playlistMessage.edit(`✅ Se añadieron ${songsAdded} canciones a la cola.`);
                        saveQueue(); // Guardar después de añadir playlist
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
        await showQueueMessage(message.channel, 0);
    } else if (command === 'suggest') {
        const songQuery = args.join(' ');
        
        if (!songQuery && !currentSong) {
            return message.channel.send('❌ Proporciona el nombre de una canción o reproduce algo para obtener sugerencias.\nEjemplo: `!suggest Bohemian Rhapsody`');
        }
        
        const songTitle = songQuery || currentSong.title;
        await showAISuggestions(message.channel, songTitle);
    } else if (command === 'volume' || command === 'vol') {
        const volume = parseInt(args[0]);
        
        if (!volume || isNaN(volume)) {
            return message.channel.send(`🔊 Volumen actual: ${Math.round(currentVolume * 100)}%\nUso: \`!volume <1-100>\` - Ejemplo: \`!volume 75\``);
        }
        
        if (volume < 1 || volume > 100) {
            return message.channel.send('❌ El volumen debe estar entre 1 y 100');
        }
        
        if (!player || !player.state.resource) {
            return message.channel.send('❌ No hay música reproduciéndose para cambiar el volumen');
        }
        
        currentVolume = volume / 100;
        if (player.state.resource.volume) {
            player.state.resource.volume.setVolume(currentVolume);
        }
        
        saveQueue(); // Guardar cambio de volumen
        message.channel.send(`🔊 Volumen cambiado a ${volume}%`);
        
        // Actualizar controles si existen
        if (controlMessage && controlMessage.channel) {
            showMusicControls(controlMessage.channel).catch(console.error);
        }
    } else if (command === 'skip') {
        const skipCount = parseInt(args[0]) || 1;
        
        if (!currentSong && queue.length === 0) {
            return message.channel.send('❌ No hay música reproduciéndose o en cola para saltar');
        }
        
        if (skipCount < 1 || skipCount > 20) {
            return message.channel.send('❌ Puedes saltar entre 1 y 20 canciones. Uso: `!skip` o `!skip 3`');
        }
        
        if (skipCount > queue.length + (currentSong ? 1 : 0)) {
            return message.channel.send(`❌ Solo hay ${queue.length + (currentSong ? 1 : 0)} canción(es) disponible(s)`);
        }
        
        // Saltar canción actual si está reproduciéndose
        if (currentSong && skipCount >= 1) {
            if (player) {
                player.stop(); // Esto disparará el evento 'idle' que procesará la siguiente canción
            }
        }
        
        // Saltar canciones adicionales de la cola
        const additionalSkips = Math.max(0, skipCount - 1);
        for (let i = 0; i < additionalSkips && queue.length > 0; i++) {
            queue.shift();
        }
        
        if (additionalSkips > 0) {
            saveQueue();
        }
        
        message.channel.send(`⏭️ Saltando ${skipCount} canción(es)`);
    } else if (command === 'remove' || command === 'rm') {
        const position = parseInt(args[0]);
        
        if (!position || isNaN(position)) {
            return message.channel.send('❌ Debes especificar una posición válida. Uso: `!remove 2` (quita la canción #2 de la cola)');
        }
        
        if (queue.length === 0) {
            return message.channel.send('❌ La cola está vacía');
        }
        
        if (position < 1 || position > queue.length) {
            return message.channel.send(`❌ Posición inválida. La cola tiene ${queue.length} canción(es). Usa números del 1 al ${queue.length}`);
        }
        
        // Remover canción (posición - 1 porque el array es 0-indexed)
        const removedSong = queue.splice(position - 1, 1)[0];
        
        // También remover de la playlist original si existe
        const originalIndex = originalPlaylist.findIndex(song => song.url === removedSong.url);
        if (originalIndex !== -1) {
            originalPlaylist.splice(originalIndex, 1);
        }
        
        saveQueue();
        
        const removedTitle = normalizeUTF8(removedSong.title);
        message.channel.send(`🗑️ Canción removida: **${removedTitle}** (posición ${position})`);
    } else if (command === 'move' || command === 'mv') {
        const fromPos = parseInt(args[0]);
        const toPos = parseInt(args[1]);
        
        if (!fromPos || !toPos || isNaN(fromPos) || isNaN(toPos)) {
            return message.channel.send('❌ Debes especificar dos posiciones válidas. Uso: `!move 3 1` (mueve canción de posición 3 a posición 1)');
        }
        
        if (queue.length === 0) {
            return message.channel.send('❌ La cola está vacía');
        }
        
        if (fromPos < 1 || fromPos > queue.length || toPos < 1 || toPos > queue.length) {
            return message.channel.send(`❌ Posiciones inválidas. La cola tiene ${queue.length} canción(es). Usa números del 1 al ${queue.length}`);
        }
        
        if (fromPos === toPos) {
            return message.channel.send('❌ Las posiciones origen y destino son las mismas');
        }
        
        // Mover canción (convertir a índices 0-based)
        const songToMove = queue.splice(fromPos - 1, 1)[0];
        queue.splice(toPos - 1, 0, songToMove);
        
        saveQueue();
        
        const movedTitle = normalizeUTF8(songToMove.title);
        message.channel.send(`🔀 Canción movida: **${movedTitle}** de posición ${fromPos} → ${toPos}`);
    } else if (command === 'favorites' || command === 'fav') {
        const subCommand = args[0]?.toLowerCase();
        
        if (!subCommand) {
            // Mostrar lista de favoritos
            const userFavs = getUserFavorites(message.author.id);
            if (userFavs.length === 0) {
                return message.channel.send('⭐ No tienes favoritos guardados. Usa `!fav add` mientras reproduce música para añadir favoritos.');
            }
            
            const favsList = userFavs.slice(0, 10).map((fav, index) => {
                const duration = fav.duration ? ` \`[${fav.duration}]\`` : ' `[--:--]`';
                return `${index + 1}. ${normalizeUTF8(fav.title)}${duration}`;
            }).join('\n');
            
            const favsEmbed = {
                title: '⭐ Tus Favoritos',
                description: favsList + (userFavs.length > 10 ? `\n... y ${userFavs.length - 10} más` : ''),
                color: 0xFFD700,
                footer: { text: `Total: ${userFavs.length} favoritos | Usa !fav play <número> para reproducir` }
            };
            
            message.channel.send({ embeds: [favsEmbed] });
            
        } else if (subCommand === 'add') {
            // Añadir canción actual a favoritos
            if (!currentSong) {
                return message.channel.send('❌ No hay música reproduciéndose para añadir a favoritos');
            }
            
            const added = addFavorite(message.author.id, currentSong);
            if (added) {
                message.channel.send(`⭐ **${normalizeUTF8(currentSong.title)}** añadida a tus favoritos`);
            } else {
                message.channel.send('❌ Esta canción ya está en tus favoritos');
            }
            
        } else if (subCommand === 'play') {
            // Reproducir favorito específico
            const position = parseInt(args[1]);
            if (!position || isNaN(position)) {
                return message.channel.send('❌ Especifica qué favorito reproducir. Uso: `!fav play 2`');
            }
            
            const userFavs = getUserFavorites(message.author.id);
            if (position < 1 || position > userFavs.length) {
                return message.channel.send(`❌ Posición inválida. Tienes ${userFavs.length} favorito(s). Usa números del 1 al ${userFavs.length}`);
            }
            
            const voiceChannel = message.member.voice.channel;
            if (!voiceChannel) {
                return message.channel.send('Debes estar en un canal de voz para reproducir música.');
            }
            
            const favorite = userFavs[position - 1];
            await addSongToQueue(favorite.url, message.member, message.channel, voiceChannel);
            
        } else if (subCommand === 'remove' || subCommand === 'rm') {
            // Remover favorito
            const position = parseInt(args[1]);
            if (!position || isNaN(position)) {
                return message.channel.send('❌ Especifica qué favorito remover. Uso: `!fav remove 2`');
            }
            
            const removed = removeFavorite(message.author.id, position);
            if (removed) {
                message.channel.send(`🗑️ Favorito removido: **${normalizeUTF8(removed.title)}**`);
            } else {
                const userFavs = getUserFavorites(message.author.id);
                message.channel.send(`❌ Posición inválida. Tienes ${userFavs.length} favorito(s).`);
            }
            
        } else if (subCommand === 'clear') {
            // Limpiar todos los favoritos
            const favorites = loadFavorites();
            const userFavCount = favorites[message.author.id]?.length || 0;
            
            if (userFavCount === 0) {
                return message.channel.send('❌ No tienes favoritos para limpiar');
            }
            
            favorites[message.author.id] = [];
            saveFavorites(favorites);
            message.channel.send(`🗑️ Se limpiaron ${userFavCount} favorito(s)`);
            
        } else {
            message.channel.send('❌ Comando inválido. Usa:\n`!fav` - Ver favoritos\n`!fav add` - Añadir actual\n`!fav play <#>` - Reproducir favorito\n`!fav remove <#>` - Remover favorito\n`!fav clear` - Limpiar todos');
        }
    } else if (command === 'seek') {
        if (!currentSong) {
            return message.channel.send('❌ No hay música reproduciéndose');
        }
        
        const timeArg = args[0];
        if (!timeArg) {
            return message.channel.send('❌ Especifica una posición. Ejemplos:\n`!seek 1:30` - Ir al minuto 1:30\n`!seek 45` - Ir al segundo 45\n`!seek +30` - Adelantar 30 segundos\n`!seek -15` - Retroceder 15 segundos');
        }
        
        const voiceChannel = message.member.voice.channel;
        if (!voiceChannel) {
            return message.channel.send('Debes estar en un canal de voz.');
        }
        
        let targetSeconds = 0;
        
        // Parsear diferentes formatos
        if (timeArg.startsWith('+')) {
            // Adelantar relativo
            targetSeconds = currentSeekPosition + parseTimeToSeconds(timeArg.substring(1));
        } else if (timeArg.startsWith('-')) {
            // Retroceder relativo
            targetSeconds = Math.max(0, currentSeekPosition - parseTimeToSeconds(timeArg.substring(1)));
        } else {
            // Posición absoluta
            targetSeconds = parseTimeToSeconds(timeArg);
        }
        
        // Validar que no sea negativo
        if (targetSeconds < 0) targetSeconds = 0;
        
        // Intentar hacer seek
        const result = await seekToPosition(targetSeconds, currentSong, voiceChannel);
        
        if (result.success) {
            message.channel.send(`⏩ Posición cambiada a: **${result.position}**`);
        } else {
            message.channel.send(`❌ Error: ${result.error}`);
        }
    } else if (command === 'bass') {
        const bassLevel = parseInt(args[0]);
        
        if (isNaN(bassLevel) || bassLevel < -10 || bassLevel > 10) {
            return message.channel.send('❌ El nivel de bass debe estar entre -10 y +10. Ejemplo: `!bass 5`');
        }
        
        audioFilters.bass = bassLevel;
        audioFilters.preset = null; // Limpiar preset si se cambia manualmente
        
        message.channel.send(`🔊 Bass ajustado a: **${bassLevel > 0 ? '+' : ''}${bassLevel}dB**\n⚠️ Los cambios se aplicarán en la siguiente canción descargada`);
        
    } else if (command === 'treble') {
        const trebleLevel = parseInt(args[0]);
        
        if (isNaN(trebleLevel) || trebleLevel < -10 || trebleLevel > 10) {
            return message.channel.send('❌ El nivel de treble debe estar entre -10 y +10. Ejemplo: `!treble 3`');
        }
        
        audioFilters.treble = trebleLevel;
        audioFilters.preset = null; // Limpiar preset si se cambia manualmente
        
        message.channel.send(`🔊 Treble ajustado a: **${trebleLevel > 0 ? '+' : ''}${trebleLevel}dB**\n⚠️ Los cambios se aplicarán en la siguiente canción descargada`);
        
    } else if (command === 'speed') {
        const speedLevel = parseFloat(args[0]);
        
        if (isNaN(speedLevel) || speedLevel < 0.5 || speedLevel > 2.0) {
            return message.channel.send('❌ La velocidad debe estar entre 0.5 y 2.0. Ejemplo: `!speed 1.25`');
        }
        
        audioFilters.speed = speedLevel;
        audioFilters.preset = null; // Limpiar preset si se cambia manualmente
        
        message.channel.send(`⚡ Velocidad ajustada a: **${speedLevel}x**\n⚠️ Los cambios se aplicarán en la siguiente canción descargada`);
        
    } else if (command === 'preset') {
        const presetName = args[0]?.toLowerCase();
        
        if (!presetName) {
            const presetList = Object.keys(EQUALIZER_PRESETS).join(', ');
            return message.channel.send(`🎚️ Presets disponibles: **${presetList}**\nEjemplo: \`!preset rock\``);
        }
        
        if (!EQUALIZER_PRESETS[presetName]) {
            const presetList = Object.keys(EQUALIZER_PRESETS).join(', ');
            return message.channel.send(`❌ Preset no válido. Disponibles: **${presetList}**`);
        }
        
        // Aplicar preset
        const preset = EQUALIZER_PRESETS[presetName];
        audioFilters.bass = preset.bass;
        audioFilters.treble = preset.treble;
        audioFilters.speed = preset.speed;
        audioFilters.preset = presetName;
        
        const settings = `Bass: ${preset.bass > 0 ? '+' : ''}${preset.bass}dB, Treble: ${preset.treble > 0 ? '+' : ''}${preset.treble}dB, Speed: ${preset.speed}x`;
        message.channel.send(`🎚️ Preset **${presetName}** aplicado\n📊 ${settings}\n⚠️ Los cambios se aplicarán en la siguiente canción descargada`);
        
    } else if (command === 'equalizer' || command === 'eq') {
        // Mostrar estado actual del ecualizador
        const currentSettings = `🎚️ **Estado del Ecualizador:**\n` +
                              `🔊 Bass: ${audioFilters.bass > 0 ? '+' : ''}${audioFilters.bass}dB\n` +
                              `🔊 Treble: ${audioFilters.treble > 0 ? '+' : ''}${audioFilters.treble}dB\n` +
                              `⚡ Velocidad: ${audioFilters.speed}x\n` +
                              `🎵 Preset: ${audioFilters.preset || 'Ninguno'}\n\n` +
                              `**Comandos disponibles:**\n` +
                              `\`!bass <-10 a +10>\` - Ajustar graves\n` +
                              `\`!treble <-10 a +10>\` - Ajustar agudos\n` +
                              `\`!speed <0.5 a 2.0>\` - Cambiar velocidad\n` +
                              `\`!preset <nombre>\` - Aplicar preset\n\n` +
                              `⚠️ **Nota:** Solo funciona con canciones descargadas (📥), no con streaming (🌐)`;
        
        message.channel.send(currentSettings);
    }
});

// Función para registrar slash commands
async function registerSlashCommands() {
    const commands = [
        {
            name: 'play',
            description: 'Reproduce música desde YouTube',
            options: [
                {
                    name: 'cancion',
                    description: 'URL de YouTube o nombre de canción a buscar',
                    type: 3, // STRING
                    required: true
                }
            ]
        },
        {
            name: 'volume',
            description: 'Cambiar volumen de reproducción',
            options: [
                {
                    name: 'nivel',
                    description: 'Nivel de volumen (1-100)',
                    type: 4, // INTEGER
                    required: true,
                    min_value: 1,
                    max_value: 100
                }
            ]
        },
        {
            name: 'skip',
            description: 'Saltar canciones',
            options: [
                {
                    name: 'cantidad',
                    description: 'Número de canciones a saltar (1-20)',
                    type: 4, // INTEGER
                    required: false,
                    min_value: 1,
                    max_value: 20
                }
            ]
        },
        {
            name: 'queue',
            description: 'Mostrar cola de reproducción'
        },
        {
            name: 'favorites',
            description: 'Gestionar favoritos',
            options: [
                {
                    name: 'accion',
                    description: 'Acción a realizar',
                    type: 3, // STRING
                    required: true,
                    choices: [
                        { name: 'Ver favoritos', value: 'list' },
                        { name: 'Añadir actual', value: 'add' },
                        { name: 'Limpiar todos', value: 'clear' }
                    ]
                }
            ]
        },
        {
            name: 'seek',
            description: 'Navegar a posición específica',
            options: [
                {
                    name: 'tiempo',
                    description: 'Posición (ej: 1:30, 45, +30, -15)',
                    type: 3, // STRING
                    required: true
                }
            ]
        }
    ];

    try {
        logger.info('🔄 Registrando slash commands...');
        await client.application.commands.set(commands);
        logger.info('✅ Slash commands registrados correctamente');
    } catch (error) {
        logger.error(`❌ Error registrando slash commands: ${error.message}`);
    }
}

// Evento cuando el bot se conecta
client.on('clientReady', async () => {
    clearTimeout(connectionTimeout);
    logger.info(`✅ Bot conectado como ${client.user.tag}`);
    logger.info('🎵 Bot de música optimizado listo para usar!');
    
    // Limpiar archivos temporales al iniciar
    cleanupAllTempFiles();
    
    // Cargar cola guardada
    loadQueue();
    
    // Registrar slash commands
    await registerSlashCommands();
    
    const aiStatus = model ? ' con IA 🤖' : '';
    client.user.setActivity(`🎵 Música${aiStatus} | !play o /play para empezar`, { type: 'LISTENING' });
});

// Manejo de cierre limpio
process.on('SIGINT', () => {
    logger.info('Apagando bot...');
    
    // Limpiar procesos
    processes.forEach(child => {
        try {
            child.kill('SIGTERM');
        } catch (error) {
            logger.warn(`Error terminando proceso: ${error.message}`);
        }
    });
    
    // Limpiar conexiones
    if (connection) {
        try {
            connection.destroy();
        } catch (error) {
            logger.warn(`Error cerrando conexión: ${error.message}`);
        }
    }
    
    // Limpiar cache
    metadataCache.clear();
    
    // Limpiar archivos temporales
    cleanupAllTempFiles();
    
    client.destroy();
    process.exit(0);
});

// Manejo adicional para SIGTERM (para contenedores/servicios)
process.on('SIGTERM', () => {
    logger.info('Recibido SIGTERM, cerrando bot...');
    process.emit('SIGINT');
});

// Funciones auxiliares para limpiar y validar URLs

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

// Función para limpiar todos los archivos temporales
function cleanupAllTempFiles() {
    try {
        const files = fs.readdirSync('./');
        const tempFiles = files.filter(file => file.startsWith('temp_audio_'));
        
        if (tempFiles.length > 0) {
            logger.info(`🧹 Limpiando ${tempFiles.length} archivo(s) temporal(es)...`);
            tempFiles.forEach(file => {
                try {
                    fs.unlinkSync(`./${file}`);
                    logger.info(`🗑️ Archivo temporal eliminado: ${file}`);
                } catch (error) {
                    logger.error(`Error eliminando ${file}: ${error.message}`);
                }
            });
            logger.info(`✅ Limpieza completada: ${tempFiles.length} archivo(s) eliminado(s)`);
        } else {
            logger.info(`✅ No hay archivos temporales para limpiar`);
        }
    } catch (error) {
        logger.error(`Error durante la limpieza: ${error.message}`);
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
