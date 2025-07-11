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

// Configurar Nodemailer
let transporter;
try {
  if (process.env.SMTP_HOST && process.env.SMTP_USER && process.env.SMTP_PASS) {
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
      }
    });
  }
} catch (error) {
  console.error('Error configurando Nodemailer:', error);
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

    // PASO 2: Subir archivos DNI EN PARALELO (máximo 2 archivos)
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

    // Esperar subidas con timeout corto
    await Promise.race([
      Promise.all(uploadPromises),
      new Promise(resolve => setTimeout(resolve, 15000)) // 15 segundos máximo
    ]);

    console.log('✅ Proceso de DNIs completado');
    
  } catch (error) {
    console.error('❌ Error en proceso de DNIs:', error.message);
    uploadedFiles.generalError = error.message;
  }
  
  return uploadedFiles;
}

// Función OPTIMIZADA para enviar email (sin bloquear)
function sendConfirmationEmailAsync(correo, nombre, empresa, carpetaUrl = null) {
  // Enviar email en background SIN esperar
  if (transporter) {
    setImmediate(async () => {
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
                  
                  <!-- Features -->
                  <div style="margin: 30px 0;">
                    <h3 style="color: #333; margin-bottom: 20px; font-size: 18px;">🚀 ¿Qué puedes hacer ahora?</h3>
                    <div style="background-color: #f8f9fa; padding: 20px; border-radius: 8px; border-left: 4px solid #667eea;">
                      <ul style="margin: 0; padding-left: 20px; color: #666;">
                        <li style="margin-bottom: 10px; line-height: 1.6;">✅ Acceder a tu carpeta personal desde Google Drive</li>
                        <li style="margin-bottom: 10px; line-height: 1.6;">✅ Ver y descargar tus documentos personales</li>
                        <li style="margin-bottom: 10px; line-height: 1.6;">✅ Consultar nóminas, contratos y certificados</li>
                        <li style="margin-bottom: 10px; line-height: 1.6;">✅ Recibir notificaciones de nuevos archivos</li>
                        <li style="margin-bottom: 0; line-height: 1.6;">✅ Gestionar y revisar tus documentos laborales</li>
                      </ul>
                    </div>
                  </div>
                  
                  <!-- Important Note -->
                  <div style="background-color: #fff3cd; border: 1px solid #ffeaa7; padding: 20px; border-radius: 8px; margin: 30px 0;">
                    <h4 style="color: #856404; margin: 0 0 10px 0; font-size: 16px;">📧 Importante</h4>
                    <p style="color: #856404; margin: 0; font-size: 14px; line-height: 1.5;">
                      Es posible que hayas recibido una notificación de Google Drive sobre el acceso a tu carpeta. 
                      Esto es normal y confirma que ya puedes acceder a tus documentos.
                    </p>
                  </div>
                  
                  <!-- CTA Button -->
                  <div style="text-align: center; margin: 40px 0;">
                    <a href="${process.env.APP_URL || 'https://sistemagestiondocumental.netlify.app/'}" 
                       style="display: inline-block; background: linear-gradient(135deg, #667eea 0%, #764ba2 100%); color: white; padding: 15px 40px; text-decoration: none; border-radius: 50px; font-weight: bold; font-size: 16px; box-shadow: 0 4px 15px rgba(102, 126, 234, 0.3); transition: transform 0.2s;">
                      🔗 Acceder al Sistema
                    </a>
                  </div>
                </div>
                
                <!-- Footer -->
                <div style="background-color: #f8f9fa; padding: 30px; text-align: center; border-top: 1px solid #dee2e6;">
                  <p style="color: #6c757d; font-size: 12px; margin: 0 0 10px 0;">
                    Este email se ha enviado automáticamente desde el Sistema de Gestión Documental.
                  </p>
                  <p style="color: #868e96; font-size: 11px; margin: 0;">
                    Por favor, no respondas a este mensaje. © ${new Date().getFullYear()} Sistema de Gestión Documental.
                  </p>
                </div>
              </div>
            </body>
            </html>
          `,
          text: `
¡Bienvenido al Sistema de Gestión Documental!

Hola ${nombre},

Te confirmamos que tu registro se ha completado exitosamente y ya tienes acceso a tu carpeta personal de documentos.

DATOS DE TU REGISTRO:
• Nombre: ${nombre}
• Empresa: ${empresa}
• Email: ${correo}
• Fecha: ${fechaRegistro}

${carpetaUrl ? `
TU CARPETA PERSONAL:
${carpetaUrl}
` : ''}

¿QUÉ PUEDES HACER AHORA?
✅ Acceder a tu carpeta personal desde Google Drive
✅ Ver y descargar tus documentos personales
✅ Consultar nóminas, contratos y certificados
✅ Recibir notificaciones de nuevos archivos
✅ Gestionar y revisar tus documentos laborales

ACCEDER AL SISTEMA:
${process.env.APP_URL || 'https://sistemagestiondocumental.netlify.app/'}

IMPORTANTE: Es posible que hayas recibido una notificación de Google Drive sobre el acceso a tu carpeta. Esto es normal y confirma que ya puedes acceder a tus documentos.

© ${new Date().getFullYear()} Sistema de Gestión Documental.
          `
        };

        await transporter.sendMail(mailOptions);
        console.log('✅ Email enviado exitosamente a:', correo);
      } catch (error) {
        console.error('❌ Error enviando email:', error.message);
      }
    });
  }
  return { success: true, messageId: 'background' };
}

// Función OPTIMIZADA para permisos (sin bloquear proceso principal)
function grantPermissionsAsync(drive, carpetaId, subcarpetasIds, workerEmail, documentosPersonalesId) {
  // Procesar permisos en background
  setImmediate(async () => {
    try {
      console.log('🔐 Configurando permisos en background...');
      
      const permissionPromises = [];
      
      // Permiso carpeta principal
      permissionPromises.push(
        drive.permissions.create({
          fileId: carpetaId,
          resource: { role: 'reader', type: 'user', emailAddress: workerEmail },
          supportsAllDrives: true,
          sendNotificationEmail: false // Sin notificación para acelerar
        }).catch(err => console.error('Error permiso principal:', err.message))
      );

      // Permisos subcarpetas
      subcarpetasIds.forEach(subcarpeta => {
        if (subcarpeta.id) {
          permissionPromises.push(
            drive.permissions.create({
              fileId: subcarpeta.id,
              resource: { role: 'reader', type: 'user', emailAddress: workerEmail },
              supportsAllDrives: true,
              sendNotificationEmail: false
            }).catch(err => console.error(`Error permiso ${subcarpeta.nombre}:`, err.message))
          );
        }
      });

      // Permiso para Documentos Personales
      if (documentosPersonalesId) {
        permissionPromises.push(
          drive.permissions.create({
            fileId: documentosPersonalesId,
            resource: { role: 'reader', type: 'user', emailAddress: workerEmail },
            supportsAllDrives: true,
            sendNotificationEmail: true // Solo esta notificación
          }).catch(err => console.error('Error permiso Documentos Personales:', err.message))
        );
      }

      // Ejecutar con timeout
      await Promise.race([
        Promise.allSettled(permissionPromises),
        new Promise(resolve => setTimeout(resolve, 10000)) // 10 segundos máximo
      ]);

      console.log('✅ Permisos configurados en background');
      
    } catch (error) {
      console.error('❌ Error configurando permisos:', error.message);
    }
  });
}

// Función para parsear FormData
function parseFormData(event) {
  return new Promise((resolve, reject) => {
    const form = new multiparty.Form();
    
    let bodyBuffer;
    if (event.isBase64Encoded) {
      bodyBuffer = Buffer.from(event.body, 'base64');
    } else {
      bodyBuffer = Buffer.from(event.body);
    }

    const { Readable } = require('stream');
    const bodyStream = new Readable();
    bodyStream.push(bodyBuffer);
    bodyStream.push(null);
    
    bodyStream.headers = event.headers;
    bodyStream.method = 'POST';

    const fields = {};
    const files = {};

    form.on('field', (name, value) => {
      fields[name] = value;
    });

    form.on('part', (part) => {
      if (part.filename) {
        const chunks = [];
        part.on('data', (chunk) => {
          chunks.push(chunk);
        });
        part.on('end', () => {
          files[part.name] = {
            originalFilename: part.filename,
            headers: part.headers,
            buffer: Buffer.concat(chunks)
          };
        });
      }
    });

    form.on('error', reject);
    form.on('close', () => resolve({ fields, files }));
    form.parse(bodyStream);
  });
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

  let tempFilePaths = [];
  const startTime = Date.now();

  try {
    console.log('🚀 INICIO - Proceso optimizado de registro');

    // PASO 1: Parsear datos (RÁPIDO)
    let formData;
    try {
      if (event.headers['content-type'] && event.headers['content-type'].includes('application/json')) {
        const jsonData = JSON.parse(event.body);
        formData = {
          fields: jsonData,
          files: {
            dniDelante: jsonData.dniDelante ? { 
              buffer: Buffer.from(jsonData.dniDelante.split(',')[1], 'base64'), 
              originalFilename: jsonData.dniDelanteNombre 
            } : null,
            dniDetras: jsonData.dniDetras ? { 
              buffer: Buffer.from(jsonData.dniDetras.split(',')[1], 'base64'), 
              originalFilename: jsonData.dniDetrasNombre 
            } : null
          }
        };
      } else {
        formData = await parseFormData(event);
      }
    } catch (parseError) {
      return {
        statusCode: 400,
        headers,
        body: JSON.stringify({ error: 'Error procesando formulario' })
      };
    }

    const { fields, files } = formData;
    const { nombre, dni, correo, telefono, direccion, empresa, talla } = fields;

    // PASO 2: Validaciones (RÁPIDO)
    if (!nombre || !dni || !correo || !telefono || !direccion || !empresa || !talla) {
      return {
        statusCode: 400,
        headers,
        body: JSON.stringify({ error: 'Todos los campos son obligatorios' })
      };
    }

    if (!files.dniDelante || !files.dniDetras) {
      return {
        statusCode: 400,
        headers,
        body: JSON.stringify({ error: 'Debes subir ambas fotos del DNI' })
      };
    }

    const emailRegex = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
    if (!emailRegex.test(correo)) {
      return {
        statusCode: 400,
        headers,
        body: JSON.stringify({ error: 'Email inválido' })
      };
    }

    // PASO 3: Configurar Google (RÁPIDO)
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

    // PASO 4: Verificar trabajador existente (OPTIMIZADO)
    try {
      const existingCheck = await Promise.race([
        sheets.spreadsheets.values.get({
          spreadsheetId: process.env.GOOGLE_SHEET_ID,
          range: 'Trabajadores!B:C'
        }),
        new Promise((_, reject) => setTimeout(() => reject(new Error('Timeout')), 3000))
      ]);

      const existingRows = existingCheck.data.values || [];
      const existingWorker = existingRows.find(row => row[0] === dni || row[1] === correo);

      if (existingWorker) {
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

    // PASO 5: Crear archivos temporales (RÁPIDO)
    const timestamp = Date.now();
    const dniDelantePath = path.join(os.tmpdir(), `dni_delante_${timestamp}.jpg`);
    const dniDetrasPath = path.join(os.tmpdir(), `dni_detras_${timestamp}.jpg`);
    
    fs.writeFileSync(dniDelantePath, files.dniDelante.buffer);
    fs.writeFileSync(dniDetrasPath, files.dniDetras.buffer);
    tempFilePaths = [dniDelantePath, dniDetrasPath];

    const dniDelanteFile = {
      path: dniDelantePath,
      originalFilename: files.dniDelante.originalFilename,
      headers: files.dniDelante.headers || { 'content-type': 'image/jpeg' }
    };

    const dniDetrasFile = {
      path: dniDetrasPath,
      originalFilename: files.dniDetras.originalFilename,
      headers: files.dniDetras.headers || { 'content-type': 'image/jpeg' }
    };

    // PASO 6: Obtener info carpeta padre (RÁPIDO)
    const parentFolderInfo = await getFileInfo(drive, process.env.GOOGLE_DRIVE_PARENT_FOLDER_ID);
    if (!parentFolderInfo) {
      return {
        statusCode: 500,
        headers,
        body: JSON.stringify({ error: 'No se pudo acceder a la carpeta padre' })
      };
    }

    // PASO 7: Crear carpeta principal (CRÍTICO - DEBE COMPLETARSE)
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

    // PASO 8: Crear subcarpetas básicas (OPTIMIZADO - en paralelo)
    const subcarpetas = ['Nóminas', 'Contratos', 'Formación', 'Certificados', 'Pendiente de Firma'];
    
    const [subcarpetasCreadas, dniUrls] = await Promise.all([
      // Crear subcarpetas (máximo 5 en paralelo)
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
      
      // Subir DNIs (OPTIMIZADO)
      uploadDNIImagesOptimized(drive, carpetaId, dniDelanteFile, dniDetrasFile, parentFolderInfo.driveId)
    ]);

    console.log(`⏱️ Carpetas y DNIs procesados en ${Date.now() - startTime}ms`);

    // PASO 9: Guardar en Google Sheets (CRÍTICO - DEBE COMPLETARSE)
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
        new Promise((_, reject) => setTimeout(() => reject(new Error('Timeout')), 5000))
      ]);
    } catch (error) {
      console.error('❌ Error guardando en Google Sheets:', error.message);
    }

    // PASO 10: Procesos en background (NO BLOQUEAN la respuesta)
    sendConfirmationEmailAsync(correo, nombre, empresa, carpetaUrl);
    grantPermissionsAsync(drive, carpetaId, subcarpetasCreadas, correo, dniUrls.documentosPersonalesFolderId);

    // RESPUESTA RÁPIDA AL CLIENTE
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
          granted: true,
          accessLevel: 'reader',
          status: 'processing_background'
        },
        emailSent: true,
        emailStatus: 'processing_background',
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
          }
        }
      })
    };

  } catch (error) {
    console.error('❌ Error general:', error.message);
    return {
      statusCode: 500,
      headers,
      body: JSON.stringify({ 
        error: 'Error interno del servidor',
        details: process.env.NODE_ENV === 'development' ? error.message : undefined
      })
    };
  } finally {
    // Limpiar archivos temporales
    tempFilePaths.forEach(filePath => {
      try {
        if (fs.existsSync(filePath)) {
          fs.unlinkSync(filePath);
        }
      } catch (cleanupError) {
        console.warn(`Error limpiando: ${filePath}`);
      }
    });
  }
};