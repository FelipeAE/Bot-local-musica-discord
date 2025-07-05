const { exec } = require('child_process');

// Tu URL de playlist
const playlistUrl = "https://www.youtube.com/watch?v=SYTS2sJWcIs&list=PLZ0CBSZb0p0ZxmS4x96YeuetEyekhI5oD&pp=0gcJCV8EOCosWNin";

console.log('🔗 URL original:', playlistUrl);
console.log('🔍 Contiene list=?', playlistUrl.includes('list='));

// Función de limpieza (copiada del bot)
function cleanYouTubeUrl(url) {
    try {
        const urlObj = new URL(url);
        
        if (urlObj.hostname.includes('youtube.com')) {
            // Para playlists, mantener list y v si existen
            const listId = urlObj.searchParams.get('list');
            const videoId = urlObj.searchParams.get('v');
            
            if (listId) {
                let cleanUrl = `https://www.youtube.com/playlist?list=${listId}`;
                if (videoId) {
                    cleanUrl = `https://www.youtube.com/watch?v=${videoId}&list=${listId}`;
                }
                return cleanUrl;
            }
            
            // Para videos individuales
            if (videoId) {
                return `https://www.youtube.com/watch?v=${videoId}`;
            }
        }
        
        return url;
    } catch (error) {
        console.error(`Error limpiando URL: ${error.message}`);
        return url;
    }
}

const cleanedUrl = cleanYouTubeUrl(playlistUrl);
console.log('🧹 URL limpia:', cleanedUrl);

// Probar comando yt-dlp
console.log('\n🎵 Probando yt-dlp con playlist...');
const command = `yt-dlp -j --flat-playlist --no-warnings "${cleanedUrl}"`;
console.log('📝 Comando:', command);

exec(command, { maxBuffer: 10 * 1024 * 1024, timeout: 30000 }, (error, stdout, stderr) => {
    if (error) {
        console.error('❌ Error:', error.message);
        return;
    }
    
    if (stderr) {
        console.warn('⚠️ Stderr:', stderr);
    }
    
    console.log('\n📊 Salida cruda:');
    console.log(stdout.substring(0, 500) + '...');
    
    try {
        const lines = stdout.trim().split('\n');
        console.log(`\n📈 Número de líneas: ${lines.length}`);
        
        const playlistData = lines.map(line => {
            try {
                return JSON.parse(line);
            } catch (e) {
                console.warn('⚠️ Error parseando línea:', line.substring(0, 100));
                return null;
            }
        }).filter(item => item !== null);
        
        console.log(`\n✅ Videos válidos encontrados: ${playlistData.length}`);
        
        playlistData.slice(0, 5).forEach((item, index) => {
            console.log(`${index + 1}. ID: ${item.id}, Título: ${item.title?.substring(0, 50)}...`);
        });
        
        if (playlistData.length > 5) {
            console.log(`... y ${playlistData.length - 5} más`);
        }
        
    } catch (parseError) {
        console.error('❌ Error al procesar respuesta:', parseError.message);
    }
    
    console.log('\n🏁 Prueba completada');
});
