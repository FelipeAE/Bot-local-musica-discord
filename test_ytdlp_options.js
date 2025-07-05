const { spawn } = require('child_process');

// Probar diferentes combinaciones de argumentos para encontrar las opciones compatibles
const testConfigs = [
    {
        name: 'Básico',
        args: ['-f', 'bestaudio/best', '--no-warnings', '--no-playlist', '--simulate']
    },
    {
        name: 'Con retries',
        args: ['-f', 'bestaudio/best', '--no-warnings', '--no-playlist', '--retries', '3', '--simulate']
    },
    {
        name: 'Con fragment-retries',
        args: ['-f', 'bestaudio/best', '--no-warnings', '--no-playlist', '--fragment-retries', '3', '--simulate']
    },
    {
        name: 'Con socket-timeout',
        args: ['-f', 'bestaudio/best', '--no-warnings', '--no-playlist', '--socket-timeout', '30', '--simulate']
    },
    {
        name: 'Con no-continue',
        args: ['-f', 'bestaudio/best', '--no-warnings', '--no-playlist', '--no-continue', '--simulate']
    },
    {
        name: 'Combinado básico',
        args: ['-f', 'bestaudio/best', '--no-warnings', '--no-playlist', '--retries', '3', '--fragment-retries', '3', '--simulate']
    },
    {
        name: 'Combinado avanzado',
        args: ['-f', 'bestaudio/best', '--no-warnings', '--no-playlist', '--retries', '10', '--fragment-retries', '10', '--socket-timeout', '60', '--simulate']
    }
];

const testUrl = 'https://www.youtube.com/watch?v=dQw4w9WgXcQ';

async function testConfig(config) {
    return new Promise((resolve) => {
        console.log(`\n🧪 Probando configuración: ${config.name}`);
        console.log(`📋 Comando: yt-dlp ${config.args.join(' ')} "${testUrl}"`);
        
        const args = [...config.args, testUrl];
        const child = spawn('yt-dlp', args);
        
        let stderr = '';
        let stdout = '';
        
        child.stdout.on('data', (data) => {
            stdout += data.toString();
        });
        
        child.stderr.on('data', (data) => {
            stderr += data.toString();
        });
        
        child.on('close', (code) => {
            if (code === 0) {
                console.log(`✅ ÉXITO: Configuración "${config.name}" funciona correctamente`);
                resolve({ success: true, config });
            } else {
                console.log(`❌ ERROR: Configuración "${config.name}" falló con código ${code}`);
                if (stderr.includes('no such option')) {
                    const match = stderr.match(/no such option: (--[\w-]+)/);
                    if (match) {
                        console.log(`⚠️  Opción no válida: ${match[1]}`);
                    }
                }
                resolve({ success: false, config, error: stderr });
            }
        });
        
        child.on('error', (error) => {
            console.log(`❌ ERROR DE SPAWN: ${error.message}`);
            resolve({ success: false, config, error: error.message });
        });
    });
}

async function runTests() {
    console.log('🚀 Iniciando pruebas de compatibilidad de yt-dlp...\n');
    
    const results = [];
    
    for (const config of testConfigs) {
        const result = await testConfig(config);
        results.push(result);
        
        // Pausa entre pruebas para evitar rate limiting
        await new Promise(resolve => setTimeout(resolve, 1000));
    }
    
    console.log('\n📊 RESUMEN DE RESULTADOS:\n');
    
    const successful = results.filter(r => r.success);
    const failed = results.filter(r => !r.success);
    
    console.log(`✅ Configuraciones exitosas: ${successful.length}`);
    successful.forEach(r => {
        console.log(`  - ${r.config.name}`);
    });
    
    console.log(`\n❌ Configuraciones fallidas: ${failed.length}`);
    failed.forEach(r => {
        console.log(`  - ${r.config.name}`);
    });
    
    if (successful.length > 0) {
        console.log('\n🏆 CONFIGURACIÓN RECOMENDADA (más completa que funciona):');
        const best = successful[successful.length - 1]; // La última exitosa suele ser la más completa
        console.log(`Nombre: ${best.config.name}`);
        console.log(`Argumentos: ${best.config.args.filter(arg => arg !== '--simulate').join(' ')}`);
    }
}

runTests().catch(console.error);
