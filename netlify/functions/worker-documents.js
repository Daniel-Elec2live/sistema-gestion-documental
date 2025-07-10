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

// Función helper para obtener información del archivo/carpeta
async function getFileInfo(drive, fileId) {
  try {
    const response = await drive.files.get({
      fileId: fileId,
      fields: 'id, name, parents, driveId',
      supportsAllDrives: true
    });
    return response.data;
  } catch (error) {
    console.error('Error obteniendo información del archivo:', error);
    return null;
  }
}

// Cache simple en memoria para trabajadores
const workerCache = new Map();
const CACHE_TTL = 5 * 60 * 1000; // 5 minutos

// Función para limpiar cache antiguo
function cleanupOldCache() {
  const now = Date.now();
  for (const [key, value] of workerCache.entries()) {
    if (now - value.timestamp > CACHE_TTL) {
      workerCache.delete(key);
    }
  }
}

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

    // Limpiar cache antiguo
    cleanupOldCache();

    // Verificar cache
    const cacheKey = `${dni}-${correo}`;
    const cached = workerCache.get(cacheKey);
    
    if (cached && (Date.now() - cached.timestamp) < CACHE_TTL) {
      console.log('🔄 Devolviendo datos desde cache');
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

    // 1. Verificar que el trabajador existe con timeout
    console.log('🔍 Verificando trabajador en Google Sheets...');
    const searchPromise = sheets.spreadsheets.values.get({
      spreadsheetId: process.env.GOOGLE_SHEET_ID,
      range: 'Trabajadores!A:P'
    });

    const response = await Promise.race([
      searchPromise,
      new Promise((_, reject) => setTimeout(() => reject(new Error('Timeout buscando trabajador')), 10000))
    ]);

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

    console.log('✅ Trabajador encontrado:', trabajadorRow[0]);

    const carpetaUrl = trabajadorRow[8]; // Columna I (Carpeta Drive URL)
    
    if (!carpetaUrl) {
      return {
        statusCode: 404,
        headers,
        body: JSON.stringify({ error: 'No se encontró la carpeta de documentos para este trabajador' })
      };
    }

    const carpetaId = carpetaUrl.split('/').pop();

    // 2. Verificar información de la carpeta principal
    console.log('📂 Verificando información de la carpeta principal...');
    const carpetaInfo = await getFileInfo(drive, carpetaId);
    
    if (!carpetaInfo) {
      console.error('❌ No se pudo acceder a la carpeta principal');
      return {
        statusCode: 500,
        headers,
        body: JSON.stringify({ error: 'No se pudo acceder a la carpeta de documentos' })
      };
    }

    console.log('📁 Carpeta principal encontrada:', {
      id: carpetaInfo.id,
      name: carpetaInfo.name,
      isSharedDrive: !!carpetaInfo.driveId
    });

    // 3. Definir estructura esperada de carpetas (según el sistema de registro)
    const expectedFolders = [
      'Nóminas',
      'Contratos', 
      'Formación',
      'Certificados',
      'Documentos Personales',
      'Pendiente de Firma'
    ];

    // 4. Función optimizada para obtener documentos CON CONTADOR POR CARPETA
    async function getDocumentsFromFolder(folderId, folderName = 'Carpeta Principal', isMainFolder = false) {
      const folderData = {
        id: folderId,
        nombre: folderName,
        documentos: [],
        subcarpetas: [],
        totalDocumentos: 0,
        isEmpty: true,
        url: `https://drive.google.com/drive/folders/${folderId}`,
        isVisible: true
      };
      
      try {
        console.log(`📁 Procesando carpeta: ${folderName}`);
        
        // Obtener contenido de la carpeta CON SOPORTE PARA SHARED DRIVES
        const listParams = {
          q: `'${folderId}' in parents and trashed=false`,
          fields: 'files(id, name, createdTime, modifiedTime, webViewLink, mimeType, size, parents)',
          orderBy: 'name,createdTime desc',
          pageSize: 200, // Aumentar límite
          supportsAllDrives: true,
          includeItemsFromAllDrives: true
        };

        // Agregar driveId si la carpeta está en un Shared Drive
        if (carpetaInfo.driveId) {
          listParams.driveId = carpetaInfo.driveId;
        }

        const listResponse = await Promise.race([
          drive.files.list(listParams),
          new Promise((_, reject) => setTimeout(() => reject(new Error('Timeout listando archivos')), 10000))
        ]);

        const files = listResponse.data.files || [];
        console.log(`📄 Encontrados ${files.length} elementos en ${folderName}`);
        
        // Si es la carpeta principal, crear subcarpetas faltantes
        if (isMainFolder) {
          const existingFolders = files
            .filter(file => file.mimeType === 'application/vnd.google-apps.folder')
            .map(folder => folder.name);
          
          console.log('📋 Carpetas existentes:', existingFolders);
          console.log('📋 Carpetas esperadas:', expectedFolders);

          // Para cada carpeta esperada, crear estructura incluso si no existe
          for (const expectedFolder of expectedFolders) {
            const existingFolder = files.find(file => 
              file.mimeType === 'application/vnd.google-apps.folder' && 
              file.name === expectedFolder
            );

            if (existingFolder) {
              // Procesar carpeta existente
              console.log(`✅ Procesando carpeta existente: ${expectedFolder}`);
              const subfolderContent = await getDocumentsFromFolder(
                existingFolder.id, 
                existingFolder.name, 
                false
              ).catch(err => {
                console.error(`❌ Error procesando subcarpeta ${expectedFolder}:`, err);
                return {
                  id: existingFolder.id,
                  nombre: expectedFolder,
                  documentos: [],
                  subcarpetas: [],
                  totalDocumentos: 0,
                  isEmpty: true,
                  url: `https://drive.google.com/drive/folders/${existingFolder.id}`,
                  isVisible: true,
                  error: err.message
                };
              });
              
              folderData.subcarpetas.push(subfolderContent);
            } else {
              // Crear estructura vacía para carpeta faltante
              console.log(`⚠️ Carpeta faltante: ${expectedFolder} - creando estructura vacía`);
              folderData.subcarpetas.push({
                id: null,
                nombre: expectedFolder,
                documentos: [],
                subcarpetas: [],
                totalDocumentos: 0,
                isEmpty: true,
                url: null,
                isVisible: true,
                isMissing: true,
                description: `Carpeta ${expectedFolder} no encontrada en Drive`
              });
            }
          }

          // Procesar otras carpetas no esperadas
          const otherFolders = files.filter(file => 
            file.mimeType === 'application/vnd.google-apps.folder' && 
            !expectedFolders.includes(file.name)
          );

          for (const otherFolder of otherFolders) {
            console.log(`📁 Procesando carpeta adicional: ${otherFolder.name}`);
            const subfolderContent = await getDocumentsFromFolder(
              otherFolder.id, 
              otherFolder.name, 
              false
            ).catch(err => {
              console.error(`❌ Error procesando carpeta adicional ${otherFolder.name}:`, err);
              return {
                id: otherFolder.id,
                nombre: otherFolder.name,
                documentos: [],
                subcarpetas: [],
                totalDocumentos: 0,
                isEmpty: true,
                url: `https://drive.google.com/drive/folders/${otherFolder.id}`,
                isVisible: true,
                error: err.message
              };
            });
            
            folderData.subcarpetas.push(subfolderContent);
          }
        } else {
          // Para subcarpetas, procesar normalmente
          for (const file of files) {
            if (file.mimeType === 'application/vnd.google-apps.folder') {
              // Es una subcarpeta - procesar recursivamente
              const subfolderContent = await getDocumentsFromFolder(
                file.id, 
                file.name, 
                false
              ).catch(err => {
                console.error(`❌ Error procesando subcarpeta ${file.name}:`, err);
                return {
                  id: file.id,
                  nombre: file.name,
                  documentos: [],
                  subcarpetas: [],
                  totalDocumentos: 0,
                  isEmpty: true,
                  url: `https://drive.google.com/drive/folders/${file.id}`,
                  isVisible: true,
                  error: err.message
                };
              });
              
              folderData.subcarpetas.push(subfolderContent);
            }
          }
        }
        
        // Procesar documentos (archivos que no son carpetas)
        const documents = files.filter(file => file.mimeType !== 'application/vnd.google-apps.folder');
        
        for (const file of documents) {
          let tipoArchivo = 'Documento';
          let estado = 'Pendiente';
          
          // Determinar tipo de archivo
          if (file.mimeType.includes('pdf')) tipoArchivo = 'PDF';
          else if (file.mimeType.includes('image')) tipoArchivo = 'Imagen';
          else if (file.mimeType.includes('spreadsheet')) tipoArchivo = 'Hoja de Cálculo';
          else if (file.mimeType.includes('document')) tipoArchivo = 'Documento de Texto';
          else if (file.mimeType.includes('presentation')) tipoArchivo = 'Presentación';
          else if (file.mimeType.includes('video')) tipoArchivo = 'Video';
          else if (file.mimeType.includes('audio')) tipoArchivo = 'Audio';
          
          // Determinar estado basado en el nombre
          if (file.name.toLowerCase().includes('firmado')) estado = 'Firmado';
          else if (file.name.toLowerCase().includes('aprobado')) estado = 'Aprobado';
          else if (file.name.toLowerCase().includes('completado')) estado = 'Completado';
          else if (file.name.toLowerCase().includes('pendiente')) estado = 'Pendiente';

          folderData.documentos.push({
            id: file.id,
            nombre: file.name,
            fecha: new Date(file.createdTime).toLocaleDateString('es-ES'),
            fechaModificacion: new Date(file.modifiedTime).toLocaleDateString('es-ES'),
            estado: estado,
            url: file.webViewLink,
            tipo: tipoArchivo,
            mimeType: file.mimeType,
            tamaño: file.size ? `${Math.round(file.size / 1024)} KB` : 'N/A'
          });
        }

        // Ordenar documentos por fecha de creación (más recientes primero)
        folderData.documentos.sort((a, b) => new Date(b.fecha) - new Date(a.fecha));

        // Calcular totales
        folderData.totalDocumentos = folderData.documentos.length;
        
        // Agregar documentos de subcarpetas al total
        for (const subcarpeta of folderData.subcarpetas) {
          folderData.totalDocumentos += subcarpeta.totalDocumentos;
        }

        // Determinar si está vacía
        folderData.isEmpty = folderData.totalDocumentos === 0;

        console.log(`📊 Carpeta ${folderName}: ${folderData.documentos.length} documentos directos, ${folderData.totalDocumentos} documentos totales`);

      } catch (error) {
        console.error(`❌ Error procesando carpeta ${folderName}:`, error);
        folderData.error = error.message;
        folderData.isEmpty = true;
        folderData.isVisible = true; // Mantener visible aunque tenga error
      }

      return folderData;
    }

    // 5. Obtener estructura de carpetas completa (incluyendo carpetas vacías)
    console.log('🔄 Obteniendo estructura completa de documentos...');
    const folderStructure = await getDocumentsFromFolder(carpetaId, 'Mis Documentos', true);

    // 6. Función para contar documentos totales
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
    console.log(`📊 Total de documentos encontrados: ${totalDocuments}`);

    // 7. Obtener documentos recientes (últimos 10)
    function getRecentDocuments(folderData, limit = 10) {
      const allDocs = [];
      
      function extractDocs(folder) {
        // Agregar información de la carpeta a cada documento
        const docsWithFolder = folder.documentos.map(doc => ({
          ...doc,
          carpeta: folder.nombre,
          carpetaId: folder.id
        }));
        allDocs.push(...docsWithFolder);
        
        if (folder.subcarpetas) {
          folder.subcarpetas.forEach(sub => extractDocs(sub));
        }
      }
      
      extractDocs(folderData);
      
      // Ordenar por fecha de modificación y limitar
      return allDocs
        .sort((a, b) => new Date(b.fechaModificacion) - new Date(a.fechaModificacion))
        .slice(0, limit);
    }

    const recentDocuments = getRecentDocuments(folderStructure);

    // 8. Crear resumen por carpetas
    const folderSummary = folderStructure.subcarpetas.map(carpeta => ({
      nombre: carpeta.nombre,
      id: carpeta.id,
      totalDocumentos: carpeta.totalDocumentos,
      documentosDirectos: carpeta.documentos.length,
      isEmpty: carpeta.isEmpty,
      isVisible: carpeta.isVisible,
      isMissing: carpeta.isMissing || false,
      url: carpeta.url,
      ultimoDocumento: carpeta.documentos.length > 0 ? carpeta.documentos[0] : null
    }));

    // 9. Actualizar total de documentos en la hoja (sin bloquear)
    const rowIndex = rows.findIndex(row => row[1] === dni && row[2] === correo) + 1;
    
    if (rowIndex > 0) {
      const updatePromise = sheets.spreadsheets.values.batchUpdate({
        spreadsheetId: process.env.GOOGLE_SHEET_ID,
        resource: {
          valueInputOption: 'USER_ENTERED',
          data: [
            {
              range: `Trabajadores!M${rowIndex}`, // Total docs
              values: [[totalDocuments.toString()]]
            },
            {
              range: `Trabajadores!L${rowIndex}`, // Último acceso
              values: [[new Date().toLocaleDateString('es-ES')]]
            }
          ]
        }
      });

      // No esperar más de 2 segundos por la actualización
      Promise.race([
        updatePromise,
        new Promise(resolve => setTimeout(resolve, 2000))
      ]).then(() => {
        console.log('✅ Datos actualizados en Google Sheets');
      }).catch(err => {
        console.error('❌ Error actualizando Google Sheets:', err);
      });
    }

    // 10. Preparar respuesta estructurada
    const responseData = {
      success: true,
      folderStructure: folderStructure,
      folderSummary: folderSummary,
      recentDocuments: recentDocuments,
      workerInfo: {
        nombre: trabajadorRow[0],
        dni: trabajadorRow[1],
        correo: trabajadorRow[2],
        telefono: trabajadorRow[3],
        direccion: trabajadorRow[4],
        empresa: trabajadorRow[5],
        talla: trabajadorRow[6],
        idInterno: trabajadorRow[7],
        carpetaUrl: trabajadorRow[8],
        estado: trabajadorRow[9] || 'Activo',
        fechaRegistro: trabajadorRow[10],
        ultimoAcceso: new Date().toLocaleDateString('es-ES'),
        totalDocuments: totalDocuments,
        dniUrls: {
          delante: trabajadorRow[14] || null, // Columna O
          detras: trabajadorRow[15] || null   // Columna P
        }
      },
      statistics: {
        carpetasPrincipales: folderStructure.subcarpetas.length,
        carpetasConDocumentos: folderSummary.filter(f => !f.isEmpty).length,
        carpetasVacias: folderSummary.filter(f => f.isEmpty).length,
        carpetasFaltantes: folderSummary.filter(f => f.isMissing).length,
        documentosTotales: totalDocuments,
        documentosRecientes: recentDocuments.length,
        ultimaConsulta: new Date().toISOString()
      }
    };

    // 11. Guardar en cache
    workerCache.set(cacheKey, {
      timestamp: Date.now(),
      data: responseData
    });

    // Limpiar cache si es muy grande
    if (workerCache.size > 100) {
      const oldestKey = workerCache.keys().next().value;
      workerCache.delete(oldestKey);
    }

    console.log(`✅ Consulta completada exitosamente para: ${trabajadorRow[0]}`);
    console.log(`📊 Resumen: ${folderSummary.length} carpetas, ${totalDocuments} documentos totales`);

    return {
      statusCode: 200,
      headers,
      body: JSON.stringify(responseData)
    };

  } catch (error) {
    console.error('❌ Error general:', error);
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