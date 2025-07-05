const { exec } = require('child_process');

function cleanYouTubeUrl(url) {
    try {
        const urlObj = new URL(url);
        
        if (urlObj.hostname === 'youtu.be') {
            const videoId = urlObj.pathname.slice(1);
            return `https://www.youtube.com/watch?v=${videoId}`;
        }
        
        if (urlObj.hostname === 'www.youtube.com' || urlObj.hostname === 'youtube.com' || urlObj.hostname === 'm.youtube.com') {
            const videoId = urlObj.searchParams.get('v');
            if (videoId) {
                return `https://www.youtube.com/watch?v=${videoId}`;
            }
        }
        
        return url;
    } catch (error) {
        console.log('Error limpiando URL:', error.message);
        return url;
    }
}

async function getVideoInfo(url) {
    return new Promise((resolve, reject) => {
        const cleanedUrl = cleanYouTubeUrl(url);
        
        exec(`yt-dlp --get-title --get-duration --print duration --no-warnings "${cleanedUrl}"`, { timeout: 15000 }, (error, stdout, stderr) => {
            if (error) {
                console.error(`Error obteniendo información del video: ${error.message}`);
                resolve({ title: 'Título no disponible', duration: 0, isLong: false });
            } else {
                const lines = stdout.trim().split('\n');
                // Corregir el orden: línea 0 = duración en segundos, línea 1 = título, línea 2 = duración formateada
                const durationSeconds = parseInt(lines[0]) || 0;
                const title = lines[1] || 'Título no disponible';
                const durationFormatted = lines[2] || '';
                
                // Determinar si es un video largo (más de 1 hora)
                const longThreshold = 3600; // 1 hora
                const isLong = durationSeconds > longThreshold;
                
                let finalTitle = title;
                if (durationFormatted) {
                    if (isLong) {
                        finalTitle = `${title} ⚠️ (${durationFormatted} - Video largo)`;
                    } else {
                        finalTitle = `${title} (${durationFormatted})`;
                    }
                }
                
                resolve({ 
                    title: finalTitle, 
                    duration: durationSeconds, 
                    isLong: isLong,
                    originalTitle: title,
                    durationFormatted: durationFormatted
                });
            }
        });
    });
}

async function testVideos() {
    const testUrls = [
        'https://www.youtube.com/watch?v=dQw4w9WgXcQ', // Rick Roll (video corto)
        'https://youtu.be/dQw4w9WgXcQ?si=example', // Rick Roll con parámetros
        'https://www.youtube.com/watch?v=jNQXAC9IVRw', // Me at the zoo (video histórico corto)
        'https://www.youtube.com/watch?v=1ZYbU82GVz4' // 10 Hours of Relaxing Music (video realmente largo)
    ];

    console.log('🧪 Probando sistema de información de videos...\n');

    for (const url of testUrls) {
        console.log(`📹 Probando: ${url}`);
        try {
            const info = await getVideoInfo(url);
            console.log(`✅ Título: ${info.originalTitle}`);
            console.log(`⏱️ Duración: ${info.durationFormatted} (${info.duration} segundos)`);
            console.log(`📏 Es largo: ${info.isLong ? 'SÍ' : 'NO'}`);
            console.log(`🏷️ Título final: ${info.title}`);
        } catch (error) {
            console.log(`❌ Error: ${error.message}`);
        }
        console.log('---');
    }
}

// Ejecutar pruebas
testVideos().catch(console.error);
