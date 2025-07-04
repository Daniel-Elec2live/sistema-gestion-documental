const { GoogleAuth } = require('google-auth-library');
const { google } = require('googleapis');

require('dotenv').config();

// Función helper para procesar la clave privada
function processPrivateKey(key) {
  // Eliminar posibles espacios extras y asegurar formato correcto
  let processedKey = key.trim();
  
  // Si la clave no tiene los headers, agregarlos
  if (!processedKey.includes('BEGIN')) {
    processedKey = `-----BEGIN PRIVATE KEY-----\n${processedKey}\n-----END PRIVATE KEY-----`;
  }
  
  // Reemplazar los \n literales por saltos de línea reales
  processedKey = processedKey.replace(/\\n/g, '\n');
  
  // Asegurar que haya saltos de línea después de los headers
  processedKey = processedKey
    .replace(/-----BEGIN PRIVATE KEY-----/g, '-----BEGIN PRIVATE KEY-----\n')
    .replace(/-----END PRIVATE KEY-----/g, '\n-----END PRIVATE KEY-----');
  
  // Eliminar saltos de línea duplicados
  processedKey = processedKey.replace(/\n\n+/g, '\n');
  
  return processedKey;
}

// Cache simple en memoria para trabajadores
const workerCache = new Map();
const CACHE_TTL = 5 * 60 * 1000; // 5 minutos

exports.handler = async (event, context) => {
  // CORS headers
  const headers = {
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Headers': 'Content-Type',
    'Access-Control-Allow-Methods': 'POST, OPTIONS'
  };

  if (event.httpMethod === 'OPTIONS') {
    return { statusCode: 200, headers, body: '' };
  }

  if (event.httpMethod !== 'POST') {
    return {
      statusCode: 405,
      headers,
      body: JSON.stringify({ error: 'Método no permitido' })
    };
  }

  try {
    const { dni, correo } = JSON.parse(event.body);

    if (!dni || !correo) {
      return {
        statusCode: 400,
        headers,
        body: JSON.stringify({ error: 'DNI y correo son obligatorios' })
      };
    }

    // Verificar cache
    const cacheKey = `${dni}-${correo}`;
    const cached = workerCache.get(cacheKey);
    
    if (cached && (Date.now() - cached.timestamp) < CACHE_TTL) {
      console.log('Devolviendo datos desde cache');
      return {
        statusCode: 200,
        headers,
        body: JSON.stringify(cached.data)
      };
    }

    // Procesar la clave privada
    const privateKey = processPrivateKey(process.env.GOOGLE_PRIVATE_KEY);

    // Configurar autenticación con Google
    const auth = new GoogleAuth({
      credentials: {
        type: 'service_account',
        project_id: process.env.GOOGLE_PROJECT_ID,
        private_key_id: process.env.GOOGLE_PRIVATE_KEY_ID,
        private_key: privateKey,
        client_email: process.env.GOOGLE_CLIENT_EMAIL,
        client_id: process.env.GOOGLE_CLIENT_ID,
        auth_uri: 'https://accounts.google.com/o/oauth2/auth',
        token_uri: 'https://oauth2.googleapis.com/token',
        auth_provider_x509_cert_url: 'https://www.googleapis.com/oauth2/v1/certs',
        client_x509_cert_url: `https://www.googleapis.com/robot/v1/metadata/x509/${process.env.GOOGLE_CLIENT_EMAIL}`,
        universe_domain: 'googleapis.com'
      },
      scopes: [
        'https://www.googleapis.com/auth/spreadsheets',
        'https://www.googleapis.com/auth/drive.readonly'
      ]
    });

    const sheets = google.sheets({ version: 'v4', auth });
    const drive = google.drive({ version: 'v3', auth });

    // 1. Verificar que el trabajador existe
    const response = await sheets.spreadsheets.values.get({
      spreadsheetId: process.env.GOOGLE_SHEET_ID,
      range: 'Trabajadores!A:P'
    });

    const rows = response.data.values || [];
    
    // Buscar trabajador por DNI y correo
    const trabajadorRow = rows.find(row => 
      row[1] === dni && row[2] === correo // Columna B (DNI) y C (correo)
    );

    if (!trabajadorRow) {
      return {
        statusCode: 404,
        headers,
        body: JSON.stringify({ error: 'Trabajador no encontrado. Verifica tus datos.' })
      };
    }

    const carpetaUrl = trabajadorRow[8]; // Columna I (Carpeta Drive URL)
    const carpetaId = carpetaUrl.split('/').pop();

    // 2. Función optimizada para obtener documentos (sin recursión profunda)
    async function getDocumentsFromFolder(folderId, folderName = 'Carpeta Principal', maxDepth = 1, currentDepth = 0) {
      const folderData = {
        nombre: folderName,
        documentos: [],
        subcarpetas: []
      };
      
      try {
        // Obtener todo en una sola llamada
        const response = await drive.files.list({
          q: `'${folderId}' in parents and trashed=false`,
          fields: 'files(id, name, createdTime, webViewLink, mimeType)',
          orderBy: 'name,createdTime desc',
          pageSize: 100 // Limitar resultados
        });

        const files = response.data.files || [];
        
        // Separar archivos y carpetas
        for (const file of files) {
          if (file.mimeType === 'application/vnd.google-apps.folder') {
            // Es una carpeta
            if (currentDepth < maxDepth) {
              // Solo procesar subcarpetas si no hemos alcanzado la profundidad máxima
              const subfolderData = {
                nombre: file.name,
                documentos: [],
                subcarpetas: [],
                id: file.id,
                hasContent: true // Marcador para carga bajo demanda
              };
              folderData.subcarpetas.push(subfolderData);
            }
          } else {
            // Es un documento
            let tipoArchivo = 'Documento';
            if (file.mimeType.includes('pdf')) tipoArchivo = 'PDF';
            else if (file.mimeType.includes('image')) tipoArchivo = 'Imagen';
            else if (file.mimeType.includes('spreadsheet')) tipoArchivo = 'Hoja de Cálculo';
            else if (file.mimeType.includes('document')) tipoArchivo = 'Documento de Texto';

            folderData.documentos.push({
              nombre: file.name,
              fecha: new Date(file.createdTime).toLocaleDateString('es-ES'),
              estado: file.name.toLowerCase().includes('firmado') ? 'Firmado' : 'Pendiente',
              url: file.webViewLink,
              tipo: tipoArchivo,
              mimeType: file.mimeType
            });
          }
        }

        // Procesar subcarpetas solo del primer nivel
        if (currentDepth === 0 && folderData.subcarpetas.length > 0) {
          // Procesar máximo 5 subcarpetas en paralelo para evitar timeout
          const subcarpetasToProcess = folderData.subcarpetas.slice(0, 6);
          
          const subfolderPromises = subcarpetasToProcess.map(subfolder =>
            getDocumentsFromFolder(subfolder.id, subfolder.nombre, maxDepth, currentDepth + 1)
              .catch(err => {
                console.error(`Error procesando subcarpeta ${subfolder.nombre}:`, err);
                return subfolder; // Devolver la carpeta sin contenido si falla
              })
          );

          const processedSubfolders = await Promise.all(subfolderPromises);
          folderData.subcarpetas = processedSubfolders;
        }

      } catch (error) {
        console.error(`Error procesando carpeta ${folderName}:`, error);
      }

      return folderData;
    }

    // 3. Obtener estructura de carpetas con profundidad limitada
    const folderStructure = await getDocumentsFromFolder(carpetaId, 'Mis Documentos', 2);

    // 4. Contar total de documentos (función recursiva optimizada)
    function countAllDocuments(folderData) {
      let total = folderData.documentos.length;
      if (folderData.subcarpetas && folderData.subcarpetas.length > 0) {
        for (const subcarpeta of folderData.subcarpetas) {
          total += countAllDocuments(subcarpeta);
        }
      }
      return total;
    }

    const totalDocuments = countAllDocuments(folderStructure);

    // 5. Actualizar total de documentos en la hoja (con timeout)
    const rowIndex = rows.findIndex(row => row[1] === dni && row[2] === correo) + 1;
    
    const updatePromise = sheets.spreadsheets.values.batchUpdate({
      spreadsheetId: process.env.GOOGLE_SHEET_ID,
      resource: {
        valueInputOption: 'USER_ENTERED',
        data: [
          {
            range: `Trabajadores!M${rowIndex}`, // Total docs
            values: [[totalDocuments.toString()]]
          }
        ]
      }
    });

    // No esperar más de 1 segundo por la actualización
    await Promise.race([
      updatePromise,
      new Promise(resolve => setTimeout(resolve, 1000))
    ]).catch(err => console.error('Error actualizando total docs:', err));

    const responseData = {
      folderStructure: folderStructure,
      workerInfo: {
        nombre: trabajadorRow[0],
        empresa: trabajadorRow[5],
        estado: trabajadorRow[9],
        totalDocuments: totalDocuments,
        dniUrls: {
          delante: trabajadorRow[14] || null, // Columna O
          detras: trabajadorRow[15] || null   // Columna P
        }
      }
    };

    // Guardar en cache
    workerCache.set(cacheKey, {
      timestamp: Date.now(),
      data: responseData
    });

    // Limpiar cache antiguo si es muy grande
    if (workerCache.size > 100) {
      const oldestKey = workerCache.keys().next().value;
      workerCache.delete(oldestKey);
    }

    return {
      statusCode: 200,
      headers,
      body: JSON.stringify(responseData)
    };

  } catch (error) {
    console.error('Error:', error);
    return {
      statusCode: 500,
      headers,
      body: JSON.stringify({ 
        error: 'Error interno del servidor. Inténtalo de nuevo en unos minutos.',
        details: process.env.NODE_ENV === 'development' ? error.message : undefined
      })
    };
  }
};