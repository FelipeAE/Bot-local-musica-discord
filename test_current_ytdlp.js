const { spawn } = require('child_process');
const path = require('path');

// Simular el comando que usa el bot actualmente
function testYtdlpCommand() {
    console.log('🧪 Probando comando actual de yt-dlp del bot...');
    
    const tempPath = path.join(__dirname, 'test_temp_audio.mp3');
    const testUrl = 'https://www.youtube.com/watch?v=dQw4w9WgXcQ'; // Rick Roll - video corto
    
    // Comandos exactos que usa el bot para videos normales
    let ytdlpArgs = [
        '-f', 'bestaudio/best',
        '--no-warnings',
        '--no-playlist',
        '-o', tempPath,
        '--retries', '3',
        '--fragment-retries', '3',
        '--socket-timeout', '30',
        testUrl
    ];
    
    console.log(`Ejecutando: yt-dlp ${ytdlpArgs.join(' ')}`);
    
    const child = spawn('yt-dlp', ytdlpArgs);
    
    child.stderr.on('data', data => {
        process.stdout.write(data.toString());
    });
    
    child.stdout.on('data', data => {
        process.stdout.write(data.toString());
    });
    
    child.on('close', (code) => {
        if (code === 0) {
            console.log('\n✅ ¡Comando ejecutado exitosamente!');
            console.log('✅ El bot debería funcionar correctamente ahora.');
        } else {
            console.log(`\n❌ Error: El comando terminó con código ${code}`);
        }
        
        // Limpiar archivo de prueba
        const fs = require('fs');
        try {
            if (fs.existsSync(tempPath)) {
                fs.unlinkSync(tempPath);
                console.log('🧹 Archivo de prueba eliminado');
            }
        } catch (error) {
            console.log('⚠️ No se pudo eliminar el archivo de prueba');
        }
    });
    
    child.on('error', (error) => {
        console.log(`❌ Error al ejecutar yt-dlp: ${error.message}`);
    });
}

testYtdlpCommand();
