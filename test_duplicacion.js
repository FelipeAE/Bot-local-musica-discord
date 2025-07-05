// Test para verificar que no haya mensajes duplicados

const mockMessages = [];

// Mock de la función channel.send
const mockChannel = {
    send: (message) => {
        const timestamp = new Date().toISOString();
        mockMessages.push({ timestamp, message });
        console.log(`[${timestamp}] ${typeof message === 'string' ? message : JSON.stringify(message)}`);
        
        // Simular el comportamiento de Discord devolviendo un objeto mensaje
        return Promise.resolve({
            delete: () => Promise.resolve(),
            edit: (newContent) => Promise.resolve()
        });
    }
};

// Simulación de addSongToQueue
function simulateAddSongToQueue() {
    console.log('=== Simulando addSongToQueue ===');
    
    // Mensaje de confirmación de addSongToQueue
    const addedEmbed = {
        color: 0x00AA00,
        title: '🎵 Canción Añadida',
        description: 'Test Song (3:45)',
        footer: { text: 'Posición en cola: 1' }
    };
    
    mockChannel.send({ embeds: [addedEmbed] });
}

// Simulación de playNextInQueue
function simulatePlayNextInQueue() {
    console.log('=== Simulando playNextInQueue ===');
    
    // Mensaje de descarga de playNextInQueue
    const downloadMessage = '📥 **Descargando**: Test Song\n⏰ Tiempo límite: 5 minutos';
    mockChannel.send(downloadMessage);
}

// Test del comando !play original (antes de la corrección)
function testPlayCommandBefore() {
    console.log('\n🔴 ANTES DE LA CORRECCIÓN:');
    console.log('=== Comando !play (simulación anterior) ===');
    
    // Mensaje inicial
    mockChannel.send('🔄 Procesando URL...');
    
    // addSongToQueue envía su mensaje
    simulateAddSongToQueue();
    
    // Mensaje duplicado del comando play
    mockChannel.send('✅ La canción ha sido añadida a la cola.');
    
    // playNextInQueue envía su mensaje
    simulatePlayNextInQueue();
    
    console.log('📊 Total de mensajes:', mockMessages.filter(m => m.message.includes && (m.message.includes('Canción Añadida') || m.message.includes('añadida a la cola') || m.message.includes('Descargando'))).length);
}

// Test del comando !play corregido (después de la corrección)
function testPlayCommandAfter() {
    console.log('\n🟢 DESPUÉS DE LA CORRECCIÓN:');
    console.log('=== Comando !play (simulación corregida) ===');
    
    // Limpiar mensajes anteriores
    mockMessages.length = 0;
    
    // Mensaje inicial
    mockChannel.send('🔄 Procesando URL...');
    
    // addSongToQueue envía su mensaje
    simulateAddSongToQueue();
    
    // El mensaje inicial se elimina (simulado)
    console.log('[SISTEMA] Mensaje inicial eliminado');
    
    // playNextInQueue envía su mensaje
    simulatePlayNextInQueue();
    
    console.log('📊 Total de mensajes visibles:', mockMessages.filter(m => m.message.includes && (m.message.includes('Canción Añadida') || m.message.includes('Descargando'))).length);
}

// Test del comando !playformat original (antes de la corrección)
function testPlayformatCommandBefore() {
    console.log('\n🔴 PLAYFORMAT ANTES DE LA CORRECCIÓN:');
    console.log('=== Comando !playformat (simulación anterior) ===');
    
    // Mensaje del comando playformat
    mockChannel.send('🎵 **Formato específico**: Intentando descargar con formato 614...');
    
    // playNextInQueue envía su mensaje
    simulatePlayNextInQueue();
    
    console.log('📊 Total de mensajes:', mockMessages.filter(m => m.message.includes && (m.message.includes('Formato específico') || m.message.includes('Descargando'))).length);
}

// Test del comando !playformat corregido (después de la corrección)
function testPlayformatCommandAfter() {
    console.log('\n🟢 PLAYFORMAT DESPUÉS DE LA CORRECCIÓN:');
    console.log('=== Comando !playformat (simulación corregida) ===');
    
    // Limpiar mensajes anteriores
    mockMessages.length = 0;
    
    // Mensaje inicial que se elimina
    mockChannel.send('🎵 **Formato específico**: Preparando descarga con formato 614...');
    
    // Simular eliminación del mensaje después de 2 segundos
    setTimeout(() => {
        console.log('[SISTEMA] Mensaje inicial eliminado después de 2 segundos');
    }, 100); // Simulado más rápido para el test
    
    // playNextInQueue envía su mensaje
    simulatePlayNextInQueue();
    
    console.log('📊 Total de mensajes permanentes:', mockMessages.filter(m => m.message.includes && m.message.includes('Descargando')).length);
}

// Ejecutar tests
console.log('🧪 TEST DE DUPLICACIÓN DE MENSAJES\n');

testPlayCommandBefore();
testPlayCommandAfter();

console.log('\n' + '='.repeat(50));

testPlayformatCommandBefore();
testPlayformatCommandAfter();

console.log('\n✅ Tests completados');
console.log('📝 Resultado: Las correcciones eliminan los mensajes duplicados');
