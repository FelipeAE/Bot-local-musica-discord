# Bot de Música para Discord - Versión Optimizada

Un bot de música para Discord optimizado que utiliza yt-dlp con sistema híbrido de streaming y descarga para una reproducción eficiente de audio de YouTube.

## 🚀 Características Principales

### ✨ Core Features
- ✅ Reproducción de música desde YouTube (URLs y búsquedas)
- ✅ Soporte completo para playlists
- ✅ Cola de reproducción con duración y método de reproducción
- ✅ Controles interactivos con botones Discord
- ✅ Comandos de gestión de cola (saltar, mezclar, pausa/resume)
- ✅ Sistema híbrido: Streaming + Descarga automática

### 🎯 Optimizaciones Implementadas
- ✅ **Código optimizado**: Reducido de ~2000 a ~500 líneas (75% menos)
- ✅ **Sistema híbrido inteligente**: Streaming para videos >15min, descarga para ≤15min
- ✅ **Gestión eficiente de memoria**: Menor uso de disco y RAM
- ✅ **Detección automática de duración**: Selección automática del mejor método
- ✅ **Compatibilidad con playlists**: Funciona con ambos métodos
- ✅ **Límite de duración**: Videos hasta 4 horas (configurable)
- ✅ **Logging detallado**: Información de método usado por cada video

### 🌐 Sistema Híbrido Streaming/Descarga
- **Streaming (🌐)**: Videos >15 minutos - Menor uso de disco, inicio más rápido
- **Descarga (📥)**: Videos ≤15 minutos - Mayor estabilidad para videos cortos
- **Fallback automático**: Si streaming falla, intenta descarga automáticamente
- **Indicadores visuales**: La cola muestra método usado para cada canción

## 📋 Requisitos Previos

1. **Node.js** (versión 16 o superior)
2. **yt-dlp** instalado y accesible desde la línea de comandos
3. **FFmpeg** (requerido por Discord.js)
4. Un **token de bot de Discord**

### Instalación de yt-dlp

```bash
# Windows (con pip)
pip install --upgrade yt-dlp

# O descargar el ejecutable desde:
# https://github.com/yt-dlp/yt-dlp/releases
```

### Instalación de FFmpeg

- **Windows**: Descargar desde [ffmpeg.org](https://ffmpeg.org/download.html)
- **Linux**: `sudo apt install ffmpeg`
- **macOS**: `brew install ffmpeg`

## 🛠️ Instalación

1. Clona o descarga este repositorio
2. Instala las dependencias:
   ```bash
   npm install
   ```
3. Copia el archivo de configuración de ejemplo:
   ```bash
   copy config.example.json config.json
   ```
4. Edita `config.json` con tu token de Discord:
   ```json
   {
       "token": "TU_TOKEN_DE_DISCORD_AQUI",
       "timezone": "America/Santiago"
   }
   ```

## ⚙️ Configuración del Sistema Híbrido

El bot está configurado con los siguientes parámetros optimizados:

### Umbrales de Duración
- **15 minutos**: Umbral para streaming vs descarga
- **4 horas**: Límite máximo de duración de video
- **Detección automática**: El bot decide automáticamente el mejor método

### Timeouts
- **Información de video**: 10 segundos
- **Stream URL**: 15 segundos  
- **Descarga**: 5 minutos
- **Conexión de voz**: 10 segundos

### Archivos Principales
- `index_optimized.js`: Versión optimizada del bot (archivo principal)
- `index.js`: Versión original completa (backup)
- `config.json`: Configuración del bot

## 🎵 Comandos

### Comando Principal
- `!play <URL/búsqueda>` - Reproduce música desde YouTube (URLs directas, búsquedas o playlists)
- `!queue` - Muestra la cola de reproducción con duraciones y métodos

### Ejemplos de Uso
```bash
# URL directa
!play https://www.youtube.com/watch?v=VIDEO_ID

# Playlist completa
!play https://www.youtube.com/playlist?list=PLAYLIST_ID

# Búsqueda por nombre
!play nombre de la canción

# Ver cola con información detallada
!queue
```

## 🎛️ Controles Interactivos

El bot incluye botones para control completo:
- ⏭ **Saltar** - Salta a la siguiente canción
- ⏸ **Pausar/▶️ Reanudar** - Pausa o reanuda la reproducción
- 🔀 **Mezclar** - Mezcla aleatoriamente la cola
- ⏹ **Detener** - Detiene la reproducción y limpia la cola
- 🎶 **Now Playing** - Muestra la canción actual con duración
- 📋 **Cola** - Muestra la cola con duraciones y métodos (🌐/📥)

### Ejemplo de Cola Mejorada
```
🎶 Cola de Reproducción
1. Mi canción favorita [03:45] 📥
2. Video largo de Pokemon [22:17] 🌐
3. Otra canción [04:12] 📥
4. Video sin duración aún [--:--] 📥

Total: 4 canciones | 🌐 = Streaming, 📥 = Descarga
```

## 🔧 Mejoras y Optimizaciones Implementadas

### 🎯 Optimización del Código (v2.0)
- **Reducción masiva**: De ~2000 líneas a ~500 líneas (75% menos código)
- **Eliminación de funciones no utilizadas**: Removidos comandos y características no esenciales
- **Código más limpio**: Funciones simplificadas y mejor organizadas
- **Mantenimiento mejorado**: Más fácil de entender y modificar

### 🌐 Sistema Híbrido Streaming/Descarga
- **Detección inteligente**: Automáticamente elige el mejor método según duración del video
- **Umbral de 15 minutos**: Videos >15min usan streaming, ≤15min usan descarga
- **Streaming directo**: Obtiene URL de stream de yt-dlp para videos largos
- **Fallback robusto**: Si streaming falla, automáticamente intenta descarga
- **Compatibilidad playlist**: Sistema híbrido funciona perfectamente con playlists

### 📊 Información Detallada en Cola
- **Duraciones visibles**: Cada canción muestra su duración [MM:SS] o [HH:MM:SS]
- **Indicadores de método**: 🌐 para streaming, 📥 para descarga
- **Estado en tiempo real**: Muestra [--:--] para canciones pendientes de procesar
- **Footer informativo**: Explica los símbolos y cuenta total de canciones

### 🚀 Mejoras de Rendimiento
- **Menor uso de memoria**: Streaming evita descargar archivos grandes
- **Inicio más rápido**: Videos largos empiezan inmediatamente con streaming
- **Gestión de archivos mejorada**: Solo descarga cuando es necesario
- **Timeouts optimizados**: 5 minutos para descargas, 15 segundos para streams

### 🔄 Mejoras en Reconexión
- **Estado de conexión mejorado**: Mejor detección de desconexiones
- **Reconexión automática**: Se conecta automáticamente al usar !play después de stop
- **Limpieza completa**: Stop button limpia todo el estado correctamente
- **Gestión de procesos**: Termina correctamente todos los procesos hijos

### 🎵 Límites y Configuración
- **Límite de duración**: Videos hasta 4 horas (configurable en código)
- **Detección de duplicados**: Previene añadir la misma canción múltiples veces
- **Validación de URLs**: Limpieza y validación automática de URLs de YouTube
- **Manejo de errores robusto**: Fallbacks para diferentes tipos de errores

## 🐛 Solución de Problemas Comunes

### Error HTTP 403: Forbidden
```bash
# Actualizar yt-dlp a la última versión
pip install --upgrade yt-dlp
```

### Videos que no se pueden reproducir
El bot automáticamente:
- Detecta videos privados/eliminados y los salta
- Usa fallback de descarga si streaming falla
- Muestra mensajes informativos sobre el problema

### Problemas de conexión después de usar Stop
- El bot ahora se reconecta automáticamente al usar `!play`
- El botón Stop limpia correctamente todo el estado
- No es necesario reiniciar el bot

### Rendimiento con videos largos
- Videos >15min usan streaming (menor uso de memoria)
- Videos ≤15min usan descarga (mayor estabilidad)
- El sistema elige automáticamente el mejor método

## 📊 Estadísticas de Optimización

### Mejoras de Código
- **Líneas de código**: ~2000 → ~500 (75% reducción)
- **Funciones principales**: Simplificadas y optimizadas
- **Comandos activos**: Solo los esenciales (`!play`, `!queue`)
- **Controles**: 6 botones interactivos principales

### Mejoras de Rendimiento
- **Streaming**: Videos largos inician inmediatamente
- **Memoria**: Menos uso de disco para videos >15min
- **Estabilidad**: Fallback automático entre métodos
- **Información**: Cola muestra duración y método para cada canción

## 🎮 Cómo Usar el Bot Optimizado

1. **Ejecutar**: `node index_optimized.js` o `npm start`
2. **Reproducir**: `!play [URL o búsqueda]`
3. **Ver cola**: `!queue` o botón 📋
4. **Controlar**: Usar los botones interactivos
5. **Playlists**: El bot procesará automáticamente todas las canciones

El bot elegirá automáticamente el mejor método para cada video según su duración.

## 📝 Scripts Disponibles

- `npm start` - Inicia el bot optimizado
- `node index_optimized.js` - Ejecuta directamente la versión optimizada
- `node index.js` - Ejecuta la versión original (backup)

## 🔄 Historial de Versiones

### v2.0 - Bot Optimizado con Sistema Híbrido
- ✅ Código reducido 75% (2000→500 líneas)
- ✅ Sistema híbrido streaming/descarga
- ✅ Cola con duraciones y métodos
- ✅ Umbral de 15 minutos para streaming
- ✅ Reconexión automática mejorada
- ✅ Compatibilidad completa con playlists

### v1.0 - Bot Original Completo
- ✅ Funcionalidad completa con múltiples comandos
- ✅ Sistema de descarga robusto
- ✅ Manejo de videos largos con confirmación
- ✅ Controles avanzados y configuración detallada

## 🔗 Enlaces Útiles

- [Discord.js Documentation](https://discord.js.org/)
- [yt-dlp Documentation](https://github.com/yt-dlp/yt-dlp)
- [Discord Developer Portal](https://discord.com/developers/applications)

## 📄 Licencia

ISC License
