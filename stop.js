const fs = require('fs');
const path = require('path');

// Ruta donde guardaremos el ID del proceso de tu bot (PID)
const pidFile = path.join(__dirname, 'bot.pid');

// Leer el archivo PID para obtener el ID del proceso
if (fs.existsSync(pidFile)) {
    const pid = parseInt(fs.readFileSync(pidFile).toString());

    try {
        process.kill(pid);  // Intentar detener el proceso con el ID encontrado
        console.log(`Proceso con PID ${pid} detenido correctamente.`);
        fs.unlinkSync(pidFile);  // Eliminar el archivo PID después de detener el proceso
    } catch (err) {
        console.error(`No se pudo detener el proceso con PID ${pid}:`, err.message);
    }
} else {
    console.log('No se encontró ningún proceso activo para detener.');
}
