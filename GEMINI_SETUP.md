# 🤖 Configuración de Google Gemini AI - Sugerencias Musicales

## 📋 Cómo obtener tu API Key de Google Gemini (GRATIS)

### Paso 1: Acceder a Google AI Studio
1. Ve a [Google AI Studio](https://aistudio.google.com/)
2. Inicia sesión con tu cuenta de Google

### Paso 2: Obtener API Key
1. Haz clic en "Get API Key" o "Obtener clave de API"
2. Crea un nuevo proyecto si no tienes uno
3. Copia la API key generada

### Paso 3: Configurar en el Bot
1. Abre el archivo `config.json`
2. Reemplaza `"TU_GEMINI_API_KEY_AQUI"` con tu API key real
3. Guarda el archivo

### Ejemplo de config.json:
```json
{
    "token": "tu_token_discord",
    "timezone": "America/Santiago",
    "geminiApiKey": "AIzaSyBtUaKnQfCbUuL6mG8vGrOuC6jM6L9Y2QR"
}
```

## ✨ Funcionalidades de IA Habilitadas

### 🎯 Botón "🤖 Sugerir Similar"
- Aparece en los controles de música
- Analiza la canción actual reproduciéndose
- Genera 4 sugerencias similares
- Permite añadir directamente a la cola

### 📝 Comando `!suggest`
```bash
# Sugerir basado en la canción actual
!suggest

# Sugerir basado en una canción específica
!suggest Bohemian Rhapsody
!suggest The Beatles - Yesterday
```

### 🎵 Cómo funciona
1. **IA analiza** el título de la canción
2. **Considera** género, artista, época, estilo
3. **Sugiere** 4 canciones similares populares
4. **Usuario elige** cuáles añadir con botones
5. **Bot busca** automáticamente en YouTube

## 🆓 Límites Gratuitos de Google Gemini

- **15 requests por minuto** - Perfecto para un bot personal
- **1500 requests por día** - Más que suficiente
- **Sin costo** hasta los límites mencionados
- **No requiere tarjeta de crédito**

## 🔧 Solución de Problemas

### ⚠️ "Las sugerencias de IA no están habilitadas"
- Verifica que la API key esté correctamente configurada en `config.json`
- Asegúrate de no dejar `"TU_GEMINI_API_KEY_AQUI"`

### ❌ "Error obteniendo sugerencias de IA"
- Revisa tu conexión a internet
- Verifica que la API key sea válida
- Chequea si alcanzaste los límites diarios
- **Error 404 del modelo**: El bot usa `gemini-1.5-flash` (modelo actualizado)

### 🔒 API Key no válida
- Regenera la API key en Google AI Studio
- Copia y pega correctamente (sin espacios extra)
- Revisa que el proyecto esté activo

## 🚀 Ejemplo de Uso Completo

1. **Reproducir música**: `!play Stairway to Heaven`
2. **Ver controles**: Aparecen automáticamente
3. **Pedir sugerencias**: Click en "🤖 Sugerir Similar"
4. **IA sugiere**:
   - Led Zeppelin - Kashmir
   - Pink Floyd - Comfortably Numb
   - Deep Purple - Smoke on the Water
   - Black Sabbath - Paranoid
5. **Añadir sugerencias**: Click en las opciones deseadas
6. **¡Disfrutar!**: Las canciones se añaden automáticamente

## 💡 Tips de Uso

- **Mejores sugerencias**: Usa títulos completos "Artista - Canción"
- **Variedad**: La IA considera diferentes aspectos musicales
- **Tiempo límite**: Las sugerencias expiran en 60 segundos
- **Cancela**: Usa el botón "❌ Cancelar" si no te gustan

¡Disfruta de las sugerencias inteligentes en tu bot de música! 🎵🤖
