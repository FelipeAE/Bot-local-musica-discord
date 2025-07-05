const fs = require('fs');
const path = require('path');

function cleanupAllPartFiles() {
    const currentDir = __dirname;
    console.log(`🧹 Limpiando archivos temporales en: ${currentDir}`);
    
    try {
        const files = fs.readdirSync(currentDir);
        const tempFiles = files.filter(file => 
            file.startsWith('temp_audio_') && 
            (file.endsWith('.part') || file.includes('.part-') || file.endsWith('.ytdl') || file.endsWith('.temp') || file.endsWith('.mp3'))
        );
        
        if (tempFiles.length === 0) {
            console.log('✅ No se encontraron archivos temporales para limpiar.');
            return;
        }
        
        console.log(`📋 Encontrados ${tempFiles.length} archivos temporales:`);
        tempFiles.forEach(file => console.log(`  - ${file}`));
        
        let cleaned = 0;
        let failed = 0;
        
        tempFiles.forEach(file => {
            const fullPath = path.join(currentDir, file);
            try {
                const stats = fs.statSync(fullPath);
                fs.unlinkSync(fullPath);
                console.log(`✅ Eliminado: ${file} (${(stats.size / 1024 / 1024).toFixed(2)} MB)`);
                cleaned++;
            } catch (error) {
                console.log(`❌ Error eliminando ${file}: ${error.message}`);
                failed++;
            }
        });
        
        console.log(`\n🎉 Limpieza completada:`);
        console.log(`  ✅ Archivos eliminados: ${cleaned}`);
        console.log(`  ❌ Errores: ${failed}`);
        
        if (cleaned > 0) {
            console.log(`\n💾 Espacio liberado: Archivos temporales eliminados`);
            console.log(`ℹ️  Estos archivos se crean durante las descargas y es seguro eliminarlos cuando el bot no está activo.`);
        }
        
    } catch (error) {
        console.error(`❌ Error durante la limpieza: ${error.message}`);
    }
}

// Ejecutar limpieza
cleanupAllPartFiles();
