# Bot de Música para Discord

Un bot de música para Discord que utiliza yt-dlp para descargar y reproducir audio de YouTube de forma pseudo-local.

## 🚀 Características

- ✅ Reproducción de música desde YouTube
- ✅ Soporte para playlists
- ✅ Cola de reproducción con paginación
- ✅ Controles interactivos (botones)
- ✅ Comando para saltar canciones
- ✅ Función de mezclar cola
- ✅ Gestión mejorada de archivos temporales
- ✅ Logging detallado con timestamps
- ✅ Manejo robusto de errores
- ✅ **NUEVO**: Limpieza automática de URLs problemáticas
- ✅ **NUEVO**: Validación de URLs de YouTube
- ✅ **NUEVO**: Detección específica de tipos de error
- ✅ **NUEVO**: Mensajes de error más informativos
- ✅ **NUEVO**: Detección automática de videos largos con confirmación
- ✅ **NUEVO**: Timeouts adaptativos según duración del video
- ✅ **NUEVO**: Sistema de confirmación mejorado con embeds
- ✅ **NUEVO**: Soporte para videos extremadamente largos (10+ horas)

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
       "timezone": "America/Santiago",
       "maxFileSize": 50000000,
       "downloadTimeout": 300000,
       "downloadTimeoutLong": 1800000,
       "longVideoDurationThreshold": 3600
   }
   ```

## 🎵 Comandos

- `!play <URL/búsqueda>` - Reproduce música desde YouTube
- `!playlong <URL>` - Reproduce videos largos (sin confirmación de duración)
- `!playnext <URL/búsqueda>` - Añade una canción para reproducir después de la actual
- `!queue` - Muestra la cola de reproducción
- `!move <posición_actual> <nueva_posición>` - Mueve una canción en la cola

### 📝 Notas sobre Videos Largos

- Videos de más de 1 hora requieren confirmación con `!play`
- Usa `!playlong` para saltear la confirmación
- **Nuevo**: Timeout adaptativo - 5 min para videos normales, 30 min para largos
- **Nuevo**: Sistema de confirmación mejorado con embeds y reacciones
- Se muestra advertencia de duración en el título
- Soporte para videos extremadamente largos (10+ horas)

## 🎛️ Controles Interactivos

El bot incluye botones para:
- ⏭ **Saltar** - Salta a la siguiente canción
- ⏸ **Pausar/▶️ Reanudar** - Pausa o reanuda la reproducción
- 🔀 **Mezclar** - Mezcla aleatoriamente la cola
- ⏹ **Detener** - Detiene la reproducción y limpia la cola
- 🎶 **Now Playing** - Muestra la canción actual
- 🎵 **Mostrar Cola** - Muestra la cola con paginación

## 🔧 Mejoras Implementadas

### ✅ Correcciones de Bugs
- **Funciones mal ubicadas**: Movidas las funciones `createQueueEmbed` y `createPaginationButtons` fuera del switch statement
- **Manejo de archivos temporales**: Implementada función `cleanupTempFile()` para limpieza robusta
- **Gestión de títulos**: Reactivada la función `getVideoTitle()` para obtener títulos reales
- **Validación de archivos**: Verificación de existencia antes de eliminar archivos temporales

### 🔒 Seguridad
- **Token protegido**: Movido a archivo de configuración separado
- **Archivo .gitignore**: Creado para proteger información sensible
- **Configuración ejemplo**: Archivo `config.example.json` para facilitar setup

### 🚀 Mejoras de Rendimiento
- **Mejor logging**: Uso consistente de winston logger en lugar de console.log
- **Timeout configurable**: Timeout de descarga configurable desde config.json
- **Manejo de errores mejorado**: Mejor gestión de errores en todas las operaciones

### 🎯 Funcionalidad Mejorada
- **Títulos en búsquedas**: Obtiene tanto ID como título en búsquedas de YouTube
- **Cola con títulos**: Muestra títulos reales en lugar de URLs cuando es posible
- **Mejor feedback**: Mensajes más informativos al añadir canciones

### 🆕 Nuevas Mejoras para Videos Largos
- **Detección automática**: Identifica videos de más de 1 hora automáticamente
- **Confirmación mejorada**: Sistema con embeds visuales y reacciones
- **Timeouts adaptativos**: 5 minutos para videos normales, 30 minutos para largos
- **Mensajes específicos**: Diferente feedback según el tipo de video
- **Bot "a todo terreno"**: Soporte completo para videos extremadamente largos
- **Información de duración**: Muestra duración exacta y advertencias visuales

### 🔧 Configuración Avanzada
- `downloadTimeout`: Timeout para videos normales (300000ms = 5 min)
- `downloadTimeoutLong`: Timeout para videos largos (1800000ms = 30 min)
- `longVideoDurationThreshold`: Umbral para considerar un video "largo" (3600s = 1 hora)

## 🐛 Solución de Problemas Comunes

### Error HTTP 403: Forbidden
```bash
# Actualizar yt-dlp a la última versión
pip install --upgrade yt-dlp
```

### Error "Unsupported URL" / URLs con caracteres especiales
El bot ahora incluye limpieza automática de URLs que:
- Decodifica caracteres especiales (`%5B`, `%5D`, etc.)
- Remueve caracteres problemáticos como `[` y `]`
- Valida que las URLs sean de YouTube válidas
- Reconstruye URLs limpias automáticamente

### Problemas con cookies
Si tienes problemas de autenticación, puedes usar cookies de YouTube:
```bash
# Exportar cookies desde tu navegador y guardar como cookies.txt
# Usar youtube.com (no www.youtube.com) al exportar
```

### Archivo de audio muy pequeño
Este error indica que la descarga falló. Posibles soluciones:
1. Verificar que yt-dlp esté actualizado
2. Comprobar la conectividad a internet
3. Verificar que la URL sea válida

### Videos con restricciones
El bot ahora detecta automáticamente estos tipos de error:
- Videos privados o eliminados
- Videos con restricción de edad
- Videos no disponibles en tu región
- Problemas de acceso (Error 403)

## 📝 Scripts Disponibles

- `npm start` - Inicia el bot
- `npm run dev` - Inicia el bot con nodemon (reinicio automático)
- `npm run stop` - Detiene el bot

## 🔗 Enlaces Útiles

- [Discord.js Documentation](https://discord.js.org/)
- [yt-dlp Documentation](https://github.com/yt-dlp/yt-dlp)
- [Discord Developer Portal](https://discord.com/developers/applications)

## 📄 Licencia

ISC License
