const { GoogleAuth } = require('google-auth-library');
const { google } = require('googleapis');
const nodemailer = require('nodemailer');
const multiparty = require('multiparty');
const fs = require('fs');
const path = require('path');
const os = require('os');

require('dotenv').config();

// Función helper para procesar la clave privada
function processPrivateKey(key) {
  let processedKey = key.trim();
  if (!processedKey.includes('BEGIN')) {
    processedKey = `-----BEGIN PRIVATE KEY-----\n${processedKey}\n-----END PRIVATE KEY-----`;
  }
  processedKey = processedKey.replace(/\\n/g, '\n');
  processedKey = processedKey
    .replace(/-----BEGIN PRIVATE KEY-----/g, '-----BEGIN PRIVATE KEY-----\n')
    .replace(/-----END PRIVATE KEY-----/g, '\n-----END PRIVATE KEY-----');
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

// CORRECCIÓN PROBLEMA 1: Configurar Nodemailer con la sintaxis correcta
let transporter = null;
let transporterReady = false;

async function initializeTransporter() {
  try {
    if (process.env.SMTP_HOST && process.env.SMTP_USER && process.env.SMTP_PASS) {
      // CORRECCIÓN: createTransport (sin 'er') para nodemailer 6.x/7.x
      transporter = nodemailer.createTransport({
        host: process.env.SMTP_HOST,
        port: parseInt(process.env.SMTP_PORT) || 587,
        secure: process.env.SMTP_SECURE === 'true',
        auth: {
          user: process.env.SMTP_USER,
          pass: process.env.SMTP_PASS
        },
        tls: {
          rejectUnauthorized: false
        },
        connectionTimeout: 60000,
        socketTimeout: 60000,
        pool: true,
        maxConnections: 5,
        maxMessages: 100
      });
      
      // CORRECCIÓN: Verificar conexión con timeout
      await Promise.race([
        transporter.verify(),
        new Promise((_, reject) => 
          setTimeout(() => reject(new Error('SMTP verification timeout')), 10000)
        )
      ]);
      
      transporterReady = true;
      console.log('✅ Servidor SMTP listo para enviar emails');
      return true;
    } else {
      console.warn('⚠️ Variables SMTP no configuradas');
      return false;
    }
  } catch (error) {
    console.error('❌ Error configurando SMTP:', error.message);
    transporter = null;
    transporterReady = false;
    return false;
  }
}

// CORRECCIÓN PROBLEMA 3: Función simplificada para parsear FormData
async function parseFormDataSimple(event) {
  return new Promise((resolve, reject) => {
    console.log('🔄 Iniciando parseFormDataSimple...');
    
    try {
      const contentType = event.headers['content-type'] || event.headers['Content-Type'] || '';
      
      if (!contentType.includes('multipart/form-data')) {
        throw new Error('Content-Type debe ser multipart/form-data');
      }

      // Crear buffer del body
      let bodyBuffer;
      if (event.isBase64Encoded) {
        bodyBuffer = Buffer.from(event.body, 'base64');
        console.log('📦 Decodificado desde base64');
      } else {
        bodyBuffer = Buffer.from(event.body, 'binary');
        console.log('📦 Procesado como binary');
      }
      
      console.log(`📦 Buffer creado: ${bodyBuffer.length} bytes`);

      // CORRECCIÓN: Usar Readable stream nativo en lugar de objeto fake
      const { Readable } = require('stream');
      
      const bodyStream = new Readable({
        read() {}
      });
      
      // Configurar headers en el stream
      bodyStream.headers = {
        'content-type': contentType,
        'content-length': bodyBuffer.length.toString()
      };
      
      // Push data al stream
      bodyStream.push(bodyBuffer);
      bodyStream.push(null); // EOF

      // CORRECCIÓN: Configuración mejorada para multiparty
      const form = new multiparty.Form({
        maxFilesSize: 50 * 1024 * 1024, // 50MB
        maxFields: 20,
        maxFieldsSize: 10 * 1024 * 1024,
        autoFields: true,
        autoFiles: true,
        uploadDir: os.tmpdir(),
        encoding: 'utf8'
      });

      // Timeout para el parseo
      const timeout = setTimeout(() => {
        console.error('❌ Timeout en parseFormData');
        reject(new Error('Timeout parsing form data'));
      }, 30000);

      // CORRECCIÓN: Manejo de errores del form
      form.on('error', (error) => {
        clearTimeout(timeout);
        console.error('❌ Error en form.parse:', error);
        reject(error);
      });

      console.log('🔄 Iniciando parse...');
      
      // CORRECCIÓN: Usar el stream directamente
      form.parse(bodyStream, (err, fields, files) => {
        clearTimeout(timeout);
        
        if (err) {
          console.error('❌ Error en multiparty:', err);
          reject(err);
          return;
        }

        console.log('✅ Parse completado');
        console.log('📊 Fields keys:', Object.keys(fields || {}));
        console.log('📊 Files keys:', Object.keys(files || {}));

        // Limpiar campos
        const cleanFields = {};
        for (const [key, value] of Object.entries(fields || {})) {
          cleanFields[key] = Array.isArray(value) ? value[0] : value;
        }

        // Limpiar archivos
        const cleanFiles = {};
        for (const [key, fileArray] of Object.entries(files || {})) {
          const file = Array.isArray(fileArray) ? fileArray[0] : fileArray;
          if (file && file.path && fs.existsSync(file.path)) {
            cleanFiles[key] = {
              path: file.path,
              originalFilename: file.originalFilename || `${key}.jpg`,
              headers: file.headers || { 'content-type': 'image/jpeg' },
              size: file.size || 0
            };
            console.log(`📁 Archivo ${key}: ${file.size} bytes`);
          }
        }

        resolve({ fields: cleanFields, files: cleanFiles });
      });

    } catch (error) {
      console.error('❌ Error crítico en parseFormData:', error);
      reject(error);
    }
  });
}

// Función SUPER OPTIMIZADA para subir DNIs Y crear carpeta
async function uploadDNIImagesOptimized(drive, carpetaId, dniDelanteFile, dniDetrasFile, driveId = null) {
  const uploadedFiles = { documentosPersonalesFolderId: null };
  
  try {
    console.log('📋 Proceso optimizado: creando carpeta y subiendo DNIs...');
    
    // PASO 1: Crear carpeta "Documentos Personales" PRIMERO
    const newFolder = await drive.files.create({
      resource: {
        name: 'Documentos Personales',
        mimeType: 'application/vnd.google-apps.folder',
        parents: [carpetaId]
      },
      supportsAllDrives: true
    });
    
    const documentosPersonalesFolderId = newFolder.data.id;
    uploadedFiles.documentosPersonalesFolderId = documentosPersonalesFolderId;
    console.log('✅ Carpeta "Documentos Personales" creada:', documentosPersonalesFolderId);

    // PASO 2: Subir archivos DNI EN PARALELO
    const uploadPromises = [];

    // Subir DNI Delante
    if (dniDelanteFile && fs.existsSync(dniDelanteFile.path)) {
      uploadPromises.push(
        drive.files.create({
          resource: {
            name: `DNI_Delante_${dniDelanteFile.originalFilename || 'documento.jpg'}`,
            parents: [documentosPersonalesFolderId]
          },
          media: {
            mimeType: dniDelanteFile.headers['content-type'] || 'image/jpeg',
            body: fs.createReadStream(dniDelanteFile.path)
          },
          supportsAllDrives: true
        }).then(response => {
          uploadedFiles.dniDelanteUrl = `https://drive.google.com/file/d/${response.data.id}/view`;
          uploadedFiles.dniDelanteId = response.data.id;
          console.log('✅ DNI Delante subido');
          return true;
        }).catch(error => {
          console.error('❌ Error subiendo DNI Delante:', error.message);
          uploadedFiles.dniDelanteError = error.message;
          return false;
        })
      );
    }
    
    // Subir DNI Detrás
    if (dniDetrasFile && fs.existsSync(dniDetrasFile.path)) {
      uploadPromises.push(
        drive.files.create({
          resource: {
            name: `DNI_Detras_${dniDetrasFile.originalFilename || 'documento.jpg'}`,
            parents: [documentosPersonalesFolderId]
          },
          media: {
            mimeType: dniDetrasFile.headers['content-type'] || 'image/jpeg',
            body: fs.createReadStream(dniDetrasFile.path)
          },
          supportsAllDrives: true
        }).then(response => {
          uploadedFiles.dniDetrasUrl = `https://drive.google.com/file/d/${response.data.id}/view`;
          uploadedFiles.dniDetrasId = response.data.id;
          console.log('✅ DNI Detrás subido');
          return true;
        }).catch(error => {
          console.error('❌ Error subiendo DNI Detrás:', error.message);
          uploadedFiles.dniDetrasError = error.message;
          return false;
        })
      );
    }

    // Esperar subidas con timeout más largo
    await Promise.race([
      Promise.all(uploadPromises),
      new Promise(resolve => setTimeout(resolve, 30000))
    ]);

    console.log('✅ Proceso de DNIs completado');
    
  } catch (error) {
    console.error('❌ Error en proceso de DNIs:', error.message);
    uploadedFiles.generalError = error.message;
  }
  
  return uploadedFiles;
}

// CORRECCIÓN PROBLEMA 1: Función para enviar email de forma síncrona
async function sendConfirmationEmailSync(correo, nombre, empresa, carpetaUrl = null) {
  if (!transporter || !transporterReady) {
    console.warn('⚠️ Transporter no está listo, inicializando...');
    const initialized = await initializeTransporter();
    if (!initialized) {
      console.error('❌ No se pudo inicializar el transporter');
      return { success: false, error: 'SMTP no configurado' };
    }
  }

  try {
    const fechaRegistro = new Date().toLocaleDateString('es-ES', {
      year: 'numeric',
      month: 'long',
      day: 'numeric'
    });

    const mailOptions = {
      from: {
        name: process.env.FROM_NAME || 'Sistema de Gestión Documental',
        address: process.env.FROM_EMAIL || process.env.SMTP_USER
      },
      to: correo,
      subject: '🎉 Bienvenido al Sistema de Gestión Documental - Acceso Configurado',
      html: `
        <!DOCTYPE html>
        <html lang="es">
        <head>
          <meta charset="UTF-8">
          <meta name="viewport" content="width=device-width, initial-scale=1.0">
          <title>Bienvenido al Sistema</title>
        </head>
        <body style="margin: 0; padding: 20px; font-family: 'Arial', sans-serif; background-color: #f4f4f4;">
          <div style="max-width: 600px; margin: 0 auto; background-color: white; border-radius: 10px; overflow: hidden; box-shadow: 0 4px 6px rgba(0, 0, 0, 0.1);">
            
            <!-- Header -->
            <div style="background: linear-gradient(135deg, #667eea 0%, #764ba2 100%); padding: 40px 30px; text-align: center;">
              <h1 style="color: white; margin: 0; font-size: 28px; font-weight: 300;">¡Bienvenido al Sistema!</h1>
              <p style="color: #e8f0fe; margin: 10px 0 0 0; font-size: 16px;">Tu registro se ha completado exitosamente</p>
            </div>
            
            <!-- Content -->
            <div style="padding: 40px 30px;">
              <p style="color: #333; font-size: 16px; line-height: 1.6; margin-bottom: 20px;">
                Hola <strong style="color: #667eea;">${nombre}</strong>,
              </p>
              
              <p style="color: #666; font-size: 16px; line-height: 1.6; margin-bottom: 30px;">
                Te confirmamos que tu registro en el Sistema de Gestión Documental se ha completado exitosamente y ya tienes acceso a tu carpeta personal de documentos.
              </p>

              ${carpetaUrl ? `
              <!-- Acceso a Carpeta Personal -->
              <div style="background: linear-gradient(135deg, #28a745 0%, #20c997 100%); padding: 25px; border-radius: 8px; margin: 30px 0;">
                <h3 style="color: white; margin: 0 0 15px 0; font-size: 18px;">📁 Tu Carpeta Personal</h3>
                <p style="color: white; margin: 0 0 15px 0;">Ya puedes acceder a tu carpeta personal de documentos:</p>
                <div style="text-align: center;">
                  <a href="${carpetaUrl}" 
                     style="display: inline-block; background: rgba(255,255,255,0.2); color: white; padding: 12px 30px; text-decoration: none; border-radius: 25px; font-weight: bold; border: 2px solid white;">
                    🔗 Acceder a Mi Carpeta
                  </a>
                </div>
              </div>
              ` : ''}
              
              <!-- Info Box -->
              <div style="background: linear-gradient(135deg,rgb(200, 227, 248) 0%, #7bbbea 100%); padding: 25px; border-radius: 8px; margin: 30px 0;">
                <h3 style="color: white; margin: 0 0 15px 0; font-size: 18px;">📋 Datos de tu registro</h3>
                <table style="width: 100%; color: white;">
                  <tr>
                    <td style="padding: 5px 0; font-weight: bold;">Nombre:</td>
                    <td style="padding: 5px 0;">${nombre}</td>
                  </tr>
                  <tr>
                    <td style="padding: 5px 0; font-weight: bold;">Empresa:</td>
                    <td style="padding: 5px 0;">${empresa}</td>
                  </tr>
                  <tr>
                    <td style="padding: 5px 0; font-weight: bold;">Email:</td>
                    <td style="padding: 5px 0;">${correo}</td>
                  </tr>
                  <tr>
                    <td style="padding: 5px 0; font-weight: bold;">Fecha:</td>
                    <td style="padding: 5px 0;">${fechaRegistro}</td>
                  </tr>
                </table>
              </div>
              
              <!-- CTA Button -->
              <div style="text-align: center; margin: 40px 0;">
                <a href="${process.env.APP_URL || 'https://sistemagestiondocumental.netlify.app/'}" 
                   style="display: inline-block; background: linear-gradient(135deg, #667eea 0%, #764ba2 100%); color: white; padding: 15px 40px; text-decoration: none; border-radius: 50px; font-weight: bold; font-size: 16px;">
                  🔗 Acceder al Sistema
                </a>
              </div>
            </div>
          </div>
        </body>
        </html>
      `,
      text: `
¡Bienvenido al Sistema de Gestión Documental!

Hola ${nombre},

Tu registro se ha completado exitosamente.

Datos de registro:
• Nombre: ${nombre}
• Empresa: ${empresa}
• Email: ${correo}
• Fecha: ${fechaRegistro}

${carpetaUrl ? `Tu carpeta personal: ${carpetaUrl}` : ''}

Acceder al sistema: ${process.env.APP_URL || 'https://sistemagestiondocumental.netlify.app/'}
      `
    };

    const result = await Promise.race([
      transporter.sendMail(mailOptions),
      new Promise((_, reject) => 
        setTimeout(() => reject(new Error('Email timeout')), 30000)
      )
    ]);

    console.log('✅ Email enviado exitosamente a:', correo);
    return { success: true, messageId: result.messageId };

  } catch (error) {
    console.error('❌ Error enviando email:', error.message);
    return { success: false, error: error.message };
  }
}

// CORRECCIÓN PROBLEMA 2: Función mejorada para permisos con reintentos
async function grantPermissionsSync(drive, carpetaId, subcarpetasIds, correo, documentosPersonalesId) {
  console.log('🔐 Configurando permisos...');
  
  const results = {
    principal: false,
    subcarpetas: [],
    documentosPersonales: false,
    errors: []
  };

  try {
    const maxRetries = 3;
    const retryDelay = 2000;

    // Función helper para reintentos
    const retryOperation = async (operation, description, retries = maxRetries) => {
      for (let i = 0; i < retries; i++) {
        try {
          await Promise.race([
            operation(),
            new Promise((_, reject) => 
              setTimeout(() => reject(new Error('Timeout')), 15000)
            )
          ]);
          console.log(`✅ ${description} - intento ${i + 1}`);
          return true;
        } catch (error) {
          console.warn(`⚠️ ${description} falló - intento ${i + 1}:`, error.message);
          if (i < retries - 1) {
            await new Promise(resolve => setTimeout(resolve, retryDelay));
          } else {
            results.errors.push(`${description}: ${error.message}`);
          }
        }
      }
      return false;
    };

    // Permiso carpeta principal
    results.principal = await retryOperation(
      () => drive.permissions.create({
        fileId: carpetaId,
        resource: { 
          role: 'reader', 
          type: 'user', 
          emailAddress: correo 
        },
        supportsAllDrives: true,
        sendNotificationEmail: false
      }),
      'Permiso carpeta principal'
    );

    // Permisos subcarpetas en lotes pequeños
    const batchSize = 2;
    for (let i = 0; i < subcarpetasIds.length; i += batchSize) {
      const batch = subcarpetasIds.slice(i, i + batchSize);
      
      await Promise.all(batch.map(async (subcarpeta) => {
        if (subcarpeta.id) {
          const success = await retryOperation(
            () => drive.permissions.create({
              fileId: subcarpeta.id,
              resource: { 
                role: 'reader', 
                type: 'user', 
                emailAddress: correo 
              },
              supportsAllDrives: true,
              sendNotificationEmail: false
            }),
            `Permiso ${subcarpeta.nombre}`
          );
          results.subcarpetas.push({ nombre: subcarpeta.nombre, success });
        }
      }));

      // Pausa entre lotes
      if (i + batchSize < subcarpetasIds.length) {
        await new Promise(resolve => setTimeout(resolve, 1000));
      }
    }

    // Permiso para Documentos Personales (con notificación)
    if (documentosPersonalesId) {
      results.documentosPersonales = await retryOperation(
        () => drive.permissions.create({
          fileId: documentosPersonalesId,
          resource: { 
            role: 'reader', 
            type: 'user', 
            emailAddress: correo 
          },
          supportsAllDrives: true,
          sendNotificationEmail: true
        }),
        'Permiso Documentos Personales'
      );
    }

    console.log('✅ Configuración de permisos completada');
    
  } catch (error) {
    console.error('❌ Error configurando permisos:', error.message);
    results.errors.push(`Error general: ${error.message}`);
  }

  return results;
}

exports.handler = async (event, context) => {
  // CORRECCIÓN PROBLEMA 3: Timeout más largo para móviles
  context.callbackWaitsForEmptyEventLoop = false;
  
  // CORS headers mejorados
  const headers = {
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Headers': 'Content-Type, Content-Length, Authorization',
    'Access-Control-Allow-Methods': 'POST, OPTIONS',
    'Access-Control-Max-Age': '86400',
    'Content-Type': 'application/json'
  };

  console.log('🚀 INICIO - Proceso optimizado de registro');
  console.log('📱 User-Agent:', event.headers['user-agent'] || 'No disponible');
  console.log('🌐 Método:', event.httpMethod);
  console.log('📋 Content-Type:', event.headers['content-type'] || 'No disponible');

  if (event.httpMethod === 'OPTIONS') {
    console.log('✅ Respondiendo a preflight CORS');
    return { statusCode: 200, headers, body: '' };
  }

  if (event.httpMethod !== 'POST') {
    console.log('❌ Método no permitido:', event.httpMethod);
    return {
      statusCode: 405,
      headers,
      body: JSON.stringify({ error: 'Método no permitido' })
    };
  }

  let tempFilePaths = [];
  const startTime = Date.now();

  try {
    // CORRECCIÓN PROBLEMA 1: Inicializar transporter al inicio (sin bloquear si falla)
    console.log('📧 Inicializando sistema de email...');
    await initializeTransporter().catch(err => {
      console.warn('⚠️ Email no disponible:', err.message);
    });

    // PASO 1: Parsear datos
    let formData;
    try {
      console.log('🔄 Iniciando parseo de datos...');
      
      if (!event.body) {
        console.log('❌ No hay body en la request');
        return {
          statusCode: 400,
          headers,
          body: JSON.stringify({ error: 'No se recibieron datos' })
        };
      }

      const contentType = event.headers['content-type'] || event.headers['Content-Type'] || '';
      console.log('📋 Content-Type detectado:', contentType);
      
      if (contentType.includes('application/json')) {
        console.log('📝 Parseando JSON...');
        const jsonData = JSON.parse(event.body);
        formData = {
          fields: jsonData,
          files: {
            dniDelante: jsonData.dniDelante ? { 
              buffer: Buffer.from(jsonData.dniDelante.split(',')[1], 'base64'), 
              originalFilename: jsonData.dniDelanteNombre || 'dni_delante.jpg',
              headers: { 'content-type': 'image/jpeg' }
            } : null,
            dniDetras: jsonData.dniDetras ? { 
              buffer: Buffer.from(jsonData.dniDetras.split(',')[1], 'base64'), 
              originalFilename: jsonData.dniDetrasNombre || 'dni_detras.jpg',
              headers: { 'content-type': 'image/jpeg' }
            } : null
          }
        };
      } else if (contentType.includes('multipart/form-data')) {
        console.log('📎 Parseando FormData...');
        
        try {
          // CORRECCIÓN: Usar función simplificada
          formData = await parseFormDataSimple(event);
          console.log('✅ FormData parseado exitosamente');
        } catch (parseError) {
          console.error('❌ Error específico en parseFormData:', parseError.message);
          throw parseError;
        }
      } else {
        console.log('❌ Content-type no soportado:', contentType);
        return {
          statusCode: 400,
          headers,
          body: JSON.stringify({ 
            error: 'Tipo de contenido no soportado',
            contentType: contentType,
            expectedTypes: ['multipart/form-data', 'application/json']
          })
        };
      }
      
      console.log('✅ Datos parseados correctamente');
      console.log('📊 Campos recibidos:', Object.keys(formData.fields).length);
      console.log('📊 Archivos recibidos:', Object.keys(formData.files).length);
      
    } catch (parseError) {
      console.error('❌ Error parseando datos:', parseError.message);
      
      return {
        statusCode: 400,
        headers,
        body: JSON.stringify({ 
          error: 'Error procesando formulario. Por favor, intenta de nuevo.',
          details: parseError.message,
          type: 'PARSE_ERROR'
        })
      };
    }

    const { fields, files } = formData;
    const { nombre, dni, correo, telefono, direccion, empresa, talla } = fields;

    console.log('📊 Datos extraídos para validación:', { nombre: !!nombre, dni: !!dni, correo: !!correo, empresa: !!empresa });

    // PASO 2: Validaciones
    if (!nombre || !dni || !correo || !telefono || !direccion || !empresa || !talla) {
      console.log('❌ Faltan campos obligatorios');
      const camposFaltantes = [];
      if (!nombre) camposFaltantes.push('nombre');
      if (!dni) camposFaltantes.push('dni');
      if (!correo) camposFaltantes.push('correo');
      if (!telefono) camposFaltantes.push('telefono');
      if (!direccion) camposFaltantes.push('direccion');
      if (!empresa) camposFaltantes.push('empresa');
      if (!talla) camposFaltantes.push('talla');
      
      return {
        statusCode: 400,
        headers,
        body: JSON.stringify({ 
          error: 'Todos los campos son obligatorios',
          camposFaltantes 
        })
      };
    }

    if (!files.dniDelante || !files.dniDetras) {
      console.log('❌ Faltan archivos DNI');
      return {
        statusCode: 400,
        headers,
        body: JSON.stringify({ 
          error: 'Debes subir ambas fotos del DNI',
          archivosRecibidos: Object.keys(files)
        })
      };
    }

    const emailRegex = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
    if (!emailRegex.test(correo)) {
      console.log('❌ Email inválido:', correo);
      return {
        statusCode: 400,
        headers,
        body: JSON.stringify({ error: 'Email inválido' })
      };
    }

    // PASO 3: Configurar Google
    const privateKey = processPrivateKey(process.env.GOOGLE_PRIVATE_KEY);
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
        'https://www.googleapis.com/auth/drive'
      ]
    });

    const sheets = google.sheets({ version: 'v4', auth });
    const drive = google.drive({ version: 'v3', auth });

    // PASO 4: Verificar trabajador existente (con timeout más largo)
    try {
      const existingCheck = await Promise.race([
        sheets.spreadsheets.values.get({
          spreadsheetId: process.env.GOOGLE_SHEET_ID,
          range: 'Trabajadores!B:C'
        }),
        new Promise((_, reject) => setTimeout(() => reject(new Error('Timeout')), 8000))
      ]);

      const existingRows = existingCheck.data.values || [];
      const existingWorker = existingRows.find(row => row[0] === dni || row[1] === correo);

      if (existingWorker) {
        console.log('❌ Trabajador ya existe:', dni, correo);
        return {
          statusCode: 409,
          headers,
          body: JSON.stringify({ error: 'Ya existe un trabajador con ese DNI o email' })
        };
      }
    } catch (error) {
      console.warn('⚠️ No se pudo verificar trabajador existente, continuando...');
    }

    console.log(`⏱️ Validaciones completadas en ${Date.now() - startTime}ms`);

    // PASO 5: Crear archivos temporales
    const timestamp = Date.now();
    const dniDelantePath = path.join(os.tmpdir(), `dni_delante_${timestamp}.jpg`);
    const dniDetrasPath = path.join(os.tmpdir(), `dni_detras_${timestamp}.jpg`);
    
    try {
      // Si los archivos ya tienen path, usar esos
      if (files.dniDelante.path && fs.existsSync(files.dniDelante.path)) {
        tempFilePaths.push(files.dniDelante.path);
      } else if (files.dniDelante.buffer) {
        fs.writeFileSync(dniDelantePath, files.dniDelante.buffer);
        files.dniDelante.path = dniDelantePath;
        tempFilePaths.push(dniDelantePath);
      }

      if (files.dniDetras.path && fs.existsSync(files.dniDetras.path)) {
        tempFilePaths.push(files.dniDetras.path);
      } else if (files.dniDetras.buffer) {
        fs.writeFileSync(dniDetrasPath, files.dniDetras.buffer);
        files.dniDetras.path = dniDetrasPath;
        tempFilePaths.push(dniDetrasPath);
      }

      console.log('✅ Archivos temporales preparados');
    } catch (fileError) {
      console.error('❌ Error creando archivos temporales:', fileError.message);
      return {
        statusCode: 500,
        headers,
        body: JSON.stringify({ error: 'Error procesando archivos' })
      };
    }

    const dniDelanteFile = {
      path: files.dniDelante.path,
      originalFilename: files.dniDelante.originalFilename,
      headers: files.dniDelante.headers || { 'content-type': 'image/jpeg' }
    };

    const dniDetrasFile = {
      path: files.dniDetras.path,
      originalFilename: files.dniDetras.originalFilename,
      headers: files.dniDetras.headers || { 'content-type': 'image/jpeg' }
    };

    // PASO 6: Obtener info carpeta padre
    const parentFolderInfo = await getFileInfo(drive, process.env.GOOGLE_DRIVE_PARENT_FOLDER_ID);
    if (!parentFolderInfo) {
      console.log('❌ No se pudo acceder a la carpeta padre');
      return {
        statusCode: 500,
        headers,
        body: JSON.stringify({ error: 'No se pudo acceder a la carpeta padre' })
      };
    }

    // PASO 7: Crear carpeta principal
    console.log('📁 Creando carpeta principal...');
    const carpetaResponse = await drive.files.create({
      resource: {
        name: `${nombre} - ${empresa}`,
        mimeType: 'application/vnd.google-apps.folder',
        parents: [process.env.GOOGLE_DRIVE_PARENT_FOLDER_ID]
      },
      fields: 'id',
      supportsAllDrives: true
    });

    const carpetaId = carpetaResponse.data.id;
    const carpetaUrl = `https://drive.google.com/drive/folders/${carpetaId}`;

    console.log(`⏱️ Carpeta principal creada en ${Date.now() - startTime}ms`);

    // PASO 8: Crear subcarpetas básicas (en paralelo)
    const subcarpetas = ['Nóminas', 'Contratos', 'Formación', 'Certificados', 'Pendiente de Firma'];
    
    const [subcarpetasCreadas, dniUrls] = await Promise.all([
      // Crear subcarpetas
      Promise.all(
        subcarpetas.map(subcarpeta => 
          drive.files.create({
            resource: {
              name: subcarpeta,
              mimeType: 'application/vnd.google-apps.folder',
              parents: [carpetaId]
            },
            supportsAllDrives: true
          }).then(res => ({ nombre: subcarpeta, id: res.data.id }))
            .catch(err => ({ nombre: subcarpeta, id: null, error: err.message }))
        )
      ),
      
      // Subir DNIs
      uploadDNIImagesOptimized(drive, carpetaId, dniDelanteFile, dniDetrasFile, parentFolderInfo.driveId)
    ]);

    console.log(`⏱️ Carpetas y DNIs procesados en ${Date.now() - startTime}ms`);

    // PASO 9: Guardar en Google Sheets
    const idInterno = `WRK-${timestamp}`;
    const fechaIncorporacion = new Date().toLocaleDateString('es-ES');
    
    const rowData = [
      nombre, dni, correo, telefono, direccion, empresa, talla, idInterno, carpetaUrl,
      'Activo', fechaIncorporacion, '', '0', '',
      dniUrls.dniDelanteUrl || '', dniUrls.dniDetrasUrl || ''
    ];

    let sheetsSaved = false;
    try {
      await Promise.race([
        sheets.spreadsheets.values.append({
          spreadsheetId: process.env.GOOGLE_SHEET_ID,
          range: 'Trabajadores!A:P',
          valueInputOption: 'USER_ENTERED',
          resource: { values: [rowData] }
        }).then(() => {
          sheetsSaved = true;
          console.log('✅ Datos guardados en Google Sheets');
        }),
        new Promise((_, reject) => setTimeout(() => reject(new Error('Timeout')), 10000))
      ]);
    } catch (error) {
      console.error('❌ Error guardando en Google Sheets:', error.message);
    }

    // CORRECCIÓN PROBLEMA 2: Configurar permisos de forma síncrona
    console.log('🔐 Configurando permisos...');
    const permissionsResult = await grantPermissionsSync(
      drive, 
      carpetaId, 
      subcarpetasCreadas, 
      correo, 
      dniUrls.documentosPersonalesFolderId
    );

    // CORRECCIÓN PROBLEMA 1: Enviar email de forma síncrona
    console.log('📧 Enviando email de confirmación...');
    const emailResult = await sendConfirmationEmailSync(correo, nombre, empresa, carpetaUrl);

    // RESPUESTA AL CLIENTE
    const totalTime = Date.now() - startTime;
    console.log(`🎉 Registro completado en ${totalTime}ms para: ${nombre}`);

    const allSubcarpetas = [...subcarpetasCreadas];
    if (dniUrls.documentosPersonalesFolderId) {
      allSubcarpetas.push({
        nombre: 'Documentos Personales',
        id: dniUrls.documentosPersonalesFolderId,
        created: true
      });
    }

    return {
      statusCode: 200,
      headers,
      body: JSON.stringify({
        message: 'Trabajador registrado exitosamente',
        success: true,
        idInterno,
        carpetaUrl,
        processingTime: totalTime,
        workerAccess: {
          granted: permissionsResult.principal,
          accessLevel: 'reader',
          status: 'completed',
          details: permissionsResult
        },
        emailSent: emailResult.success,
        emailStatus: emailResult.success ? 'sent' : 'failed',
        emailError: emailResult.error || null,
        dniUploaded: {
          delante: !!dniUrls.dniDelanteUrl,
          detras: !!dniUrls.dniDetrasUrl,
          delanteUrl: dniUrls.dniDelanteUrl,
          detrasUrl: dniUrls.dniDetrasUrl,
          carpetaDocumentosPersonales: dniUrls.documentosPersonalesFolderId
        },
        sheetsSaved,
        subcarpetas: allSubcarpetas.map(s => ({
          nombre: s.nombre,
          created: !!s.id,
          id: s.id
        })),
        details: {
          carpetaCreada: true,
          documentosSubidos: {
            total: (dniUrls.dniDelanteUrl ? 1 : 0) + (dniUrls.dniDetrasUrl ? 1 : 0),
            dniDelante: !!dniUrls.dniDelanteUrl,
            dniDetras: !!dniUrls.dniDetrasUrl
          },
          permissions: {
            mainFolder: permissionsResult.principal,
            subfolders: permissionsResult.subcarpetas.length,
            documentsFolder: permissionsResult.documentosPersonales,
            errors: permissionsResult.errors
          },
          email: {
            sent: emailResult.success,
            messageId: emailResult.messageId || null,
            error: emailResult.error || null
          }
        }
      })
    };

  } catch (error) {
    console.error('❌ Error general:', error.message);
    console.error('❌ Stack trace:', error.stack);
    
    return {
      statusCode: 500,
      headers,
      body: JSON.stringify({ 
        error: 'Error interno del servidor',
        details: process.env.NODE_ENV === 'development' ? error.message : 'Error procesando solicitud',
        timestamp: new Date().toISOString(),
        processingTime: Date.now() - startTime
      })
    };
  } finally {
    // Limpiar archivos temporales
    tempFilePaths.forEach(filePath => {
      try {
        if (fs.existsSync(filePath)) {
          fs.unlinkSync(filePath);
          console.log('🧹 Archivo temporal eliminado:', filePath);
        }
      } catch (cleanupError) {
        console.warn(`⚠️ Error limpiando: ${filePath}`);
      }
    });
    
    console.log(`⏱️ Proceso total completado en ${Date.now() - startTime}ms`);
  }
};