// Test script para verificar delays progresivos en reintentos
const { spawn } = require('child_process');

// Función para simular el delay progresivo
function simulateRetryDelay(attemptNumber) {
    const delaySeconds = (attemptNumber - 1) * 5; // 0s, 5s, 10s
    console.log(`🔄 Reintento ${attemptNumber}/3`);
    
    if (delaySeconds > 0) {
        console.log(`⏱️ Esperando ${delaySeconds} segundos antes del reintento...`);
        return new Promise(resolve => {
            setTimeout(() => {
                console.log(`✅ Delay de ${delaySeconds}s completado`);
                resolve();
            }, delaySeconds * 1000);
        });
    }
    
    return Promise.resolve();
}

// Simular 3 reintentos con delays progresivos
async function testRetryDelays() {
    console.log('=== TEST: Delays progresivos en reintentos ===\n');
    
    for (let attempt = 1; attempt <= 3; attempt++) {
        const startTime = Date.now();
        await simulateRetryDelay(attempt);
        const endTime = Date.now();
        const actualDelay = Math.round((endTime - startTime) / 1000);
        
        console.log(`Attempt ${attempt} - Delay esperado: ${(attempt - 1) * 5}s, Delay real: ${actualDelay}s\n`);
    }
    
    console.log('✅ Test completado');
}

// Ejecutar test
testRetryDelays().catch(console.error);
